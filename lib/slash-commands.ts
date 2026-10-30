// Slash commands typed into the prompt: fixed actions the worker runs itself,
// straight away and without the model (no API key, no cost). Shared by the
// popup, which offers and parses them, and the worker, which runs them.

export const SLASH_COMMANDS = [
  {
    name: 'export_chat_to_markdown',
    description: 'Save the ChatGPT or Claude chat in this tab to downloads as Markdown',
  },
] as const;

export type SlashCommandName = (typeof SLASH_COMMANDS)[number]['name'];

/** Whether the prompt is being typed as a slash command: a slash and a name, nothing after it. */
export function isSlashInput(text: string): boolean {
  return /^\/\S*$/.test(text.trim());
}

/** The commands whose names start with what follows the slash. */
export function matchSlashCommands(text: string): (typeof SLASH_COMMANDS)[number][] {
  if (!isSlashInput(text)) return [];
  const typed = text.trim().slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(typed));
}

/** The command a submitted prompt names: its full name, or a prefix only one command starts with. */
export function resolveSlashCommand(text: string): SlashCommandName {
  const [typed = '', ...rest] = text.trim().split(/\s+/);
  const matches = matchSlashCommands(typed);
  const command = matches.find((c) => `/${c.name}` === typed) ?? (matches.length === 1 ? matches[0] : undefined);
  if (!command) {
    const known = SLASH_COMMANDS.map((c) => `/${c.name}`).join(', ');
    throw new Error(`Unknown command ${typed}. Commands: ${known}.`);
  }
  if (rest.length) throw new Error(`/${command.name} takes nothing after it.`);
  return command.name;
}
