import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from '@/components/ai-elements/model-selector';
import { PromptInputButton } from '@/components/ai-elements/prompt-input';
import { getModel, MODELS } from '@/lib/models';
import { CheckIcon } from 'lucide-react';
import { useState } from 'react';

export function ModelPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const current = getModel(value);
  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <PromptInputButton size="sm" className="gap-1.5 text-xs">
          <ModelSelectorLogo provider="anthropic" />
          <ModelSelectorName>{current.name.replace('Claude ', '')}</ModelSelectorName>
        </PromptInputButton>
      </ModelSelectorTrigger>
      <ModelSelectorContent title="Choose a model" className="max-w-[360px]">
        <ModelSelectorInput placeholder="Search models…" />
        <ModelSelectorList>
          <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
          <ModelSelectorGroup heading="Anthropic">
            {MODELS.map((m) => (
              <ModelSelectorItem
                key={m.id}
                value={m.id}
                keywords={[m.name]}
                onSelect={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
              >
                <ModelSelectorLogo provider="anthropic" />
                <div className="flex flex-1 flex-col">
                  <ModelSelectorName>{m.name}</ModelSelectorName>
                  <span className="text-muted-foreground text-xs">{m.description}</span>
                </div>
                {m.id === value && <CheckIcon className="size-4" />}
              </ModelSelectorItem>
            ))}
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
