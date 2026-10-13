import { ActivityDot } from '@/components/hermod/activity-dot';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { relativeTime } from '@/ai/tools/snapshot';
import { rpc } from '@/lib/rpc';
import type { ThreadActivity } from '@/lib/run';
import type { ThreadSummary } from '@/lib/threads';
import { cn } from '@/lib/utils';
import { AlertCircleIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Every saved thread, newest first: open one, start a new one, or delete one.
 * A dot shows threads that are working or have news. A running thread can't
 * be deleted.
 */
export function ThreadList({
  activeId,
  activity,
  onOpen,
  onNew,
  onDelete,
}: {
  activeId: string | null;
  /** Every thread that is running or has news, by ID. */
  activity: Record<string, ThreadActivity>;
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
  const activityKey = JSON.stringify(activity);
  useEffect(() => {
    void load();
  }, [activityKey]);

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
      <Button size="sm" variant="outline" className="w-full" onClick={onNew}>
        <PlusIcon /> New thread
      </Button>
      {!threads.length && <p className="p-6 text-center text-ink-3">No threads yet. Your first command starts one.</p>}
      <ul className="flex flex-col">
        {threads.map((t) => (
          <li key={t.id} className="group relative border-line border-b last:border-b-0">
            <button
              type="button"
              onClick={() => onOpen(t.id)}
              className={cn(
                'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-[8px] px-2 py-2 text-left group-hover:bg-surface-alt',
                t.id === activeId && 'bg-surface-alt',
              )}
            >
              {/* The dot sits in line with the title and moves only the title; the line below stays put. */}
              <span className="flex w-full items-center gap-1.5">
                <ActivityDot activity={activity[t.id]} />
                <span className="min-w-0 truncate text-ink text-sm">{t.title}</span>
              </span>
              <span className="text-ink-3 text-xs tabular-nums">
                {t.turnCount} command{t.turnCount === 1 ? '' : 's'} · {relativeTime(t.updatedAt)}
                {activity[t.id] === 'running' ? ' · working' : activity[t.id] === 'waiting' ? ' · waiting for you' : ''}
                {t.id === activeId ? ' · open' : ''}
              </span>
            </button>
            {/* Floats over the row's right end, shown on hover or keyboard focus; a running thread can't be deleted. */}
            {activity[t.id] !== 'running' && activity[t.id] !== 'waiting' && (
              <Button
                size={armed === t.id ? 'sm' : 'icon-sm'}
                variant="ghost"
                aria-label={armed === t.id ? 'Confirm delete' : `Delete thread "${t.title}"`}
                className={cn(
                  '-translate-y-1/2 absolute top-1/2 right-1.5 bg-surface-alt text-ink-3 opacity-0 hover:bg-line hover:text-ink focus-visible:opacity-100 group-hover:opacity-100',
                  armed === t.id && 'text-bad-ink opacity-100 hover:text-bad-ink',
                )}
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
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
