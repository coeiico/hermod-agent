// Tools over what the browser remembers rather than what is open: recently
// closed items, bookmarks, history and downloads.
import { z } from 'zod';
import { defineTool } from '../runtime/tools';
import { getTab, id, plural } from './resolve';
import { relativeTime, shortUrl } from './snapshot';

function parseTime(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`Could not parse time "${value}". Use an ISO 8601 date such as 2026-10-13T09:00.`);
  return t;
}

export const restoreClosed = defineTool({
  name: 'restore_closed',
  title: 'Reopen closed',
  effect: 'write',
  description: 'Reopen a recently closed tab or window by its session ID from the snapshot, or the most recent one if no ID is given.',
  input: z.object({ sessionId: z.string().optional() }),
  async run({ sessionId }) {
    const restored = await browser.sessions.restore(sessionId);
    if (restored?.tab) return `Reopened tab T${restored.tab.id} "${restored.tab.title ?? ''}".`;
    if (restored?.window) return `Reopened window W${restored.window.id} with ${plural(restored.window.tabs?.length ?? 0, 'tab')}.`;
    return 'Reopened the most recently closed item.';
  },
});

export const searchBookmarks = defineTool({
  name: 'search_bookmarks',
  title: 'Search bookmarks',
  effect: 'read',
  description: 'Search bookmarks and bookmark folders by words in the title or URL.',
  input: z.object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(100).default(25),
  }),
  async run({ query, maxResults }) {
    const results = await browser.bookmarks.search(query);
    if (!results.length) return `No bookmarks match "${query}".`;
    const lines = results
      .slice(0, maxResults)
      .map((b) => (b.url ? `bookmark ${b.id} "${b.title}" ${shortUrl(b.url, 120)}` : `folder ${b.id} "${b.title}"`));
    if (results.length > maxResults) lines.push(`(${results.length - maxResults} more not shown)`);
    return lines.join('\n');
  },
});

async function findOrCreateFolder(folder: string): Promise<Browser.bookmarks.BookmarkTreeNode> {
  // Accept a folder ID or a folder title.
  const byId = await browser.bookmarks.get(folder).then(([node]) => node, () => undefined);
  if (byId && !byId.url) return byId;
  const [match] = (await browser.bookmarks.search({ title: folder })).filter((n) => !n.url);
  if (match) return match;
  const [root] = await browser.bookmarks.getTree();
  // "Other bookmarks" is conventionally the second root child; fall back to the first.
  const parent = root?.children?.[1] ?? root?.children?.[0];
  return browser.bookmarks.create({ parentId: parent?.id, title: folder });
}

export const createBookmark = defineTool({
  name: 'create_bookmark',
  title: 'Bookmark',
  effect: 'write',
  description:
    'Bookmark an open tab (give tabId) or a URL (give url and title). Optionally put it in a folder by name or ID; a missing folder is created under Other bookmarks.',
  input: z.object({
    tabId: id.optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    folder: z.string().optional(),
  }),
  async run({ tabId, url, title, folder }) {
    let bUrl = url;
    let bTitle = title;
    if (tabId !== undefined) {
      const tab = await getTab(tabId);
      bUrl = tab.url;
      bTitle = title ?? tab.title;
    }
    if (!bUrl) throw new Error('Give a tabId, or a url and title.');
    const parent = folder ? await findOrCreateFolder(folder) : undefined;
    const node = await browser.bookmarks.create({ url: bUrl, title: bTitle ?? bUrl, parentId: parent?.id });
    return `Bookmarked "${node.title}"${parent ? ` in folder "${parent.title}"` : ''}.`;
  },
});

export const searchHistory = defineTool({
  name: 'search_history',
  title: 'Search history',
  effect: 'read',
  description: 'Search browsing history by words in the title or URL. Use an empty query to list recent pages.',
  input: z.object({
    query: z.string(),
    maxResults: z.number().int().min(1).max(200).default(25),
    startTime: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Only pages visited after this time (ISO 8601 or epoch ms). Defaults to all time.'),
  }),
  async run({ query, maxResults, startTime }) {
    const items = await browser.history.search({ text: query, maxResults, startTime: parseTime(startTime) ?? 0 });
    if (!items.length) return `No history matches "${query}".`;
    return items
      .map((h) => `"${(h.title ?? '').slice(0, 80)}" ${shortUrl(h.url, 120)} ${relativeTime(h.lastVisitTime)} (${h.visitCount ?? 0} visits)`)
      .join('\n');
  },
});

export const listDownloads = defineTool({
  name: 'list_downloads',
  title: 'List downloads',
  effect: 'read',
  description: 'List recent downloads, newest first, optionally filtered by words in the filename or URL.',
  input: z.object({
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  async run({ query, limit }) {
    const items = await browser.downloads.search({ query: query ? [query] : undefined, orderBy: ['-startTime'], limit });
    if (!items.length) return query ? `No downloads match "${query}".` : 'No downloads.';
    return items
      .map((d) => {
        const name = d.filename.split(/[\\/]/).pop() || d.filename;
        const size = d.totalBytes > 0 ? ` ${(d.totalBytes / 1_048_576).toFixed(1)} MB` : '';
        return `${d.id} "${name}" ${d.state}${d.error ? ` (${d.error})` : ''}${size} from ${shortUrl(d.finalUrl || d.url, 100)} ${relativeTime(Date.parse(d.startTime))}`;
      })
      .join('\n');
  },
});
