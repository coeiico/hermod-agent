import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { relativeTime } from '@/ai/tools/snapshot';
import { rpc } from '@/lib/rpc';
import type { ThreadSummary } from '@/lib/threads';
import { cn } from '@/lib/utils';
import { AlertCircleIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Every saved thread, newest first: open one, start a new one, or delete one.
 * Threads can be opened while a command runs; the running thread can't be deleted.
 */
export function ThreadList({
  activeId,
  runningId,
  onOpen,
  onNew,
  onDelete,
}: {
  activeId: string | null;
  /** The thread whose command is running, if any. */
  runningId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Deleting takes two clicks: the first arms the row's button.
  const [armed, setArmed] = useState<string | null>(null);

  const load = async () => {
    setLoadError(null);
    try {
      const res = await rpc({ type: 'list-threads' });
      if (!res.ok) throw new Error(res.error);
      setThreads(res.threads ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  // Reloads when a command starts or finishes, so counts and order stay current.
  useEffect(() => {
    void load();
  }, [runningId]);

  if (loadError) {
    return (
      <div className="p-3">
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>Couldn't load your threads: {loadError}</span>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!threads) return null;

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-ink-3 text-xs">Threads are saved in this browser. Claude sees the earlier commands of the thread you're in.</p>
        <Button size="sm" variant="outline" onClick={onNew}>
          <PlusIcon /> New thread
        </Button>
      </div>
      {!threads.length && <p className="p-6 text-center text-ink-3">No threads yet. Your first command starts one.</p>}
      <ul className="flex flex-col">
        {threads.map((t) => (
          <li key={t.id} className="group flex items-center gap-1 border-line border-b last:border-b-0">
            <button
              type="button"
              onClick={() => onOpen(t.id)}
              className={cn(
                'flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-[8px] px-2 py-2 text-left hover:bg-surface-alt',
                t.id === activeId && 'bg-surface-alt',
              )}
            >
              <span className="w-full truncate text-ink text-sm">{t.title}</span>
              <span className="text-ink-3 text-xs tabular-nums">
                {t.turnCount} command{t.turnCount === 1 ? '' : 's'} · {relativeTime(t.updatedAt)}
                {t.id === runningId ? ' · running' : ''}
                {t.id === activeId ? ' · open' : ''}
              </span>
            </button>
            <Button
              size={armed === t.id ? 'sm' : 'icon-sm'}
              variant="ghost"
              aria-label={armed === t.id ? 'Confirm delete' : `Delete thread "${t.title}"`}
              className={cn('text-ink-3 hover:text-ink', armed === t.id && 'text-bad-ink hover:text-bad-ink')}
              disabled={t.id === runningId}
              onBlur={() => setArmed(null)}
              onClick={() => {
                if (armed !== t.id) return setArmed(t.id);
                setArmed(null);
                onDelete(t.id);
                setThreads((list) => list?.filter((x) => x.id !== t.id) ?? null);
              }}
            >
              {armed === t.id ? 'Delete?' : <Trash2Icon />}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
