import type { SLASH_COMMANDS } from '@/lib/slash-commands';

type SlashCommand = (typeof SLASH_COMMANDS)[number];

/** The slash commands matching what is typed, above the prompt. The first one is what Tab completes and Enter runs. */
export function SlashMenu({ commands, onPick }: { commands: SlashCommand[]; onPick: (name: SlashCommand['name']) => void }) {
  return (
    <div role="listbox" aria-label="Slash commands" className="flex flex-col rounded-[12px] border border-line bg-surface p-1">
      {commands.map((command, i) => (
        <button
          key={command.name}
          type="button"
          role="option"
          aria-selected={i === 0}
          className="flex flex-col items-start rounded-[8px] px-2 py-1.5 text-left hover:bg-surface-alt aria-selected:bg-surface-alt"
          onClick={() => onPick(command.name)}
        >
          <span className="font-medium text-ink text-sm">/{command.name}</span>
          <span className="text-ink-3 text-xs">{command.description}</span>
        </button>
      ))}
    </div>
  );
}
