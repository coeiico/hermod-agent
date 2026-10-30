import { describe, expect, it } from 'vitest';
import { isSlashInput, matchSlashCommands, resolveSlashCommand } from './slash-commands';

describe('slash commands', () => {
  it('offers commands while a slash and a name are being typed', () => {
    expect(isSlashInput('/exp')).toBe(true);
    expect(matchSlashCommands('/exp').map((c) => c.name)).toEqual(['export_chat_to_markdown']);
    expect(matchSlashCommands('/zzz')).toEqual([]);
    expect(matchSlashCommands('close my tabs')).toEqual([]);
    expect(matchSlashCommands('/export_chat_to_markdown now')).toEqual([]);
  });

  it('resolves a full name, or a prefix only one command starts with', () => {
    expect(resolveSlashCommand('/export_chat_to_markdown')).toBe('export_chat_to_markdown');
    expect(resolveSlashCommand('  /export ')).toBe('export_chat_to_markdown');
  });

  it('refuses unknown commands, and anything after the name', () => {
    expect(() => resolveSlashCommand('/nope')).toThrow(/Unknown command \/nope\. Commands: \/export_chat_to_markdown/);
    expect(() => resolveSlashCommand('/export_chat_to_markdown please')).toThrow(/takes nothing after it/);
  });
});
