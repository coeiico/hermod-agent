import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
} from '@/components/ai-elements/context';
import { getModel } from '@/ai/models';
import type { RunUsage } from '@/lib/run';
import type { LanguageModelUsage } from 'ai';

const compact = new Intl.NumberFormat('en-US', { notation: 'compact' });

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-ink-3">{label}</span>
      <span className="tabular-nums">{compact.format(value)}</span>
    </div>
  );
}

/** Token usage and cost for the current command, including prompt-cache hits. */
export function UsageMeter({ usage, modelId }: { usage: RunUsage; modelId: string }) {
  const model = getModel(modelId);
  // Shaped for AI Elements; cost is computed by us (ai/models.ts costOf), not tokenlens.
  const aiUsage: LanguageModelUsage = {
    inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    inputTokenDetails: {
      noCacheTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    },
    outputTokens: usage.outputTokens,
    outputTokenDetails: { textTokens: usage.outputTokens - usage.reasoningTokens, reasoningTokens: usage.reasoningTokens },
    totalTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens,
  };

  return (
    <Context usedTokens={usage.contextTokens} maxTokens={model.contextWindow} usage={aiUsage}>
      <ContextTrigger className="h-[var(--control-h-sm)] rounded-[8px] px-2 font-normal text-ink-2 text-sm tabular-nums hover:text-ink" />
      <ContextContent align="end" className="w-64">
        <ContextContentHeader />
        <ContextContentBody className="space-y-1.5">
          <ContextInputUsage>
            <Row label="Input (uncached)" value={usage.inputTokens} />
          </ContextInputUsage>
          <ContextCacheUsage>
            <Row label="Cache read" value={usage.cacheReadTokens} />
          </ContextCacheUsage>
          <Row label="Cache write" value={usage.cacheWriteTokens} />
          <ContextOutputUsage>
            <Row label="Output" value={usage.outputTokens} />
          </ContextOutputUsage>
          <ContextReasoningUsage>
            <Row label="  of which thinking" value={usage.reasoningTokens} />
          </ContextReasoningUsage>
        </ContextContentBody>
        <ContextContentFooter>
          <span className="text-ink-3">
            {usage.rounds} round{usage.rounds === 1 ? '' : 's'} · cost
          </span>
          <span className="tabular-nums">${usage.costUSD < 0.01 ? usage.costUSD.toFixed(5) : usage.costUSD.toFixed(3)}</span>
        </ContextContentFooter>
      </ContextContent>
    </Context>
  );
}
