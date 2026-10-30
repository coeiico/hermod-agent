// Saving an AI chat (ChatGPT, Claude) from an open tab as a Markdown file. The
// conversation is fetched inside the tab, with the user's own session, from
// the same endpoint the site's web app loads it from, so the export is word
// for word and never passes through the model.
import { z } from 'zod';
import { defineTool } from '../runtime/tools';
import { chatOf, fromChatGpt, fromClaude, markdownFilename, toMarkdown, type ChatSite } from './chat-transcript';
import { checkInjectable, toBase64 } from './pages';
import { getTab, id, plural } from './resolve';
import { shortUrl } from './snapshot';

// Chrome refuses URLs longer than 2 MB, data: URLs given to downloads included.
const MAX_URL_LENGTH = 2 * 1024 * 1024;

type FetchReply = { ok: true; json: unknown } | { ok: false; error: string };

/**
 * Runs in the chat's page, so its requests carry the user's session. Sent by
 * scripting.executeScript, which sends its source: it must be self-contained.
 * Only the conversation comes back; the session token never leaves the page.
 */
async function fetchConversation(site: ChatSite, chatId: string): Promise<FetchReply> {
  const get = async (path: string, headers?: Record<string, string>) => {
    const res = await fetch(location.origin + path, { headers, credentials: 'include' });
    if (!res.ok) throw new Error(`${site} answered ${res.status} for ${path.split('?')[0]}.`);
    return res.json();
  };
  try {
    if (site === 'ChatGPT') {
      const session = await get('/api/auth/session');
      if (!session?.accessToken) return { ok: false, error: 'The tab is not signed in to ChatGPT.' };
      return { ok: true, json: await get(`/backend-api/conversation/${chatId}`, { authorization: `Bearer ${session.accessToken}` }) };
    }
    // The chat belongs to one of the user's Claude organizations; the URL doesn't say which.
    const orgs: { uuid: string }[] = await get('/api/organizations');
    for (const org of orgs) {
      const res = await fetch(
        `${location.origin}/api/organizations/${org.uuid}/chat_conversations/${chatId}?tree=True&rendering_mode=messages`,
        { credentials: 'include' },
      );
      if (res.ok) return { ok: true, json: await res.json() };
    }
    return { ok: false, error: "Claude didn't find this conversation in any of the account's organizations." };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ChatExport {
  site: ChatSite;
  title: string;
  messages: number;
  filename: string;
  downloadId: number;
}

/** Saves the chat open in the tab to the downloads folder as Markdown, named after its title unless a name is given. */
export async function exportChat(tabId: number, filename?: string): Promise<ChatExport> {
  const tab = checkInjectable(await getTab(tabId));
  const url = tab.url ?? '';
  const chat = chatOf(url);
  if (!chat) {
    throw new Error(`T${tabId} (${shortUrl(url, 80)}) isn't an open ChatGPT or Claude conversation. Exporting needs the chat itself open, at chatgpt.com/c/… or claude.ai/chat/….`);
  }
  const [result] = await browser.scripting
    .executeScript({ target: { tabId }, func: fetchConversation, args: [chat.site, chat.id] })
    .catch((err: unknown) => {
      throw new Error(`Couldn't reach the page in T${tabId} (${err instanceof Error ? err.message : String(err)}). It may be loading; try again.`);
    });
  const reply = result?.result as FetchReply | undefined;
  if (!reply) throw new Error(`The page in T${tabId} didn't answer. It may be loading; try again.`);
  if (!reply.ok) throw new Error(`Couldn't load the conversation: ${reply.error}`);

  const transcript = chat.site === 'ChatGPT' ? fromChatGpt(reply.json) : fromClaude(reply.json);
  if (!transcript.messages.length) throw new Error(`The ${chat.site} conversation in T${tabId} has no messages to export.`);
  const markdown = toMarkdown(transcript, url, new Date());
  const dataUrl = `data:text/markdown;charset=utf-8;base64,${await toBase64(new Blob([markdown]))}`;
  if (dataUrl.length > MAX_URL_LENGTH) {
    throw new Error(`"${transcript.title}" is too long to save (${(markdown.length / 1_048_576).toFixed(1)} MB of text; the limit is about 1.5 MB).`);
  }
  const name = markdownFilename(filename ?? transcript.title);
  const downloadId = await browser.downloads.download({ url: dataUrl, filename: name, conflictAction: 'uniquify' });
  return { site: chat.site, title: transcript.title, messages: transcript.messages.length, filename: name, downloadId };
}

export const exportConversation = defineTool({
  name: 'export_conversation',
  title: 'Export chat',
  effect: 'write',
  description:
    'Save the conversation open in a ChatGPT (chatgpt.com) or Claude (claude.ai) tab to the downloads folder as a Markdown file: every message on the branch the tab shows, word for word, with attachment names. Use it to export, save or download a chat; never rebuild one from get_page_text.',
  input: z.object({
    tabId: id,
    filename: z.string().min(1).optional().describe('Name to save it as, without folders. Defaults to the chat title; .md is added.'),
  }),
  async run({ tabId, filename }) {
    const saved = await exportChat(tabId, filename);
    return `Saved the ${saved.site} chat "${saved.title}" (${plural(saved.messages, 'message')}) to downloads as "${saved.filename}" (download ${saved.downloadId}).`;
  },
});
