import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from '@/components/ai-elements/chain-of-thought';
import { CodeBlock } from '@/components/ai-elements/code-block';
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { getModel } from '@/ai/models';
import { steerOf, type RunState, type SteerData } from '@/lib/run';
import { cn } from '@/lib/utils';
import type { DynamicToolUIPart, UIMessage } from 'ai';
import type { BundledLanguage } from 'shiki';
import {
  AlertCircleIcon,
  CameraIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleStopIcon,
  GlobeIcon,
  MonitorIcon,
  PlayIcon,
  XIcon,
} from 'lucide-react';
import { useState } from 'react';

function thinkingMessage(isStreaming: boolean, duration?: number) {
  if (isStreaming || duration === 0) return <Shimmer duration={1}>Thinking…</Shimmer>;
  if (duration === undefined) return <p>Thought for a moment</p>;
  return <p>Thought for {duration} second{duration === 1 ? '' : 's'}</p>;
}

function formatDuration(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

function ToolCall({ part, onApprove }: { part: DynamicToolUIPart; onApprove: (approvalId: string, approved: boolean) => void }) {
  const awaiting = part.state === 'approval-requested';
  return (
    <div className="mb-3 flex flex-col gap-2">
      <Tool className="mb-0" defaultOpen={part.state === 'output-error'}>
        <ToolHeader type="dynamic-tool" toolName={part.toolName} title={part.title} state={part.state} className="p-2.5" />
        <ToolContent className="space-y-3 p-3">
          <ToolInput input={part.input ?? (part.state === 'input-streaming' ? part.rawInput : undefined)} />
          <ToolOutput output={part.output} errorText={part.errorText} />
        </ToolContent>
      </Tool>
      <Confirmation approval={part.approval} state={part.state} className={awaiting ? 'border-amber/60' : undefined}>
        <ConfirmationTitle>
          <ConfirmationRequest>{part.approval?.requestReason ?? 'Allow this action?'}</ConfirmationRequest>
          <ConfirmationAccepted>
            <span className="inline-flex items-center gap-1.5">
              <CheckIcon className="size-3.5 text-sage" /> Approved
            </span>
          </ConfirmationAccepted>
          <ConfirmationRejected>
            <span className="inline-flex items-center gap-1.5">
              <XIcon className="size-3.5 text-amber" /> Declined. Nothing was changed.
            </span>
          </ConfirmationRejected>
        </ConfirmationTitle>
        <ConfirmationActions>
          <ConfirmationAction variant="outline" onClick={() => part.approval && onApprove(part.approval.id, false)}>
            No
          </ConfirmationAction>
          <ConfirmationAction onClick={() => part.approval && onApprove(part.approval.id, true)}>
            Yes
          </ConfirmationAction>
        </ConfirmationActions>
      </Confirmation>
    </div>
  );
}

const STEER_STATE: Record<SteerData['state'], string> = {
  sent: 'Sent. Hermod reads it at its next step.',
  read: 'Read.',
  queued: 'Arrived as the command finished, so it runs next.',
};

function SteerMessage({ steer }: { steer: SteerData }) {
  return (
    <div className="mb-3 flex flex-col items-end gap-1">
      <Message from="user" className="ml-auto">
        <MessageContent>
          <span className="block text-ink-3 text-xs">Steer</span>
          {steer.text}
        </MessageContent>
      </Message>
      <span className="text-ink-3 text-xs">{STEER_STATE[steer.state]}</span>
    </div>
  );
}

/** Whether a run, or a web task inside it, is waiting on an approval. */
function awaitingApproval(run: RunState): boolean {
  const parts = run.messages[1]?.parts ?? [];
  return parts.some((p) => p.type === 'dynamic-tool' && p.state === 'approval-requested') || Object.values(run.tasks ?? {}).some(awaitingApproval);
}

function taskStatus(task: RunState): string {
  if (task.status === 'running') return awaitingApproval(task) ? 'waiting for you' : 'working';
  if (task.status === 'done') return task.needsUser ? 'needs you' : 'done';
  if (task.status === 'error') return 'failed';
  return task.status;
}

/** A web task's steps, nested under the call that started it; open while it works or waits on the user. */
function WebTaskCard({ task, onApprove }: { task: RunState; onApprove: (approvalId: string, approved: boolean) => void }) {
  const running = task.status === 'running';
  const waiting = awaitingApproval(task);
  const [open, setOpen] = useState(running);
  const assistant = task.messages[1] ?? { id: 'empty', role: 'assistant' as const, parts: [] };
  const steps = assistant.parts.filter((p) => p.type === 'dynamic-tool').length;
  return (
    <Collapsible
      open={open || waiting}
      onOpenChange={setOpen}
      className={cn('mb-3 rounded-[10px] border border-line bg-surface-alt/40', waiting && 'border-amber/60')}
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left">
        <GlobeIcon className="size-4 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ink text-sm">{task.command}</span>
          <span className="text-ink-3 text-xs">
            Web task · {taskStatus(task)} · {steps} step{steps === 1 ? '' : 's'}
          </span>
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-ink-3 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-line border-t px-3 pt-3">
        <AssistantParts message={assistant} running={running} onApprove={onApprove} />
        {running && !waiting && <Shimmer duration={1.5}>Working in its own window…</Shimmer>}
      </CollapsibleContent>
      {!running && (task.summary || task.error) && (
        <div className="border-line border-t px-3 py-2 text-sm">
          <MessageResponse>{task.status === 'error' ? (task.error ?? '') : (task.summary ?? '')}</MessageResponse>
        </div>
      )}
    </Collapsible>
  );
}

function AssistantParts({
  message,
  running,
  onApprove,
  tasks,
}: {
  message: UIMessage;
  running: boolean;
  onApprove: (approvalId: string, approved: boolean) => void;
  /** Web tasks by the ID of the tool call that started each. */
  tasks?: RunState['tasks'];
}) {
  return (
    <>
      {message.parts.map((part, i) => {
        const key = `${message.id}-${i}`;
        const steer = steerOf(part);
        if (steer) return <SteerMessage key={key} steer={steer} />;
        switch (part.type) {
          case 'reasoning': {
            const streaming = part.state === 'streaming';
            if (!streaming && !part.text.trim()) return null;
            return (
              <Reasoning key={key} isStreaming={streaming} className="mb-3">
                <ReasoningTrigger getThinkingMessage={thinkingMessage} />
                <ReasoningContent className="mt-2 text-xs">{part.text}</ReasoningContent>
              </Reasoning>
            );
          }
          case 'text':
            if (!part.text.trim()) return null;
            return (
              <MessageResponse key={key} className="mb-3" isAnimating={running && part.state === 'streaming'}>
                {part.text}
              </MessageResponse>
            );
          case 'dynamic-tool': {
            const task = tasks?.[part.toolCallId];
            return (
              <div key={part.toolCallId}>
                <ToolCall part={part} onApprove={onApprove} />
                {task && <WebTaskCard task={task} onApprove={onApprove} />}
              </div>
            );
          }
          default:
            return null;
        }
      })}
    </>
  );
}

export function RunView({
  run,
  onApprove,
  onResume,
}: {
  run: RunState;
  onApprove: (approvalId: string, approved: boolean) => void;
  /** Given when this stopped, interrupted or failed command can be carried on. */
  onResume?: () => void;
}) {
  const [userMessage, assistant] = run.messages;
  const running = run.status === 'running';
  const parts = assistant?.parts ?? [];
  const waiting = awaitingApproval(run);
  const webTaskRunning = Object.values(run.tasks ?? {}).some((t) => t.status === 'running');
  const lastPart = parts.at(-1);
  const streamingSomething =
    lastPart && (lastPart.type === 'text' || lastPart.type === 'reasoning') && lastPart.state === 'streaming';
  const hasText = parts.some((p) => p.type === 'text' && p.text.trim());

  return (
    <div className="flex flex-col gap-4">
      {userMessage && (
        <Message from="user">
          <MessageContent>
            {run.resumed && <span className="block text-ink-3 text-xs">Resumed</span>}
            {run.command}
          </MessageContent>
        </Message>
      )}

      <Message from="assistant" className="max-w-full">
        <MessageContent className="w-full">
          {run.snapshot && (
            <ChainOfThought className="mb-3">
              <ChainOfThoughtHeader>
                Read browser: {run.snapshot.windows} window{run.snapshot.windows === 1 ? '' : 's'}, {run.snapshot.tabs} tab
                {run.snapshot.tabs === 1 ? '' : 's'}
              </ChainOfThoughtHeader>
              <ChainOfThoughtContent>
                <ChainOfThoughtStep
                  icon={MonitorIcon}
                  label={`${run.snapshot.displays} display${run.snapshot.displays === 1 ? '' : 's'}, ${run.snapshot.windows} windows, ${run.snapshot.tabs} tabs`}
                  description="Sent to Claude with your command, fresh each time. Earlier commands in the thread go with it; their snapshots don't."
                />
                {/* Saved turns drop the snapshot text, so only the live command shows it. */}
                {run.snapshot.text && (
                  <ChainOfThoughtStep icon={CameraIcon} label="Snapshot">
                    <CodeBlock
                      className="max-h-64 overflow-auto text-[11px]"
                      code={run.snapshot.text}
                      language={'text' as BundledLanguage}
                    />
                  </ChainOfThoughtStep>
                )}
              </ChainOfThoughtContent>
            </ChainOfThought>
          )}

          <AssistantParts
            message={assistant ?? { id: 'empty', role: 'assistant', parts: [] }}
            running={running}
            onApprove={onApprove}
            tasks={run.tasks}
          />

          {running && !streamingSomething && !waiting && !webTaskRunning && (
            <Shimmer duration={1.5}>
              {run.snapshot ? 'Working…' : 'Reading your browser…'}
            </Shimmer>
          )}

          {run.status === 'error' && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>Command failed</AlertTitle>
              <AlertDescription>{run.error}</AlertDescription>
            </Alert>
          )}
          {run.status === 'interrupted' && (
            <Alert>
              <AlertCircleIcon />
              <AlertTitle>Interrupted</AlertTitle>
              <AlertDescription>{run.error}</AlertDescription>
            </Alert>
          )}
          {run.status === 'stopped' && (
            <p className="flex items-center gap-1.5 text-ink-3">
              <CircleStopIcon className="size-3.5" /> Stopped.
            </p>
          )}
          {run.status === 'done' && !hasText && run.summary && <MessageResponse>{run.summary}</MessageResponse>}
          {onResume && (
            <Button size="sm" variant="outline" className="self-start" onClick={onResume}>
              <PlayIcon /> Resume
            </Button>
          )}

          {!running && run.endedAt && (
            <p className="text-ink-3 text-xs tabular-nums">
              {getModel(run.model).name} · {formatDuration(run.endedAt - run.startedAt)} · {run.usage.rounds} round
              {run.usage.rounds === 1 ? '' : 's'}
            </p>
          )}
        </MessageContent>
      </Message>
    </div>
  );
}
