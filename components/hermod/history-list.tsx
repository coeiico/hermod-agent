import { Task, TaskContent, TaskItem, TaskTrigger } from '@/components/ai-elements/task';
import { Button } from '@/components/ui/button';
import { getModel } from '@/lib/models';
import { rpc } from '@/lib/rpc';
import type { RunRecord } from '@/lib/run';
import { relativeTime } from '@/lib/snapshot';
import { useEffect, useState } from 'react';

const STATUS_LABEL: Record<RunRecord['status'], string> = {
  running: 'running',
  done: 'done',
  error: 'failed',
  stopped: 'stopped',
  interrupted: 'interrupted',
};

/** Earlier commands in this browser session. For reference only; never sent to Claude. */
export function HistoryList() {
  const [history, setHistory] = useState<RunRecord[] | null>(null);

  const load = async () => {
    const res = await rpc({ type: 'history' });
    setHistory(res.ok ? (res.history ?? []) : []);
  };

  useEffect(() => {
    void load();
  }, []);

  if (!history) return null;
  if (!history.length) {
    return <p className="p-6 text-center text-muted-foreground text-sm">No commands yet in this browser session.</p>;
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          Earlier commands this session. Shown for reference; Claude never sees them.
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={async () => {
            await rpc({ type: 'clear-history' });
            await load();
          }}
        >
          Clear
        </Button>
      </div>
      {history.map((r) => (
        <Task key={r.id} defaultOpen={false}>
          <TaskTrigger title={r.command} />
          <TaskContent>
            <TaskItem>{r.error ?? r.summary ?? '—'}</TaskItem>
            <TaskItem className="text-xs">
              {STATUS_LABEL[r.status]} · {relativeTime(r.startedAt)} · {getModel(r.model).name} · {r.toolCalls} tool call
              {r.toolCalls === 1 ? '' : 's'} · ${r.usage.costUSD.toFixed(4)}
            </TaskItem>
          </TaskContent>
        </Task>
      ))}
    </div>
  );
}
