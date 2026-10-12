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
import { getModel } from '@/lib/models';
import type { RunState } from '@/lib/run';
import type { DynamicToolUIPart, UIMessage } from 'ai';
import type { BundledLanguage } from 'shiki';
import { AlertCircleIcon, CameraIcon, CheckIcon, CircleStopIcon, MonitorIcon, XIcon } from 'lucide-react';

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
      <Confirmation approval={part.approval} state={part.state} className={awaiting ? 'border-amber-500/50' : undefined}>
        <ConfirmationTitle>
          <ConfirmationRequest>{part.approval?.requestReason ?? 'Allow this action?'}</ConfirmationRequest>
          <ConfirmationAccepted>
            <span className="inline-flex items-center gap-1.5">
              <CheckIcon className="size-4 text-green-600" /> Approved
            </span>
          </ConfirmationAccepted>
          <ConfirmationRejected>
            <span className="inline-flex items-center gap-1.5">
              <XIcon className="size-4 text-orange-600" /> Declined. Nothing was changed.
            </span>
          </ConfirmationRejected>
        </ConfirmationTitle>
        <ConfirmationActions>
          <ConfirmationAction variant="outline" onClick={() => part.approval && onApprove(part.approval.id, false)}>
            No
          </ConfirmationAction>
          <ConfirmationAction autoFocus onClick={() => part.approval && onApprove(part.approval.id, true)}>
            Yes
          </ConfirmationAction>
        </ConfirmationActions>
      </Confirmation>
    </div>
  );
}

function AssistantParts({
  message,
  running,
  onApprove,
}: {
  message: UIMessage;
  running: boolean;
  onApprove: (approvalId: string, approved: boolean) => void;
}) {
  return (
    <>
      {message.parts.map((part, i) => {
        const key = `${message.id}-${i}`;
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
          case 'dynamic-tool':
            return <ToolCall key={part.toolCallId} part={part} onApprove={onApprove} />;
          default:
            return null;
        }
      })}
    </>
  );
}

export function RunView({ run, onApprove }: { run: RunState; onApprove: (approvalId: string, approved: boolean) => void }) {
  const [userMessage, assistant] = run.messages;
  const running = run.status === 'running';
  const parts = assistant?.parts ?? [];
  const awaitingApproval = parts.some((p) => p.type === 'dynamic-tool' && p.state === 'approval-requested');
  const lastPart = parts.at(-1);
  const streamingSomething =
    lastPart && (lastPart.type === 'text' || lastPart.type === 'reasoning') && lastPart.state === 'streaming';
  const hasText = parts.some((p) => p.type === 'text' && p.text.trim());

  return (
    <div className="flex flex-col gap-4">
      {userMessage && (
        <Message from="user">
          <MessageContent className="px-3 py-2">{run.command}</MessageContent>
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
                  description="Sent to Claude with your command. Fresh every time; nothing carries over between commands."
                />
                <ChainOfThoughtStep icon={CameraIcon} label="Snapshot">
                  <CodeBlock
                    className="max-h-64 overflow-auto text-[11px]"
                    code={run.snapshot.text}
                    language={'text' as BundledLanguage}
                  />
                </ChainOfThoughtStep>
              </ChainOfThoughtContent>
            </ChainOfThought>
          )}

          <AssistantParts message={assistant ?? { id: 'empty', role: 'assistant', parts: [] }} running={running} onApprove={onApprove} />

          {running && !streamingSomething && !awaitingApproval && (
            <Shimmer className="text-sm" duration={1.5}>
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
            <p className="flex items-center gap-1.5 text-muted-foreground text-sm">
              <CircleStopIcon className="size-4" /> Stopped.
            </p>
          )}
          {run.status === 'done' && !hasText && run.summary && <MessageResponse>{run.summary}</MessageResponse>}

          {!running && run.endedAt && (
            <p className="text-[11px] text-muted-foreground">
              {getModel(run.model).name} · {formatDuration(run.endedAt - run.startedAt)} · {run.usage.rounds} round
              {run.usage.rounds === 1 ? '' : 's'}
            </p>
          )}
        </MessageContent>
      </Message>
    </div>
  );
}
