// Background service worker: owns the API key, runs the tool loop, and
// streams progress to the popup. The popup is only an interface; it can close
// at any time (moving tabs steals its focus) without stopping a command.
import { streamBrowserCommand } from '@/ai/agents/interactive/browser_command/agent';
import { createRunContext, RunCancelled } from '@/ai/runtime/context';
import { AnthropicModel, createAnthropicClient } from '@/ai/runtime/providers/anthropic';
import { buildSnapshot } from '@/ai/tools/snapshot';
import * as keystore from '@/lib/keystore';
import type { RpcRequest, RpcResponse } from '@/lib/rpc';
import { PORT_NAME, type PortMessage, type PortRequest, type RunState, type RunUpdate } from '@/lib/run';
import { RunController } from '@/lib/run-controller';
import { popOut, reattach, watchDetachedWindow } from '@/lib/detached-window';
import { getSettings } from '@/lib/settings';
import * as threads from '@/lib/threads';
import { WrongPassphraseError } from '@/lib/vault';

// The command in progress, so a restarted worker can file it as interrupted.
const CURRENT_RUN_KEY = 'currentRun';

interface CurrentRun {
  threadId: string;
  run: RunState;
}

export default defineBackground({
  type: 'module',
  main() {
    const ports = new Set<Browser.runtime.Port>();
    let active: { ctrl: RunController; abort: AbortController; threadId: string } | null = null;
    // The thread the popup shows and the next command joins. Null: a new thread,
    // created when its first command starts.
    let openThread: threads.Thread | null = null;

    void keystore.initKeystore();
    watchDetachedWindow();
    const recovered = recover();

    // ------------------------------------------------------------ persistence

    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    function persistSoon() {
      if (persistTimer) return;
      persistTimer = setTimeout(() => {
        persistTimer = undefined;
        if (active) {
          const current: CurrentRun = { threadId: active.threadId, run: active.ctrl.state };
          void browser.storage.session.set({ [CURRENT_RUN_KEY]: current });
        }
      }, 400);
    }

    /** Reopens the last open thread, and files a command the worker died during as interrupted. */
    async function recover() {
      const stored = await browser.storage.session.get(CURRENT_RUN_KEY);
      const current = stored[CURRENT_RUN_KEY] as CurrentRun | undefined;
      if (current) {
        const run: RunState =
          current.run.status === 'running'
            ? { ...current.run, status: 'interrupted', error: 'The background worker restarted before this command finished.', endedAt: Date.now() }
            : current.run;
        await threads.appendTurn(current.threadId, run);
        await browser.storage.session.remove(CURRENT_RUN_KEY);
      }
      const activeId = await threads.getActiveThreadId();
      openThread = activeId ? ((await threads.getThread(activeId)) ?? null) : null;
    }

    // ------------------------------------------------------------ popup port

    function post(port: Browser.runtime.Port, msg: PortMessage) {
      try {
        port.postMessage(msg);
      } catch {
        ports.delete(port);
      }
    }

    function broadcast(runId: string, update: RunUpdate) {
      for (const port of ports) post(port, { type: 'update', runId, update });
      persistSoon();
    }

    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== PORT_NAME) return;
      ports.add(port);
      port.onDisconnect.addListener(() => ports.delete(port));
      // Register the message listener synchronously so nothing sent right
      // after connecting is lost; handle messages once recovery is done.
      port.onMessage.addListener((msg: PortRequest) => {
        void recovered.then(() => handlePortRequest(port, msg));
      });
      void recovered.then(() => post(port, stateMessage()));
    });

    function stateMessage(): PortMessage {
      return { type: 'state', thread: openThread, run: active?.ctrl.state ?? null };
    }

    function broadcastState() {
      for (const port of ports) post(port, stateMessage());
    }

    async function handlePortRequest(port: Browser.runtime.Port, msg: PortRequest) {
      switch (msg.type) {
        case 'run':
          await startRun(port, msg.command);
          break;
        case 'approve':
          active?.ctrl.answerApproval(msg.approvalId, msg.approved);
          break;
        case 'stop':
          active?.abort.abort();
          break;
        case 'open-thread':
        case 'new-thread': {
          if (active) {
            post(port, { type: 'error', error: 'Wait for the current command to finish, or stop it, before switching threads.' });
            return;
          }
          openThread = msg.type === 'open-thread' ? ((await threads.getThread(msg.threadId)) ?? null) : null;
          await threads.setActiveThreadId(openThread?.id ?? null);
          broadcastState();
          break;
        }
        case 'delete-thread':
          if (active?.threadId === msg.threadId) {
            post(port, { type: 'error', error: "A command is running in that thread. Stop it before deleting the thread." });
            return;
          }
          await threads.deleteThread(msg.threadId);
          if (openThread?.id === msg.threadId) openThread = null;
          broadcastState();
          break;
      }
    }

    async function startRun(port: Browser.runtime.Port, command: string) {
      const text = command.trim();
      if (!text) return;
      if (active) {
        post(port, { type: 'error', error: 'A command is already running. Stop it first.' });
        return;
      }
      if (!(await keystore.hasVault())) {
        post(port, { type: 'error', error: 'No API key yet. Open Settings → Manage keys to add one.' });
        return;
      }
      const apiKey = await keystore.getUnlockedKey();
      if (!apiKey) {
        post(port, { type: 'needs-unlock' });
        return;
      }

      const settings = await getSettings();
      const thread = openThread ?? (await threads.createThread(text));
      if (!openThread) {
        openThread = thread;
        await threads.setActiveThreadId(thread.id);
      }
      const ctrl = new RunController(text, settings.model, broadcast);
      const abort = new AbortController();
      active = { ctrl, abort, threadId: thread.id };
      broadcastState();

      // Extension API calls reset the service worker's idle timer, so a cheap
      // call every 20s keeps it alive while waiting on the user (confirmations).
      const keepAlive = setInterval(() => void browser.runtime.getPlatformInfo(), 20_000);
      try {
        const ctx = createRunContext({
          cancel: abort.signal,
          approval: settings.approvalMode,
          confirm: (request) => ctrl.requestApproval(request.callId, request.question, request.signal),
        });
        const snapshot = await buildSnapshot();
        ctrl.snapshot(snapshot);
        const earlierTurns = thread.turns.map(threads.toEarlierTurn);
        const events = streamBrowserCommand(ctx, { snapshot: snapshot.text, command: text, earlierTurns }, {
          model: new AnthropicModel(createAnthropicClient(apiKey)),
          overrides: { model: settings.model, effort: settings.effort, cache_ttl: settings.cacheTtl },
        });
        for await (const event of events) ctrl.handle(event);
      } catch (err) {
        if (err instanceof RunCancelled || abort.signal.aborted) {
          ctrl.failDanglingTools('Stopped by the user.');
          ctrl.end('stopped', { summary: 'Stopped.' });
        } else {
          console.error('[hermod] command failed', err instanceof Error ? err.message : err);
          ctrl.failDanglingTools('Not run: the command failed.');
          ctrl.end('error', { error: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        clearInterval(keepAlive);
        if (!ctrl.finished) ctrl.end('done', { summary: 'Done.' });
        const updated = await threads.appendTurn(thread.id, ctrl.state);
        if (openThread?.id === thread.id) openThread = updated ?? null;
        active = null;
        await browser.storage.session.remove(CURRENT_RUN_KEY);
        broadcastState();
      }
    }

    // ------------------------------------------------------------ RPC

    browser.runtime.onMessage.addListener((msg: RpcRequest, _sender, sendResponse) => {
      handleRpc(msg).then(sendResponse, (err: unknown) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      return true; // async response
    });

    async function handleRpc(msg: RpcRequest): Promise<RpcResponse> {
      switch (msg.type) {
        case 'status': {
          const settings = await getSettings();
          return {
            ok: true,
            hasVault: await keystore.hasVault(),
            unlocked: (await keystore.getUnlockedKey()) !== undefined,
            usesDefaultPassphrase: settings.usesDefaultPassphrase,
          };
        }
        case 'unlock':
          try {
            await keystore.unlock(msg.passphrase);
            return { ok: true };
          } catch (err) {
            if (err instanceof WrongPassphraseError) return { ok: false, error: 'Wrong passphrase' };
            throw err;
          }
        case 'lock':
          await keystore.lock();
          return { ok: true };
        case 'save-key':
          await keystore.saveKey(msg.apiKey, msg.passphrase);
          return { ok: true };
        case 'change-passphrase':
          try {
            await keystore.changePassphrase(msg.oldPassphrase, msg.newPassphrase);
            return { ok: true };
          } catch (err) {
            if (err instanceof WrongPassphraseError) return { ok: false, error: 'Wrong passphrase' };
            throw err;
          }
        case 'remove-key':
          await keystore.removeKey();
          return { ok: true };
        case 'test-key': {
          let apiKey = await keystore.getUnlockedKey();
          if (!apiKey) {
            if (!msg.passphrase) return { ok: false, error: 'Locked. Enter your passphrase to test the key.' };
            try {
              apiKey = await keystore.decryptWith(msg.passphrase);
            } catch (err) {
              if (err instanceof WrongPassphraseError) return { ok: false, error: 'Wrong passphrase' };
              throw err;
            }
          }
          try {
            const page = await createAnthropicClient(apiKey).models.list({ limit: 20 });
            return { ok: true, models: page.data.map((m) => m.id) };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        case 'list-threads':
          return { ok: true, threads: await threads.listThreads() };
        case 'pop-out':
          await popOut();
          return { ok: true };
        case 'reattach':
          await reattach();
          return { ok: true };
      }
    }
  },
});
