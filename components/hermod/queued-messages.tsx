import { Message, MessageContent } from '@/components/ai-elements/message';
import { Button } from '@/components/ui/button';
import type { QueuedCommand } from '@/lib/run';
import { NavigationIcon, PlayIcon, XIcon } from 'lucide-react';

function status(command: QueuedCommand, index: number, running: boolean): string {
  if (command.paused) return 'Held. Run it when you are ready.';
  if (running || index > 0) return 'Queued. It runs when the command before it finishes.';
  return 'Waiting for another thread to finish (three run at once).';
}

/**
 * Messages sent to the thread while its command runs. Each waits its turn, or
 * Steer sends it into the running command at once.
 */
export function QueuedMessages({
  queue,
  running,
  onSteer,
  onRun,
  onRemove,
}: {
  queue: QueuedCommand[];
  /** The thread's command is running, so a message can be steered into it. */
  running: boolean;
  onSteer: (id: string) => void;
  onRun: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (!queue.length) return null;
  return (
    <div className="flex flex-col gap-3">
      {queue.map((command, i) => (
        <div key={command.id} className="flex flex-col items-end gap-1">
          <Message from="user" className="ml-auto opacity-70">
            <MessageContent className="px-3 py-2">
              {command.resume && <span className="block text-ink-3 text-xs">Resume</span>}
              {command.text}
            </MessageContent>
          </Message>
          <div className="flex items-center gap-1">
            <span className="text-ink-3 text-xs">{status(command, i, running)}</span>
            {running && !command.resume && (
              <Button size="sm" variant="outline" onClick={() => onSteer(command.id)}>
                <NavigationIcon /> Steer
              </Button>
            )}
            {command.paused && (
              <Button size="sm" variant="outline" onClick={() => onRun(command.id)}>
                <PlayIcon /> Run
              </Button>
            )}
            <Button size="icon-sm" variant="ghost" className="text-ink-3 hover:text-ink" aria-label="Remove from the queue" onClick={() => onRemove(command.id)}>
              <XIcon />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
