// Popup side of the worker connection: shows the open thread and the command
// in progress (if any), folds live updates into state, and reconnects if the
// worker restarts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { applyUpdate, PORT_NAME, type PortMessage, type PortRequest, type RunState } from './run';
import type { Thread } from './threads';

export function useRun() {
  const [thread, setThread] = useState<Thread | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const portRef = useRef<Browser.runtime.Port | null>(null);
  // Messages sent while the port is down (the worker was idle-killed and is
  // restarting) wait here and go out as soon as it reconnects.
  const outbox = useRef<PortRequest[]>([]);
  const pendingCommand = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const port = browser.runtime.connect({ name: PORT_NAME });
      portRef.current = port;
      port.onMessage.addListener((msg: PortMessage) => {
        switch (msg.type) {
          case 'state':
            setThread(msg.thread);
            setRun(msg.run);
            if (msg.run?.status === 'running' && msg.run.command === pendingCommand.current) pendingCommand.current = null;
            break;
          case 'update':
            setRun((r) => (r && r.id === msg.runId ? applyUpdate(r, msg.update) : r));
            break;
          case 'needs-unlock':
            setNeedsUnlock(true);
            break;
          case 'error':
            setError(msg.error);
            pendingCommand.current = null;
            break;
        }
      });
      port.onDisconnect.addListener(() => {
        portRef.current = null;
        if (!disposed) retry = setTimeout(connect, 300);
      });
      const queued = outbox.current.splice(0);
      for (const msg of queued) port.postMessage(msg);
    };
    connect();

    return () => {
      disposed = true;
      clearTimeout(retry);
      portRef.current?.disconnect();
    };
  }, []);

  const send = useCallback((msg: PortRequest) => {
    const port = portRef.current;
    if (!port) {
      outbox.current.push(msg);
      return;
    }
    try {
      port.postMessage(msg);
    } catch {
      // Port died before onDisconnect fired; resend after reconnecting.
      outbox.current.push(msg);
    }
  }, []);

  const start = useCallback(
    (command: string) => {
      setError(null);
      pendingCommand.current = command;
      send({ type: 'run', command });
    },
    [send],
  );

  /** Call after a successful unlock to send the command that was waiting. */
  const resumeAfterUnlock = useCallback(() => {
    setNeedsUnlock(false);
    if (pendingCommand.current) send({ type: 'run', command: pendingCommand.current });
  }, [send]);

  const cancelUnlock = useCallback(() => {
    setNeedsUnlock(false);
    pendingCommand.current = null;
  }, []);

  const approve = useCallback(
    (approvalId: string, approved: boolean) => send({ type: 'approve', approvalId, approved }),
    [send],
  );

  const stop = useCallback(() => send({ type: 'stop' }), [send]);
  const openThread = useCallback((threadId: string) => send({ type: 'open-thread', threadId }), [send]);
  const newThread = useCallback(() => send({ type: 'new-thread' }), [send]);
  const deleteThread = useCallback((threadId: string) => send({ type: 'delete-thread', threadId }), [send]);

  return {
    thread,
    run,
    error,
    clearError: () => setError(null),
    needsUnlock,
    start,
    resumeAfterUnlock,
    cancelUnlock,
    approve,
    stop,
    openThread,
    newThread,
    deleteThread,
    running: run?.status === 'running',
  };
}
