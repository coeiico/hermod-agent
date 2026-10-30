// Background service worker: owns the API key, runs commands, and streams
// progress to the popup. The popup is only an interface; it can close at any
// time (moving tabs steals its focus) without stopping a command.
//
// Each thread runs one command at a time; anything sent while it runs waits in
// the thread's queue, or is steered into the running command. Up to
// MAX_RUNNING threads run at once.
import { streamBrowserCommand } from '@/ai/agents/interactive/browser_command/agent';
import { createRunContext, RunCancelled, SteeringInbox, type Limits } from '@/ai/runtime/context';
import { AnthropicModel, createAnthropicClient } from '@/ai/runtime/providers/anthropic';
import { exportChat } from '@/ai/tools/chat-export';
import { plural } from '@/ai/tools/resolve';
import { buildSnapshot, isHermodTab, isPanelTab } from '@/ai/tools/snapshot';
import { CommandQueue } from '@/lib/command-queue';
import * as keystore from '@/lib/keystore';
import type { RpcRequest, RpcResponse } from '@/lib/rpc';
import {
  canResume,
  PORT_NAME,
  type PortMessage,
  type PortRequest,
  type QueuedCommand,
  type RunState,
  type RunUpdate,
  type ThreadActivity,
} from '@/lib/run';
import { RunController } from '@/lib/run-controller';
import { overallActivity, showActivity } from '@/lib/run-indicator';
import { popOut, reattach, watchDetachedWindow } from '@/lib/detached-window';
import { getSettings, onSettingsChanged } from '@/lib/settings';
import type { SlashCommandName } from '@/lib/slash-commands';
import * as threads from '@/lib/threads';
import { WrongPassphraseError } from '@/lib/vault';
import { WebTasks } from '@/lib/web-tasks';

// Commands in progress, so a restarted worker can file them as interrupted.
const CURRENT_RUNS_KEY = 'currentRuns';
const QUEUE_KEY = 'commandQueue';
// More would mostly hit the API key's rate limits.
const MAX_RUNNING = 3;
// The main agent may wait on a web task (up to 20 minutes) and act on steers
// while it does, so it gets more turns and time than a plain tab command needs.
const COMMAND_LIMITS: Partial<Limits> = { maxTurns: 20, runTimeoutMs: 30 * 60_000 };

interface ActiveCommand {
  threadId: string;
  ctrl: RunController;
  abort: AbortController;
  inbox: SteeringInbox;
  /** The user's steers so far, word for word, for web task briefs. */
  steers: string[];
  /** Whether it was waiting on the user at the last check, so the dots change when it does. */
  waiting: boolean;
}

export default defineBackground({
  type: 'module',
  main() {
    const ports = new Set<Browser.runtime.Port>();
    const active = new Map<string, ActiveCommand>();
    // Threads whose next command is being set up, before it shows in `active`.
    const starting = new Set<string>();
    let queue = new CommandQueue();
    // The thread the popup shows and the next command joins. Null: a new thread,
    // created when its first command is sent.
    let openThread: threads.Thread | null = null;
    let keepAlive: ReturnType<typeof setInterval> | undefined;

    void keystore.initKeystore();
    watchDetachedWindow();
    const recovered = recover();

    // ------------------------------------------------------------ persistence

    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    function persistSoon() {
      if (persistTimer) return;
      persistTimer = setTimeout(() => {
        persistTimer = undefined;
        const runs = Object.fromEntries([...active].map(([threadId, cmd]) => [threadId, cmd.ctrl.state]));
        void browser.storage.session.set({ [CURRENT_RUNS_KEY]: runs, [QUEUE_KEY]: queue.toJSON() });
      }, 400);
    }

    /**
     * Reopens the last open thread, files commands the worker died during as
     * interrupted, and restores the queues, held until the user runs them.
     */
    async function recover() {
      const stored = await browser.storage.session.get([CURRENT_RUNS_KEY, QUEUE_KEY]);
      const runs = (stored[CURRENT_RUNS_KEY] as Record<string, RunState> | undefined) ?? {};
      for (const [threadId, run] of Object.entries(runs)) {
        const filed: RunState =
          run.status === 'running'
            ? { ...run, status: 'interrupted', error: 'The background worker restarted before this command finished.', endedAt: Date.now() }
            : run;
        await threads.appendTurn(threadId, filed);
      }
      queue = new CommandQueue((stored[QUEUE_KEY] as Record<string, QueuedCommand[]> | undefined) ?? {});
      queue.pauseAll();
      await browser.storage.session.set({ [CURRENT_RUNS_KEY]: {}, [QUEUE_KEY]: queue.toJSON() });
      const activeId = await threads.getActiveThreadId();
      openThread = activeId ? ((await threads.getThread(activeId)) ?? null) : null;
      await broadcastState();
    }

    // ------------------------------------------------------------ popup port

    function post(port: Browser.runtime.Port, msg: PortMessage) {
      try {
        port.postMessage(msg);
      } catch {
        ports.delete(port);
      }
    }

    function postAll(msg: PortMessage) {
      for (const port of ports) post(port, msg);
    }

    function onUpdate(cmd: ActiveCommand, runId: string, update: RunUpdate) {
      postAll({ type: 'update', runId, update });
      persistSoon();
      // An approval request is registered just after its update goes out, so
      // check for a change in waiting once it has been.
      setTimeout(() => {
        if (cmd.ctrl.waiting === cmd.waiting || !active.has(cmd.threadId)) return;
        cmd.waiting = cmd.ctrl.waiting;
        void broadcastState();
      }, 0);
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
      void recovered.then(async () => {
        // The user is looking at the open thread now.
        if (openThread) await threads.markViewed(openThread.id);
        post(port, await stateMessage());
        void broadcastState();
      });
    });

    /** Every thread that is running or has a result the user hasn't seen. */
    async function activity(): Promise<Record<string, ThreadActivity>> {
      const out: Record<string, ThreadActivity> = {};
      for (const [threadId, cmd] of active) out[threadId] = cmd.ctrl.waiting ? 'waiting' : 'running';
      for (const t of await threads.listThreads()) {
        if (out[t.id] || !t.lastEndedAt || t.lastEndedAt <= (t.lastViewedAt ?? 0) || t.lastStatus === 'stopped') continue;
        out[t.id] = t.lastStatus === 'error' || t.lastStatus === 'interrupted' ? 'failed' : 'done';
      }
      return out;
    }

    async function stateMessage(): Promise<PortMessage> {
      const run = openThread ? (active.get(openThread.id)?.ctrl.state ?? null) : null;
      return { type: 'state', thread: openThread, run, queue: queue.list(openThread?.id), activity: await activity() };
    }

    async function broadcastState() {
      const msg = await stateMessage();
      postAll(msg);
      if (msg.type === 'state') void showActivity(overallActivity(msg.activity));
    }

    async function handlePortRequest(port: Browser.runtime.Port, msg: PortRequest) {
      switch (msg.type) {
        case 'run':
          await enqueue(port, msg.command, false);
          break;
        case 'resume': {
          const last = openThread?.turns.at(-1);
          if (!openThread || !last || !canResume(last) || active.has(openThread.id)) {
            post(port, { type: 'error', error: 'There is no stopped command in this thread to resume.' });
            return;
          }
          await enqueue(port, last.command, true);
          break;
        }
        case 'approve':
          for (const cmd of active.values()) cmd.ctrl.answerApproval(msg.approvalId, msg.approved);
          break;
        case 'stop':
          if (openThread) active.get(openThread.id)?.abort.abort();
          break;
        case 'steer':
          steer(msg.queuedId);
          break;
        case 'unqueue':
          if (openThread) queue.remove(openThread.id, msg.queuedId);
          persistSoon();
          await broadcastState();
          break;
        case 'run-queued':
          if (openThread) queue.unpause(openThread.id, msg.queuedId);
          pump();
          await broadcastState();
          break;
        case 'open-thread':
        case 'new-thread': {
          openThread = msg.type === 'open-thread' ? ((await threads.getThread(msg.threadId)) ?? null) : null;
          await threads.setActiveThreadId(openThread?.id ?? null);
          if (openThread) await threads.markViewed(openThread.id);
          await broadcastState();
          break;
        }
        case 'delete-thread':
          if (active.has(msg.threadId) || starting.has(msg.threadId)) {
            post(port, { type: 'error', error: 'A command is running in that thread. Stop it before deleting the thread.' });
            return;
          }
          queue.deleteThread(msg.threadId);
          await threads.deleteThread(msg.threadId);
          if (openThread?.id === msg.threadId) openThread = null;
          persistSoon();
          await broadcastState();
          break;
      }
    }

    // ------------------------------------------------------------ commands

    /** Queues a command in the open thread (starting the thread if needed), then starts what can start. */
    async function enqueue(port: Browser.runtime.Port, command: string, resumed: boolean) {
      const text = command.trim();
      if (!text) return;
      if (!(await keystore.hasVault())) {
        post(port, { type: 'error', error: 'No API key yet. Open Settings → Manage keys to add one.' });
        return;
      }
      if (!(await keystore.getUnlockedKey())) {
        post(port, { type: 'needs-unlock' });
        return;
      }
      if (!openThread) {
        openThread = await threads.createThread(text);
        await threads.setActiveThreadId(openThread.id);
      }
      queue.add(openThread.id, text, { resume: resumed });
      pump();
      persistSoon();
      await broadcastState();
    }

    /** Sends a queued message into its thread's running command, or runs it next when nothing runs. */
    function steer(queuedId: string) {
      const threadId = openThread?.id;
      if (!threadId) return;
      const cmd = active.get(threadId);
      if (!cmd) {
        queue.unpause(threadId, queuedId);
        pump();
      } else {
        const item = queue.remove(threadId, queuedId);
        if (!item) return;
        cmd.steers.push(item.text);
        cmd.inbox.push({ id: item.id, text: item.text });
        cmd.ctrl.steer(item.id, item.text);
      }
      persistSoon();
      void broadcastState();
    }

    /** Starts every queued command that may start now. */
    function pump() {
      const busy = (threadId: string) => active.has(threadId) || starting.has(threadId);
      const started = queue.takeStartable(busy, MAX_RUNNING - active.size - starting.size);
      for (const { threadId, command } of started) {
        starting.add(threadId);
        void runCommand(threadId, command).finally(() => starting.delete(threadId));
      }
      if (started.length) persistSoon();
    }

    function updateKeepAlive() {
      // Extension API calls reset the service worker's idle timer, so a cheap
      // call every 20s keeps it alive while commands run or wait on the user.
      if (active.size && !keepAlive) keepAlive = setInterval(() => void browser.runtime.getPlatformInfo(), 20_000);
      if (!active.size && keepAlive) {
        clearInterval(keepAlive);
        keepAlive = undefined;
      }
    }

    async function runCommand(threadId: string, queued: QueuedCommand) {
      const thread = await threads.getThread(threadId);
      if (!thread) return;
      const apiKey = await keystore.getUnlockedKey();
      if (!apiKey) {
        // Locked since it was queued: hold it until the user unlocks and runs it.
        queue.add(threadId, queued.text, { id: queued.id, resume: queued.resume, front: true, paused: true });
        postAll({ type: 'needs-unlock' });
        persistSoon();
        await broadcastState();
        return;
      }
      const settings = await getSettings();
      const abort = new AbortController();
      const inbox = new SteeringInbox();
      const cmd: ActiveCommand = { threadId, abort, inbox, steers: [], waiting: false, ctrl: undefined as unknown as RunController };
      cmd.ctrl = new RunController(queued.text, settings.model, !!queued.resume, (runId, update) => onUpdate(cmd, runId, update));
      active.set(threadId, cmd);
      starting.delete(threadId);
      updateKeepAlive();
      await broadcastState();

      // The mode applies live: switching it mid-command changes what the next action asks.
      let approvalMode = settings.approvalMode;
      const stopFollowingMode = onSettingsChanged((s) => (approvalMode = s.approvalMode));
      const model = new AnthropicModel(createAnthropicClient(apiKey));
      const tasks = new WebTasks({
        cancel: abort.signal,
        ctrl: cmd.ctrl,
        command: queued.text,
        steering: () => cmd.steers,
        approval: () => approvalMode,
        model,
        cacheTtl: settings.cacheTtl,
      });
      try {
        const ctx = createRunContext({
          cancel: abort.signal,
          approval: () => approvalMode,
          confirm: (request) => cmd.ctrl.requestApproval(request.callId, request.question, request.signal),
          limits: COMMAND_LIMITS,
          steering: inbox,
          children: tasks,
        });
        const snapshot = await buildSnapshot();
        cmd.ctrl.snapshot(snapshot);
        const earlierTurns = thread.turns.map(threads.toEarlierTurn);
        const events = streamBrowserCommand(ctx, { snapshot: snapshot.text, command: queued.text, resumed: !!queued.resume, earlierTurns }, {
          model,
          overrides: { model: settings.model, effort: settings.effort, cache_ttl: settings.cacheTtl },
        });
        for await (const event of events) cmd.ctrl.handle(event);
      } catch (err) {
        if (err instanceof RunCancelled || abort.signal.aborted) {
          cmd.ctrl.failDanglingTools('stopped by the user');
          cmd.ctrl.end('stopped', { summary: 'Stopped.' });
        } else {
          console.error('[hermod] command failed', err instanceof Error ? err.message : err);
          cmd.ctrl.failDanglingTools('the command failed');
          cmd.ctrl.end('error', { error: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        stopFollowingMode();
        // A web task the command didn't wait for ends with it.
        await tasks.stopAll();
        // Steers that arrived too late to be read run as the thread's next commands.
        const late = inbox.take();
        cmd.ctrl.setSteerState(late.map((m) => m.id), 'queued');
        for (const message of late.reverse()) queue.add(threadId, message.text, { front: true });
        if (!cmd.ctrl.finished) cmd.ctrl.end('done', { summary: 'Done.' });
        // After a stop, what was queued behind it waits for the user to run it.
        if (cmd.ctrl.state.status === 'stopped') queue.pauseThread(threadId);
        const updated = await threads.appendTurn(threadId, cmd.ctrl.state);
        if (openThread?.id === threadId) {
          openThread = updated ?? null;
          // Finished in front of the user: nothing unread.
          if (ports.size) await threads.markViewed(threadId);
        }
        active.delete(threadId);
        updateKeepAlive();
        persistSoon();
        pump();
        await broadcastState();
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
        case 'clear-threads': {
          const startOfToday = new Date().setHours(0, 0, 0, 0);
          const busy = (id: string) => active.has(id) || starting.has(id);
          const wanted = (t: threads.ThreadSummary) => msg.which === 'all' || t.createdAt < startOfToday;
          const keptRunning = (await threads.listThreads()).filter((t) => wanted(t) && busy(t.id)).length;
          const cleared = await threads.clearThreads((t) => !wanted(t) || busy(t.id));
          for (const id of cleared) queue.deleteThread(id);
          if (openThread && cleared.includes(openThread.id)) openThread = null;
          persistSoon();
          await broadcastState();
          return { ok: true, cleared: cleared.length, keptRunning };
        }
        case 'pop-out':
          await popOut();
          return { ok: true };
        case 'reattach':
          await reattach();
          return { ok: true };
        case 'slash-command':
          return runSlashCommand(msg.name);
      }
    }

    // ------------------------------------------------------------ slash commands

    async function runSlashCommand(name: SlashCommandName): Promise<RpcResponse> {
      // The tab the user is looking at, by the snapshot's rules: never Hermod itself or a Vivaldi web panel.
      const window = await browser.windows.getLastFocused({ windowTypes: ['normal'], populate: true }).catch(() => undefined);
      const tab = window?.tabs?.find((t) => t.active && !isHermodTab(t) && !isPanelTab(t));
      if (!tab?.id) return { ok: false, error: 'No browser tab is in front to run the command on.' };
      switch (name) {
        case 'export_chat_to_markdown': {
          const saved = await exportChat(tab.id);
          return { ok: true, message: `Saved "${saved.title}" (${plural(saved.messages, 'message')}) to downloads as ${saved.filename}.` };
        }
      }
    }
  },
});
