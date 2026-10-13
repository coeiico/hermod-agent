import type { ThreadActivity } from '@/lib/run';
import { cn } from '@/lib/utils';

const STYLE: Record<ThreadActivity, { className: string; label: string }> = {
  running: { className: 'animate-pulse bg-clay', label: 'Working' },
  waiting: { className: 'animate-pulse bg-amber', label: 'Waiting for you' },
  done: { className: 'bg-sage', label: 'Finished, not yet seen' },
  failed: { className: 'bg-bad', label: 'Failed, not yet seen' },
};

/** A thread's state as a small dot: pulsing while an agent works, solid when there's a result to see. */
export function ActivityDot({ activity, className }: { activity: ThreadActivity | undefined; className?: string }) {
  if (!activity) return null;
  const { className: tone, label } = STYLE[activity];
  return <span role="img" aria-label={label} title={label} className={cn('inline-block size-2 shrink-0 rounded-full', tone, className)} />;
}
