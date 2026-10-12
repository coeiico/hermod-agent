// Background service worker: owns the API key, runs the tool loop, and
// streams progress to the popup. The popup is only an interface; it can close
// at any time (moving tabs steals its focus) without stopping a command.
import { createClient, runAgent, StopRun } from '@/lib/agent';
import * as keystore from '@/lib/keystore';
import type { RpcRequest, RpcResponse } from '@/lib/rpc';
import { PORT_NAME, toRecord, type PortMessage, type PortRequest, type RunEvent, type RunRecord, type RunState } from '@/lib/run';
import { RunController } from '@/lib/run-controller';
import { getSettings } from '@/lib/settings';
import { WrongPassphraseError } from '@/lib/vault';

const CURRENT_RUN_KEY = 'currentRun';
const HISTORY_KEY = 'runHistory';
const HISTORY_LIMIT = 25;

export default defineBackground({
  type: 'module',
  main() {
    const ports = new Set<Browser.runtime.Port>();
    let active: { ctrl: RunController; abort: AbortController } | null = null;
    let lastRun: RunState | null = null;

    void keystore.initKeystore();
    const recovered = recoverInterruptedRun();

    // ------------------------------------------------------------ persistence

    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    function persistSoon() {
      if (persistTimer) return;
      persistTimer = setTimeout(() => {
        persistTimer = undefined;
        const run = active?.ctrl.state ?? lastRun;
        if (run) void browser.storage.session.set({ [CURRENT_RUN_KEY]: run });
      }, 400);
    }

    async function getHistory(): Promise<RunRecord[]> {
      const stored = await browser.storage.session.get(HISTORY_KEY);
      return (stored[HISTORY_KEY] as RunRecord[] | undefined) ?? [];
    }

    async function pushHistory(run: RunState) {
      const history = (await getHistory()).filter((r) => r.id !== run.id);
      history.unshift(toRecord(run));
      await browser.storage.session.set({ [HISTORY_KEY]: history.slice(0, HISTORY_LIMIT) });
    }

    /** If the worker was killed mid-command, show that run as interrupted. */
    async function recoverInterruptedRun() {
      const stored = await browser.storage.session.get(CURRENT_RUN_KEY);
      const run = stored[CURRENT_RUN_KEY] as RunState | undefined;
      if (!run) return;
      if (run.status === 'running') {
        const fixed: RunState = { ...run, status: 'interrupted', error: 'The background worker restarted before this command finished.', endedAt: Date.now() };
        await browser.storage.session.set({ [CURRENT_RUN_KEY]: fixed });
        await pushHistory(fixed);
        lastRun = fixed;
      } else {
        lastRun = run;
      }
    }

    // ------------------------------------------------------------ popup port

    function post(port: Browser.runtime.Port, msg: PortMessage) {
      try {
        port.postMessage(msg);
      } catch {
        ports.delete(port);
      }
    }

    function broadcast(runId: string, event: RunEvent) {
      for (const port of ports) post(port, { type: 'event', runId, event });
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
      void recovered.then(() => post(port, { type: 'state', run: active?.ctrl.state ?? lastRun }));
    });

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
      const ctrl = new RunController(text, settings.model, broadcast);
      const abort = new AbortController();
      active = { ctrl, abort };
      for (const p of ports) post(p, { type: 'state', run: ctrl.state });

      // Extension API calls reset the service worker's idle timer, so a cheap
      // call every 20s keeps it alive while waiting on the user (confirmations).
      const keepAlive = setInterval(() => void browser.runtime.getPlatformInfo(), 20_000);
      try {
        await runAgent({
          apiKey,
          command: text,
          model: settings.model,
          effort: settings.effort,
          cacheTtl: settings.cacheTtl,
          ctrl,
          signal: abort.signal,
        });
      } catch (err) {
        if (err instanceof StopRun || abort.signal.aborted) {
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
        lastRun = ctrl.state;
        active = null;
        await browser.storage.session.set({ [CURRENT_RUN_KEY]: lastRun });
        await pushHistory(lastRun);
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
            const page = await createClient(apiKey).models.list({ limit: 20 });
            return { ok: true, models: page.data.map((m) => m.id) };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        case 'history':
          return { ok: true, history: await getHistory() };
        case 'clear-history':
          await browser.storage.session.remove([HISTORY_KEY, CURRENT_RUN_KEY]);
          lastRun = null;
          return { ok: true };
      }
    }
  },
});
