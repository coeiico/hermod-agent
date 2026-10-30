// AI chat sites Hermod can export from: which URLs are conversations, the
// conversation JSON each site's own web app loads, and the Markdown transcript
// made from it. Neither site documents that JSON, so it is parsed loosely and
// a shape change fails with a message saying which site changed.
import { z } from 'zod';

export type ChatSite = 'ChatGPT' | 'Claude';

export interface ChatRef {
  site: ChatSite;
  id: string;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
  attachments: string[];
}

export interface Transcript {
  site: ChatSite;
  title: string;
  created?: Date;
  messages: TranscriptMessage[];
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// ChatGPT puts chats in custom GPTs and projects under /g/<id>/c/<chat>.
const CHATGPT_PATH = new RegExp(`^(?:/g/[^/]+)?/c/(${UUID})(?:/|$)`, 'i');
const CLAUDE_PATH = new RegExp(`^/chat/(${UUID})(?:/|$)`, 'i');

/** The conversation a tab's URL shows, or null when it isn't one Hermod can export. */
export function chatOf(url: string): ChatRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname === 'chatgpt.com' || parsed.hostname === 'chat.openai.com') {
    const id = CHATGPT_PATH.exec(parsed.pathname)?.[1];
    return id ? { site: 'ChatGPT', id } : null;
  }
  if (parsed.hostname === 'claude.ai') {
    const id = CLAUDE_PATH.exec(parsed.pathname)?.[1];
    return id ? { site: 'Claude', id } : null;
  }
  return null;
}

function parse<S extends z.ZodType>(site: ChatSite, schema: S, json: unknown): z.infer<S> {
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(`${site}'s conversation data has changed shape (${issue?.path.join('.') || 'top level'}: ${issue?.message}). Exporting from ${site} needs updating.`);
}

/** Walks parent links from the leaf to the root, returning the branch root first. */
function branch<T>(leaf: string, get: (id: string) => T | undefined, parentOf: (node: T) => string | null | undefined): T[] {
  const path: T[] = [];
  const seen = new Set<string>();
  for (let id: string | null | undefined = leaf; id && !seen.has(id); id = parentOf(path[path.length - 1]!)) {
    seen.add(id);
    const node = get(id);
    if (!node) break;
    path.push(node);
  }
  return path.reverse();
}

/** Drops messages with nothing to show, and joins a reply the site split over several messages. */
function tidy(messages: TranscriptMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const m of messages) {
    const text = m.text.trim();
    if (!text && !m.attachments.length) continue;
    const last = out[out.length - 1];
    if (last?.role === m.role) {
      last.text = [last.text, text].filter(Boolean).join('\n\n');
      last.attachments.push(...m.attachments);
    } else {
      out.push({ role: m.role, text, attachments: [...m.attachments] });
    }
  }
  return out;
}

// ------------------------------------------------------------------ ChatGPT

const ChatGptConversation = z.object({
  title: z.string().nullish(),
  create_time: z.number().nullish(),
  current_node: z.string(),
  mapping: z.record(
    z.string(),
    z.object({
      parent: z.string().nullish(),
      message: z
        .object({
          author: z.object({ role: z.string() }),
          recipient: z.string().nullish(),
          content: z.object({ content_type: z.string(), parts: z.array(z.unknown()).nullish() }),
          metadata: z
            .object({
              is_visually_hidden_from_conversation: z.boolean().nullish(),
              attachments: z.array(z.object({ name: z.string().nullish() })).nullish(),
            })
            .nullish(),
        })
        .nullish(),
    }),
  ),
});

// Citation markers ChatGPT writes into replies with Unicode private-use
// characters; its web app turns them into source chips.
const CHATGPT_CITATION = /[^]*/g;

/** The branch of a ChatGPT conversation the user last saw, as returned by its /backend-api/conversation/<id>. */
export function fromChatGpt(json: unknown): Transcript {
  const chat = parse('ChatGPT', ChatGptConversation, json);
  const nodes = branch(chat.current_node, (id) => chat.mapping[id], (node) => node.parent);
  const messages: TranscriptMessage[] = [];
  for (const { message } of nodes) {
    if (!message || message.metadata?.is_visually_hidden_from_conversation) continue;
    const role = message.author.role;
    if (role !== 'user' && role !== 'assistant') continue;
    // An assistant message addressed elsewhere is a tool call, not a reply.
    if (message.recipient && message.recipient !== 'all') continue;
    const { content_type, parts } = message.content;
    if (content_type !== 'text' && content_type !== 'multimodal_text') continue;
    const text = (parts ?? [])
      .map((part) => (typeof part === 'string' ? part : '[image]'))
      .join('\n\n')
      .replace(CHATGPT_CITATION, '');
    const attachments = (message.metadata?.attachments ?? []).map((a) => a.name).filter((name): name is string => !!name);
    messages.push({ role, text, attachments });
  }
  return {
    site: 'ChatGPT',
    title: chat.title?.trim() || 'Untitled chat',
    created: chat.create_time ? new Date(chat.create_time * 1000) : undefined,
    messages: tidy(messages),
  };
}

// ------------------------------------------------------------------- Claude

const ClaudeFile = z.object({ file_name: z.string().nullish() });

const ClaudeConversation = z.object({
  name: z.string().nullish(),
  created_at: z.string().nullish(),
  current_leaf_message_uuid: z.string().nullish(),
  chat_messages: z.array(
    z.object({
      uuid: z.string(),
      parent_message_uuid: z.string().nullish(),
      sender: z.string(),
      text: z.string().nullish(),
      content: z.array(z.object({ type: z.string(), text: z.string().nullish() })).nullish(),
      attachments: z.array(ClaudeFile).nullish(),
      files: z.array(ClaudeFile).nullish(),
    }),
  ),
});

/** The branch of a Claude conversation the user last saw, as returned by claude.ai's chat_conversations/<id>?tree=True. */
export function fromClaude(json: unknown): Transcript {
  const chat = parse('Claude', ClaudeConversation, json);
  const byId = new Map(chat.chat_messages.map((m) => [m.uuid, m]));
  const leaf = chat.current_leaf_message_uuid ?? chat.chat_messages[chat.chat_messages.length - 1]?.uuid;
  if (leaf && !byId.has(leaf)) throw new Error("Claude's conversation data names a last message it doesn't include. Exporting from Claude needs updating.");
  const nodes = leaf ? branch(leaf, (id) => byId.get(id), (m) => m.parent_message_uuid) : [];
  const messages: TranscriptMessage[] = [];
  for (const m of nodes) {
    if (m.sender !== 'human' && m.sender !== 'assistant') continue;
    // Replies come as content blocks (text, thinking, tool calls); keep the text the user read.
    const blocks = (m.content ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text!);
    const text = blocks.length ? blocks.join('\n\n') : (m.text ?? '');
    const attachments = [...new Set([...(m.attachments ?? []), ...(m.files ?? [])].map((f) => f.file_name).filter((name): name is string => !!name))];
    messages.push({ role: m.sender === 'human' ? 'user' : 'assistant', text, attachments });
  }
  return {
    site: 'Claude',
    title: chat.name?.trim() || 'Untitled chat',
    created: chat.created_at ? new Date(chat.created_at) : undefined,
    messages: tidy(messages),
  };
}

// ----------------------------------------------------------------- Markdown

function isoDate(date: Date): string {
  return Number.isNaN(date.getTime()) ? 'unknown date' : date.toISOString().slice(0, 10);
}

/**
 * Each message sits in a `<user>` or `<assistant>` tag, because replies use
 * Markdown headings themselves: a heading can't mark who is speaking. The
 * blank lines inside the tags keep the message rendering as Markdown.
 */
export function toMarkdown(transcript: Transcript, url: string, exportedAt: Date): string {
  const started = transcript.created ? `, started ${isoDate(transcript.created)}` : '';
  const lines = [`# ${transcript.title}`, '', `${transcript.site} conversation${started}, exported ${isoDate(exportedAt)} from <${url}>`];
  for (const m of transcript.messages) {
    lines.push('', `<${m.role}>`, '');
    if (m.text) lines.push(m.text, '');
    if (m.attachments.length) lines.push(`_Attached: ${m.attachments.join(', ')}_`, '');
    lines.push(`</${m.role}>`);
  }
  return `${lines.join('\n')}\n`;
}

/** A safe file name for the downloads folder: no folders or characters file systems reject, ending in .md. */
export function markdownFilename(name: string): string {
  const base = name
    .replace(/\.md$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 100)
    .trim();
  return `${base || 'Conversation'}.md`;
}
