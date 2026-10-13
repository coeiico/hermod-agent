// Turning IDs the model wrote into real tabs, windows and bookmarks. This is
// the trust boundary for tool input: an ID that doesn't exist, or names a
// Vivaldi web panel, is refused here with an error the model can act on.
import { z } from 'zod';
import { claimedWindow, claimOf } from './scope';
import { isHermodTab, isPanelTab } from './snapshot';

export type Tab = Browser.tabs.Tab;
export type Window = Browser.windows.Window;
export type Bookmark = Browser.bookmarks.BookmarkTreeNode;
export type Download = Browser.downloads.DownloadItem;

export const id = z.number().int();
export const tabIds = z.array(id).min(1).describe('Tab IDs from the snapshot (the number after T).');
export const bookmarkId = z.string().min(1).describe('A bookmark or folder ID from search_bookmarks or list_bookmarks.');
export const bookmarkIds = z.array(bookmarkId).min(1);

export async function getTabs(ids: number[]): Promise<Tab[]> {
  const unique = [...new Set(ids)];
  const results = await Promise.all(unique.map((i) => browser.tabs.get(i).catch(() => undefined)));
  const missing = unique.filter((_, i) => !results[i]);
  if (missing.length) {
    throw new Error(`No tab with ID ${missing.map((m) => `T${m}`).join(', ')}. Call refresh_snapshot to see current tabs.`);
  }
  const tabs = results as Tab[];
  const panels = tabs.filter(isPanelTab);
  if (panels.length) {
    throw new Error(`${panels.map((t) => `T${t.id}`).join(', ')} are Vivaldi web panels, not tabs, and can't be changed.`);
  }
  const own = tabs.filter(isHermodTab);
  if (own.length) throw new Error(`${own.map((t) => `T${t.id}`).join(', ')} show Hermod itself and can't be changed.`);
  const claimed = tabs.filter((t) => claimOf(t));
  if (claimed.length) {
    throw new Error(
      `${claimed.map((t) => `T${t.id}`).join(', ')} ${claimed.length === 1 ? 'is' : 'are'} in use by web task ${claimOf(claimed[0]!)!.label}. Wait for it to finish, or stop it.`,
    );
  }
  return tabs;
}

export async function getTab(tabId: number): Promise<Tab> {
  const [tab] = await getTabs([tabId]);
  return tab!;
}

export async function getWindow(windowId: number): Promise<Window> {
  const window = await browser.windows.get(windowId, { populate: true }).catch(() => undefined);
  if (!window) throw new Error(`No window with ID W${windowId}. Call refresh_snapshot to see current windows.`);
  if (window.tabs?.length && window.tabs.every(isHermodTab)) throw new Error(`W${windowId} is Hermod's own window and can't be changed.`);
  const claim = claimedWindow(windowId);
  if (claim) throw new Error(`W${windowId} is in use by web task ${claim.label}. Wait for it to finish, or stop it.`);
  return window;
}

export async function getBookmarks(ids: string[]): Promise<Bookmark[]> {
  const unique = [...new Set(ids)];
  const results = await Promise.all(unique.map((i) => browser.bookmarks.get(i).then(([node]) => node, () => undefined)));
  const missing = unique.filter((_, i) => !results[i]);
  if (missing.length) {
    throw new Error(`No bookmark or folder with ID ${missing.join(', ')}. Call search_bookmarks or list_bookmarks to find IDs.`);
  }
  return results as Bookmark[];
}

export async function getBookmark(bookmarkId: string): Promise<Bookmark> {
  const [node] = await getBookmarks([bookmarkId]);
  return node!;
}

export async function getDownloads(ids: number[]): Promise<Download[]> {
  const unique = [...new Set(ids)];
  const results = await Promise.all(unique.map((i) => browser.downloads.search({ id: i }).then(([item]) => item)));
  const missing = unique.filter((_, i) => !results[i]);
  if (missing.length) throw new Error(`No download with ID ${missing.join(', ')}. Call list_downloads to find IDs.`);
  return results as Download[];
}

export function downloadName(item: Download): string {
  return item.filename.split(/[\\/]/).pop() || item.filename || item.url;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** A short list of tab titles for results and confirmation questions. */
export function describeTabs(tabs: Tab[], max = 5): string {
  const shown = tabs.slice(0, max).map((t) => `"${(t.title ?? t.url ?? '').slice(0, 50)}"`);
  return shown.join(', ') + (tabs.length > max ? ` and ${tabs.length - max} more` : '');
}

/** A short list of bookmark and folder titles for results and confirmation questions. */
export function describeBookmarks(nodes: Bookmark[], max = 5): string {
  const shown = nodes.slice(0, max).map((n) => `"${(n.title || n.url || '').slice(0, 50)}"`);
  return shown.join(', ') + (nodes.length > max ? ` and ${nodes.length - max} more` : '');
}
