import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface MenuOption<T extends string> {
  value: T;
  label: string;
  description: string;
  /** Shown in the danger colour, in the menu and on the button while chosen. */
  danger?: boolean;
}

/**
 * A ghost button naming the current choice, opening a menu of the options with a
 * line each on what they do. Used for the mode, effort and model below the prompt.
 */
export function OptionMenu<T extends string>({
  name,
  value,
  options,
  onChange,
  align = 'end',
}: {
  /** What the control sets, for its tooltip and screen readers. */
  name: string;
  value: T;
  options: MenuOption<T>[];
  onChange: (value: T) => void;
  align?: 'start' | 'end';
}) {
  const current = options.find((o) => o.value === value) ?? options[0]!;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${name}: ${current.label}`}
              className={cn(
                'font-normal text-ink-2 hover:text-ink data-[state=open]:bg-accent data-[state=open]:text-ink',
                current.danger && 'text-bad-ink hover:text-bad-ink data-[state=open]:text-bad-ink',
              )}
            >
              {current.label}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{name}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align={align} className="w-64">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
          {options.map((o) => (
            <DropdownMenuRadioItem
              key={o.value}
              value={o.value}
              className={cn(
                'group flex-col items-start gap-0 text-base data-[state=checked]:bg-ground-sunk data-[state=checked]:font-medium data-[state=checked]:text-ink',
                o.danger && 'text-bad-ink data-[state=checked]:text-bad-ink',
              )}
            >
              {o.label}
              <span className="font-normal text-ink-3 text-xs group-data-[state=checked]:text-ink-2">{o.description}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
