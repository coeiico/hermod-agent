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
import { getModel } from '@/lib/models';
import type { RunUsage } from '@/lib/run';
import type { LanguageModelUsage } from 'ai';

const compact = new Intl.NumberFormat('en-US', { notation: 'compact' });

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span>{compact.format(value)}</span>
    </div>
  );
}

/** Token usage and cost for the current command, including prompt-cache hits. */
export function UsageMeter({ usage, modelId }: { usage: RunUsage; modelId: string }) {
  const model = getModel(modelId);
  // Shaped for AI Elements; cost is computed by us (lib/agent.ts), not tokenlens.
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
      <ContextTrigger className="h-8 px-2 text-xs" />
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
          <span className="text-muted-foreground">
            {usage.rounds} round{usage.rounds === 1 ? '' : 's'} · cost
          </span>
          <span>${usage.costUSD < 0.01 ? usage.costUSD.toFixed(5) : usage.costUSD.toFixed(3)}</span>
        </ContextContentFooter>
      </ContextContent>
    </Context>
  );
}
