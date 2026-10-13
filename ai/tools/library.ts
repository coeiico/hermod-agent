// Tools over what the browser remembers rather than what is open: recently
// closed items, bookmarks, history and downloads.
import { z } from 'zod';
import { defineTool } from '../runtime/tools';
import {
  bookmarkId,
  bookmarkIds,
  describeBookmarks,
  downloadName,
  getBookmark,
  getBookmarks,
  getDownloads,
  getTab,
  id,
  plural,
  type Bookmark,
} from './resolve';
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
    const lines = results.slice(0, maxResults).map(bookmarkLine);
    if (results.length > maxResults) lines.push(`(${results.length - maxResults} more not shown)`);
    return lines.join('\n');
  },
});

function bookmarkLine(node: Bookmark): string {
  return node.url ? `bookmark ${node.id} "${node.title}" ${shortUrl(node.url, 120)}` : `folder ${node.id} "${node.title}"`;
}

/** The folder with this ID, or else the first folder with exactly this title. */
async function findFolder(folder: string): Promise<Bookmark | undefined> {
  const byId = await browser.bookmarks.get(folder).then(([node]) => node, () => undefined);
  if (byId && !byId.url) return byId;
  const [match] = (await browser.bookmarks.search({ title: folder })).filter((n) => !n.url);
  return match;
}

async function findOrCreateFolder(folder: string): Promise<Bookmark> {
  const found = await findFolder(folder);
  if (found) return found;
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

/** How many bookmarks a folder holds, counting its subfolders. */
function countBookmarks(node: Bookmark): number {
  if (node.url) return 1;
  return (node.children ?? []).reduce((sum, child) => sum + countBookmarks(child), 0);
}

export const listBookmarks = defineTool({
  name: 'list_bookmarks',
  title: 'List bookmarks',
  effect: 'read',
  description:
    'List what is in a bookmark folder (by name or ID), nested to a depth. With no folder, lists the top-level folders such as the Bookmarks bar and Other bookmarks.',
  input: z.object({
    folder: z.string().optional(),
    depth: z.number().int().min(1).max(10).default(2).describe('How many levels of subfolders to open; 1 lists only direct contents.'),
    maxItems: z.number().int().min(1).max(500).default(200),
  }),
  async run({ folder, depth, maxItems }) {
    let nodes: Bookmark[];
    let header = '';
    if (folder) {
      const found = await findFolder(folder);
      if (!found) throw new Error(`No bookmark folder "${folder}". Call list_bookmarks without a folder to see the top-level folders.`);
      const [tree] = await browser.bookmarks.getSubTree(found.id);
      nodes = tree?.children ?? [];
      header = `${bookmarkLine(found)} (${plural(nodes.length, 'item')})`;
    } else {
      const [root] = await browser.bookmarks.getTree();
      nodes = root?.children ?? [];
    }
    const lines: string[] = [];
    let hidden = 0;
    const walk = (children: Bookmark[], level: number) => {
      for (const node of children) {
        if (lines.length >= maxItems) {
          hidden++;
          continue;
        }
        const indent = '  '.repeat(level);
        if (node.url) {
          lines.push(indent + bookmarkLine(node));
          continue;
        }
        const inside = node.children ?? [];
        lines.push(`${indent}${bookmarkLine(node)} (${plural(inside.length, 'item')})`);
        if (level + 1 < depth) walk(inside, level + 1);
      }
    };
    walk(nodes, folder ? 1 : 0);
    if (!lines.length) return header ? `${header}: empty.` : 'No bookmarks.';
    if (hidden) lines.push(`(${hidden} more not shown; list a subfolder or raise maxItems)`);
    return [header, ...lines].filter(Boolean).join('\n');
  },
});

export const updateBookmark = defineTool({
  name: 'update_bookmark',
  title: 'Edit bookmark',
  effect: 'write',
  description: 'Rename a bookmark or folder, or change where a bookmark points.',
  input: z.object({
    bookmarkId,
    title: z.string().optional().describe('The new name.'),
    url: z.string().optional().describe('The new URL; bookmarks only, not folders.'),
  }),
  async run({ bookmarkId, title, url }) {
    if (title === undefined && url === undefined) throw new Error('Give a new title, a new url, or both.');
    const node = await getBookmark(bookmarkId);
    if (url !== undefined && !node.url) throw new Error(`"${node.title}" is a folder; folders have no URL.`);
    const updated = await browser.bookmarks.update(bookmarkId, { title, url });
    const kind = node.url ? 'bookmark' : 'folder';
    const changes = [
      title !== undefined && `renamed "${node.title}" to "${updated.title}"`,
      url !== undefined && `pointed it at ${shortUrl(updated.url, 120)}`,
    ].filter(Boolean);
    return `Updated ${kind} ${bookmarkId}: ${changes.join(' and ')}.`;
  },
});

export const moveBookmarks = defineTool({
  name: 'move_bookmarks',
  title: 'Move bookmarks',
  effect: 'write',
  description:
    'Move bookmarks or folders into a folder (by name or ID), keeping the order given. A missing folder is created under Other bookmarks. Use this for every "move these bookmarks" request in a single call.',
  input: z.object({
    bookmarkIds,
    folder: z.string().min(1),
    index: z.number().int().min(0).optional().describe('Position in the folder; omit to add at the end.'),
  }),
  async run({ bookmarkIds, folder, index }) {
    const nodes = await getBookmarks(bookmarkIds);
    const parent = await findOrCreateFolder(folder);
    for (let i = 0; i < nodes.length; i++) {
      await browser.bookmarks.move(nodes[i]!.id, { parentId: parent.id, index: index === undefined ? undefined : index + i });
    }
    return `Moved ${plural(nodes.length, 'item')} (${describeBookmarks(nodes)}) to folder "${parent.title}".`;
  },
});

export const sortBookmarks = defineTool({
  name: 'sort_bookmarks',
  title: 'Sort bookmarks',
  effect: 'write',
  description:
    'Reorder bookmarks and folders within one folder. Pass their IDs in the desired order; they are placed together starting where the first of them currently sits.',
  input: z.object({ order: bookmarkIds.describe('Bookmark and folder IDs in the new order, all from the same folder.') }),
  async run({ order }) {
    const nodes = await getBookmarks(order);
    const parentId = nodes[0]!.parentId;
    const foreign = nodes.filter((n) => n.parentId !== parentId);
    if (!parentId || foreign.length) {
      throw new Error(`${describeBookmarks(foreign.length ? foreign : nodes)} are not all in one folder. Use move_bookmarks to move items between folders.`);
    }
    // Every item still to place sits at or after its target, so moving each to
    // start + i never shifts one already placed.
    const start = Math.min(...nodes.map((n) => n.index ?? 0));
    for (let i = 0; i < nodes.length; i++) {
      await browser.bookmarks.move(nodes[i]!.id, { parentId, index: start + i });
    }
    const [parent] = await browser.bookmarks.get(parentId);
    return `Reordered ${plural(nodes.length, 'item')} in folder "${parent?.title ?? parentId}".`;
  },
});

export const deleteBookmarks = defineTool({
  name: 'delete_bookmarks',
  title: 'Delete bookmarks',
  effect: 'destructive',
  alwaysAsk: true,
  description:
    'Delete bookmarks or folders. A folder is deleted with everything in it. The user is always asked to confirm, because deleted bookmarks cannot be brought back.',
  input: z.object({ bookmarkIds }),
  async confirm({ bookmarkIds }) {
    const nodes = await getBookmarks(bookmarkIds);
    const folders = await Promise.all(nodes.filter((n) => !n.url).map((n) => browser.bookmarks.getSubTree(n.id).then(([tree]) => tree!)));
    const inside = folders.reduce((sum, f) => sum + countBookmarks(f), 0);
    const what = [
      nodes.length - folders.length && plural(nodes.length - folders.length, 'bookmark'),
      folders.length && `${plural(folders.length, 'folder')} holding ${plural(inside, 'bookmark')}`,
    ].filter(Boolean);
    return `Delete ${what.join(' and ')}? ${describeBookmarks(nodes, 4)}. This can't be undone.`;
  },
  async run({ bookmarkIds }) {
    const nodes = await getBookmarks(bookmarkIds);
    for (const node of nodes) {
      // An item inside a folder deleted earlier in this call is already gone.
      const exists = await browser.bookmarks.get(node.id).then(() => true, () => false);
      if (!exists) continue;
      await (node.url ? browser.bookmarks.remove(node.id) : browser.bookmarks.removeTree(node.id));
    }
    return `Deleted ${plural(nodes.length, 'item')}: ${describeBookmarks(nodes)}.`;
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
        const name = downloadName(d);
        const size = d.totalBytes > 0 ? ` ${(d.totalBytes / 1_048_576).toFixed(1)} MB` : '';
        return `${d.id} "${name}" ${d.state}${d.error ? ` (${d.error})` : ''}${size} from ${shortUrl(d.finalUrl || d.url, 100)} ${relativeTime(Date.parse(d.startTime))}`;
      })
      .join('\n');
  },
});

export const downloadFile = defineTool({
  name: 'download_file',
  title: 'Download',
  effect: 'write',
  alwaysAsk: true,
  description: 'Download a file from a URL into the downloads folder. The user is always asked to confirm first.',
  input: z.object({
    url: z.string().url(),
    filename: z.string().min(1).optional().describe('Name to save it as, relative to the downloads folder.'),
  }),
  // A page can ask for a download in text the model reads, so never start one unseen.
  confirm: ({ url, filename }) => `Download ${filename ? `"${filename}" ` : ''}from ${shortUrl(url, 100)}?`,
  async run({ url, filename }) {
    const downloadId = await browser.downloads.download({ url, filename });
    return `Started download ${downloadId} from ${shortUrl(url, 120)}.`;
  },
});

export const showDownload = defineTool({
  name: 'show_download',
  title: 'Show download',
  effect: 'write',
  description: "Show a downloaded file in the system's file manager.",
  input: z.object({ downloadId: id }),
  async run({ downloadId }) {
    const [item] = await getDownloads([downloadId]);
    browser.downloads.show(downloadId);
    return `Showed "${downloadName(item!)}" in the file manager.`;
  },
});

export const controlDownloads = defineTool({
  name: 'control_downloads',
  title: 'Pause or resume downloads',
  effect: 'write',
  description: 'Pause, resume or cancel downloads that are in progress. Cancelling asks the user first.',
  input: z.object({
    downloadIds: z.array(id).min(1),
    action: z.enum(['pause', 'resume', 'cancel']),
  }),
  async confirm({ downloadIds, action }) {
    if (action !== 'cancel') return null;
    const items = await getDownloads(downloadIds);
    return `Cancel ${plural(items.length, 'download')}? ${items.slice(0, 4).map((d) => `"${downloadName(d)}"`).join(', ')}`;
  },
  async run({ downloadIds, action }) {
    const items = await getDownloads(downloadIds);
    const apply = (downloadId: number) => {
      if (action === 'pause') return browser.downloads.pause(downloadId);
      if (action === 'resume') return browser.downloads.resume(downloadId);
      return browser.downloads.cancel(downloadId);
    };
    const results = await Promise.allSettled(items.map((d) => apply(d.id)));
    const failed = items.filter((_, i) => results[i]!.status === 'rejected');
    const done = { pause: 'Paused', resume: 'Resumed', cancel: 'Cancelled' }[action];
    const note = failed.length
      ? ` Could not ${action} ${failed.map((d) => `"${downloadName(d)}" (${d.state}${d.paused ? ', paused' : ''})`).join(', ')}.`
      : '';
    return `${done} ${plural(items.length - failed.length, 'download')}.${note}`;
  },
});

const historyRange = {
  startTime: z.union([z.string(), z.number()]).optional().describe('ISO 8601 or epoch ms. Defaults to all time.'),
  endTime: z.union([z.string(), z.number()]).optional().describe('ISO 8601 or epoch ms. Defaults to now.'),
};

/** The pages a delete_history call would remove, or null when it clears a whole time range. */
async function historyToDelete(query: string, startTime: number, endTime: number) {
  if (!query) return null;
  return browser.history.search({ text: query, startTime, endTime, maxResults: 100_000 });
}

function rangeText(startTime: string | number | undefined, endTime: string | number | undefined): string {
  if (startTime === undefined && endTime === undefined) return 'from all time';
  const at = (t: string | number | undefined, fallback: string) => (t === undefined ? fallback : new Date(parseTime(t)!).toLocaleString());
  return `from ${at(startTime, 'the beginning')} to ${at(endTime, 'now')}`;
}

export const deleteHistory = defineTool({
  name: 'delete_history',
  title: 'Delete history',
  effect: 'destructive',
  alwaysAsk: true,
  description:
    'Delete browsing history. With a query, removes every visit to each page whose title or URL matches, including visits outside the time range. With an empty query, removes all history in the time range. The user is always asked to confirm.',
  input: z.object({
    query: z.string().describe('Words in the title or URL, such as a site name. Empty means every page in the time range.'),
    ...historyRange,
  }),
  async confirm({ query, startTime, endTime }) {
    const pages = await historyToDelete(query, parseTime(startTime) ?? 0, parseTime(endTime) ?? Date.now());
    if (!pages) return `Delete all browsing history ${rangeText(startTime, endTime)}? This can't be undone.`;
    if (!pages.length) return null;
    const sample = pages.slice(0, 3).map((h) => `"${(h.title || h.url || '').slice(0, 50)}"`).join(', ');
    return `Delete history for ${plural(pages.length, 'page')} matching "${query}" (every visit to each)? ${sample}. This can't be undone.`;
  },
  async run({ query, startTime, endTime }) {
    const start = parseTime(startTime) ?? 0;
    const end = parseTime(endTime) ?? Date.now();
    const pages = await historyToDelete(query, start, end);
    if (!pages) {
      await browser.history.deleteRange({ startTime: start, endTime: end });
      return `Deleted all browsing history ${rangeText(startTime, endTime)}.`;
    }
    if (!pages.length) return `No history matches "${query}". Nothing was deleted.`;
    for (const page of pages) if (page.url) await browser.history.deleteUrl({ url: page.url });
    return `Deleted history for ${plural(pages.length, 'page')} matching "${query}".`;
  },
});
