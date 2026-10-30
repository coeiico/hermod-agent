import { describe, expect, it } from 'vitest';
import { chatOf, fromChatGpt, fromClaude, markdownFilename, toMarkdown } from './chat-transcript';

const ID = '6710a2b4-1c3d-8000-9e4f-0a1b2c3d4e5f';

describe('chatOf', () => {
  it('finds ChatGPT chats, including ones in custom GPTs and projects', () => {
    expect(chatOf(`https://chatgpt.com/c/${ID}`)).toEqual({ site: 'ChatGPT', id: ID });
    expect(chatOf(`https://chatgpt.com/g/g-p-abc123-trips/c/${ID}?model=x`)).toEqual({ site: 'ChatGPT', id: ID });
    expect(chatOf(`https://chat.openai.com/c/${ID}`)).toEqual({ site: 'ChatGPT', id: ID });
  });

  it('finds Claude chats', () => {
    expect(chatOf(`https://claude.ai/chat/${ID}`)).toEqual({ site: 'Claude', id: ID });
  });

  it('ignores pages that are not a conversation', () => {
    expect(chatOf('https://chatgpt.com/')).toBeNull();
    expect(chatOf(`https://chatgpt.com/share/${ID}`)).toBeNull();
    expect(chatOf('https://claude.ai/new')).toBeNull();
    expect(chatOf(`https://example.com/chat/${ID}`)).toBeNull();
    expect(chatOf(`http://claude.ai/chat/${ID}`)).toBeNull();
    expect(chatOf('not a url')).toBeNull();
  });
});

const node = (parent: string | null, role: string, parts: unknown[], extra: Record<string, unknown> = {}) => ({
  parent,
  message: { author: { role }, recipient: 'all', content: { content_type: 'text', parts }, ...extra },
});

describe('fromChatGpt', () => {
  const chat = {
    title: 'Trip ideas',
    create_time: 1_760_000_000.5,
    current_node: 'a2',
    mapping: {
      root: { parent: null, message: null },
      sys: node('root', 'system', ['You are ChatGPT']),
      ctx: { parent: 'sys', message: { author: { role: 'user' }, content: { content_type: 'user_editable_context' } } },
      u1: node('ctx', 'user', ['Where should I go in May?'], { metadata: { attachments: [{ name: 'calendar.png' }] } }),
      a1old: node('u1', 'assistant', ['An answer the user regenerated']),
      a1: node('u1', 'assistant', ['Try Lisbon. citeturn0search0']),
      call: { parent: 'a1', message: { author: { role: 'assistant' }, recipient: 'web.run', content: { content_type: 'code', text: '{}' } } },
      tool: node('call', 'tool', ['search results']),
      a2: node('tool', 'assistant', ['Or Porto.']),
    },
  };

  it('keeps the branch shown, user and assistant text only, joining split replies', () => {
    const t = fromChatGpt(chat);
    expect(t.title).toBe('Trip ideas');
    expect(t.created?.toISOString()).toBe('2025-10-09T08:53:20.500Z');
    expect(t.messages).toEqual([
      { role: 'user', text: 'Where should I go in May?', attachments: ['calendar.png'] },
      { role: 'assistant', text: 'Try Lisbon.\n\nOr Porto.', attachments: [] },
    ]);
  });

  it('says which site changed when the data has an unexpected shape', () => {
    expect(() => fromChatGpt({ mapping: {} })).toThrow(/ChatGPT's conversation data has changed shape \(current_node/);
  });
});

const message = (uuid: string, parent: string, sender: string, extra: Record<string, unknown>) => ({ uuid, parent_message_uuid: parent, sender, ...extra });

describe('fromClaude', () => {
  const root = '00000000-0000-4000-8000-000000000000';
  const chat = {
    name: 'Refactor plan',
    created_at: '2026-10-01T09:00:00Z',
    current_leaf_message_uuid: 'a1',
    chat_messages: [
      message('h1', root, 'human', { text: 'Review this', attachments: [{ file_name: 'notes.md' }], files: [{ file_name: 'notes.md' }, { file_name: 'diagram.png' }] }),
      message('a0', 'h1', 'assistant', { text: 'A reply on another branch' }),
      message('a1', 'h1', 'assistant', {
        text: 'fallback',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Here is my review.' },
          { type: 'tool_use', name: 'web_search' },
          { type: 'text', text: 'Looks good.' },
        ],
      }),
    ],
  };

  it('keeps the branch shown, and the text blocks of each reply', () => {
    const t = fromClaude(chat);
    expect(t.title).toBe('Refactor plan');
    expect(t.messages).toEqual([
      { role: 'user', text: 'Review this', attachments: ['notes.md', 'diagram.png'] },
      { role: 'assistant', text: 'Here is my review.\n\nLooks good.', attachments: [] },
    ]);
  });

  it('refuses a leaf the data does not include', () => {
    expect(() => fromClaude({ ...chat, current_leaf_message_uuid: 'gone' })).toThrow(/names a last message/);
  });
});

describe('toMarkdown', () => {
  it('writes a heading, where it came from, and each message in a tag saying who said it', () => {
    const md = toMarkdown(
      {
        site: 'Claude',
        title: 'Refactor plan',
        created: new Date('2026-10-01T09:00:00Z'),
        messages: [
          { role: 'user', text: 'Review this', attachments: ['notes.md'] },
          { role: 'assistant', text: '## Findings\n\nLooks good.', attachments: [] },
          { role: 'user', text: '', attachments: ['diagram.png'] },
        ],
      },
      `https://claude.ai/chat/${ID}`,
      new Date('2026-10-14T12:00:00Z'),
    );
    expect(md).toBe(
      [
        '# Refactor plan',
        '',
        `Claude conversation, started 2026-10-01, exported 2026-10-14 from <https://claude.ai/chat/${ID}>`,
        '',
        '<user>',
        '',
        'Review this',
        '',
        '_Attached: notes.md_',
        '',
        '</user>',
        '',
        '<assistant>',
        '',
        '## Findings',
        '',
        'Looks good.',
        '',
        '</assistant>',
        '',
        '<user>',
        '',
        '_Attached: diagram.png_',
        '',
        '</user>',
        '',
      ].join('\n'),
    );
  });
});

describe('markdownFilename', () => {
  it('makes a single safe file name ending in .md', () => {
    expect(markdownFilename('Trip ideas')).toBe('Trip ideas.md');
    expect(markdownFilename('notes.md')).toBe('notes.md');
    expect(markdownFilename('../../etc/passwd')).toBe('etc passwd.md');
    expect(markdownFilename('Q&A: "what?" <draft>')).toBe('Q&A what draft.md');
    expect(markdownFilename('...')).toBe('Conversation.md');
    expect(markdownFilename('x'.repeat(300))).toBe(`${'x'.repeat(100)}.md`);
  });
});
