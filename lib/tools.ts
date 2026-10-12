// Tool catalogue. Each tool is a thin wrapper over one chrome.* call, takes
// arrays of IDs where that makes sense, and returns a short string saying what
// changed (or throws with a clear message so Claude can recover).
//
// The order of TOOLS is part of the prompt-cache prefix: append new tools at
// the end and never reorder.
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { buildSnapshot, isPanelTab, relativeTime, shortUrl } from './snapshot';

type Tab = Browser.tabs.Tab;

export interface ToolContext {
  signal: AbortSignal;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  /** Short label for the UI. */
  title: string;
  description: string;
  schema: S;
  /** Return a question to ask the user before running, or null to run straight away. */
  confirm?: (input: z.infer<S>) => Promise<string | null> | string | null;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<string>;
}

function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

// ---------------------------------------------------------------- helpers

const id = z.number().int();
const tabIds = z.array(id).min(1).describe('Tab IDs from the snapshot (the number after T).');
const windowState = z.enum(['normal', 'minimized', 'maximized', 'fullscreen']);
const bounds = z
  .object({
    left: z.number().int().optional(),
    top: z.number().int().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .describe('Window position and size in screen pixels. Use display workArea values to place windows on a monitor.');

async function getTabs(ids: number[]): Promise<Tab[]> {
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
  return tabs;
}

async function getWindow(windowId: number): Promise<Browser.windows.Window> {
  try {
    return await browser.windows.get(windowId, { populate: true });
  } catch {
    throw new Error(`No window with ID W${windowId}. Call refresh_snapshot to see current windows.`);
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function describeTabs(tabs: Tab[], max = 5): string {
  const shown = tabs.slice(0, max).map((t) => `"${(t.title ?? t.url ?? '').slice(0, 50)}"`);
  return shown.join(', ') + (tabs.length > max ? ` and ${tabs.length - max} more` : '');
}

function parseTime(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`Could not parse time "${value}". Use an ISO 8601 date such as 2026-10-13T09:00.`);
  return t;
}

/** Applies bounds and state in the order Chrome requires (bounds only apply to normal windows). */
async function applyWindowLayout(
  windowId: number,
  state: z.infer<typeof windowState> | undefined,
  b: z.infer<typeof bounds> | undefined,
  focused?: boolean,
) {
  if (b && Object.keys(b).length) {
    await browser.windows.update(windowId, { state: 'normal' });
    await browser.windows.update(windowId, { ...b });
  }
  if (state && state !== 'normal') await browser.windows.update(windowId, { state });
  else if (state === 'normal' && !b) await browser.windows.update(windowId, { state });
  if (focused) await browser.windows.update(windowId, { focused: true });
}

const RESTRICTED_URL = /^(vivaldi|chrome|edge|about|devtools|chrome-extension|view-source):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;

async function injectable(tabId: number): Promise<Tab> {
  const [tab] = await getTabs([tabId]);
  const url = tab!.url ?? tab!.pendingUrl ?? '';
  if (!url || RESTRICTED_URL.test(url)) {
    throw new Error(`Can't read ${url || 'this tab'}: browser-internal pages and extension-store pages block extensions.`);
  }
  if (tab!.discarded) {
    throw new Error(`T${tabId} is discarded (unloaded). Reload it with reload_tabs first, then try again.`);
  }
  return tab!;
}

// ---------------------------------------------------------------- tools

const moveTabs = defineTool({
  name: 'move_tabs',
  title: 'Move tabs',
  description:
    'Move one or more tabs to a window (the same or another one) at a position. Tabs keep the order given. Use this for every "move these tabs" request in a single call.',
  schema: z.object({
    tabIds,
    windowId: id.describe('Destination window ID (the number after W).'),
    index: id.min(-1).default(-1).describe('Position in the destination window; -1 means the end.'),
  }),
  async run({ tabIds, windowId, index }) {
    const tabs = await getTabs(tabIds);
    await getWindow(windowId);
    await browser.tabs.move(tabIds, { windowId, index });
    return `Moved ${plural(tabs.length, 'tab')} (${describeTabs(tabs)}) to W${windowId}${index === -1 ? '' : ` at position ${index}`}.`;
  },
});

const newWindowWithTabs = defineTool({
  name: 'new_window_with_tabs',
  title: 'New window with tabs',
  description:
    'Create a new window containing the given existing tabs (moved, not copied), optionally positioned with bounds (for example on a specific display) and a state.',
  schema: z.object({
    tabIds,
    state: windowState.optional(),
    bounds: bounds.optional(),
    focused: z.boolean().default(true),
  }),
  async run({ tabIds, state, bounds: b, focused }) {
    const tabs = await getTabs(tabIds);
    const [first, ...rest] = tabIds;
    const win = await browser.windows.create({ tabId: first, focused, ...(b ?? {}) });
    if (!win?.id) throw new Error('The browser did not return the new window.');
    if (rest.length) await browser.tabs.move(rest, { windowId: win.id, index: -1 });
    if (state && state !== 'normal') await browser.windows.update(win.id, { state });
    return `Created W${win.id} with ${plural(tabs.length, 'tab')} (${describeTabs(tabs)}).`;
  },
});

const focusWindow = defineTool({
  name: 'focus_window',
  title: 'Focus window',
  description: 'Bring a window to the front and focus it.',
  schema: z.object({ windowId: id }),
  async run({ windowId }) {
    await getWindow(windowId);
    await browser.windows.update(windowId, { focused: true });
    return `Focused W${windowId}.`;
  },
});

const setWindowState = defineTool({
  name: 'set_window_state',
  title: 'Resize window',
  description:
    'Change a window state (normal, minimized, maximized, fullscreen) and/or its bounds. To put a window on another monitor, set bounds inside that display workArea; add state "maximized" to fill it.',
  schema: z.object({
    windowId: id,
    state: windowState.optional(),
    bounds: bounds.optional(),
  }),
  async run({ windowId, state, bounds: b }) {
    if (!state && !b) throw new Error('Give a state, bounds, or both.');
    await getWindow(windowId);
    await applyWindowLayout(windowId, state, b);
    const w = await browser.windows.get(windowId);
    return `W${windowId} is now ${w.state} at ${w.width}x${w.height}@${w.left},${w.top}.`;
  },
});

const mergeWindows = defineTool({
  name: 'merge_windows',
  title: 'Merge windows',
  description: 'Move every tab from the source windows into the target window (appended at the end). Source windows close once empty.',
  schema: z.object({
    sourceWindowIds: z.array(id).min(1),
    targetWindowId: id,
  }),
  async run({ sourceWindowIds, targetWindowId }) {
    await getWindow(targetWindowId);
    let moved = 0;
    for (const sourceId of sourceWindowIds) {
      if (sourceId === targetWindowId) continue;
      const source = await getWindow(sourceId);
      const ids = (source.tabs ?? []).filter((t) => !isPanelTab(t) && t.id !== undefined).map((t) => t.id!);
      if (ids.length) await browser.tabs.move(ids, { windowId: targetWindowId, index: -1 });
      moved += ids.length;
    }
    return `Moved ${plural(moved, 'tab')} from ${sourceWindowIds.map((w) => `W${w}`).join(', ')} into W${targetWindowId}.`;
  },
});

const activateTab = defineTool({
  name: 'activate_tab',
  title: 'Switch to tab',
  description: 'Make a tab the active tab in its window and focus that window.',
  schema: z.object({ tabId: id }),
  async run({ tabId }) {
    const [tab] = await getTabs([tabId]);
    await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(tab!.windowId, { focused: true });
    return `Switched to T${tabId} "${tab!.title ?? ''}" in W${tab!.windowId}.`;
  },
});

const openTab = defineTool({
  name: 'open_tab',
  title: 'Open tab',
  description: 'Open a new tab with a URL. Defaults to the focused window, at the end, made active.',
  schema: z.object({
    url: z.string().min(1).describe('Full URL including https://'),
    windowId: id.optional(),
    active: z.boolean().default(true),
    index: id.min(0).optional(),
  }),
  async run({ url, windowId, active, index }) {
    if (windowId !== undefined) await getWindow(windowId);
    const tab = await browser.tabs.create({ url, windowId, active, index });
    if (active && tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
    return `Opened T${tab.id} (${shortUrl(url, 120)}) in W${tab.windowId}.`;
  },
});

const closeTabs = defineTool({
  name: 'close_tabs',
  title: 'Close tabs',
  description:
    'Close one or more tabs. Asks the user to confirm when closing more than 3. Closed tabs can be brought back with restore_closed.',
  schema: z.object({ tabIds }),
  async confirm({ tabIds }) {
    if (tabIds.length <= 3) return null;
    const tabs = await getTabs(tabIds);
    return `Close ${tabs.length} tabs? ${describeTabs(tabs, 4)}`;
  },
  async run({ tabIds }) {
    const tabs = await getTabs(tabIds);
    await browser.tabs.remove(tabIds);
    return `Closed ${plural(tabs.length, 'tab')}: ${describeTabs(tabs)}.`;
  },
});

const closeWindow = defineTool({
  name: 'close_window',
  title: 'Close window',
  description: 'Close a whole window and all its tabs. Always asks the user to confirm first.',
  schema: z.object({ windowId: id }),
  async confirm({ windowId }) {
    const w = await getWindow(windowId);
    const tabs = (w.tabs ?? []).filter((t) => !isPanelTab(t));
    return `Close window W${windowId} and its ${plural(tabs.length, 'tab')}? ${describeTabs(tabs, 3)}`;
  },
  async run({ windowId }) {
    await getWindow(windowId);
    await browser.windows.remove(windowId);
    return `Closed W${windowId}.`;
  },
});

const pinTabs = defineTool({
  name: 'pin_tabs',
  title: 'Pin tabs',
  description: 'Pin (value true) or unpin (value false) tabs.',
  schema: z.object({ tabIds, value: z.boolean() }),
  async run({ tabIds, value }) {
    await getTabs(tabIds);
    await Promise.all(tabIds.map((t) => browser.tabs.update(t, { pinned: value })));
    return `${value ? 'Pinned' : 'Unpinned'} ${plural(tabIds.length, 'tab')}.`;
  },
});

const muteTabs = defineTool({
  name: 'mute_tabs',
  title: 'Mute tabs',
  description: 'Mute (value true) or unmute (value false) tabs.',
  schema: z.object({ tabIds, value: z.boolean() }),
  async run({ tabIds, value }) {
    await getTabs(tabIds);
    await Promise.all(tabIds.map((t) => browser.tabs.update(t, { muted: value })));
    return `${value ? 'Muted' : 'Unmuted'} ${plural(tabIds.length, 'tab')}.`;
  },
});

const reloadTabs = defineTool({
  name: 'reload_tabs',
  title: 'Reload tabs',
  description: 'Reload tabs. bypassCache does a hard reload.',
  schema: z.object({ tabIds, bypassCache: z.boolean().default(false) }),
  async run({ tabIds, bypassCache }) {
    await getTabs(tabIds);
    await Promise.all(tabIds.map((t) => browser.tabs.reload(t, { bypassCache })));
    return `Reloaded ${plural(tabIds.length, 'tab')}${bypassCache ? ' (bypassing cache)' : ''}.`;
  },
});

const duplicateTab = defineTool({
  name: 'duplicate_tab',
  title: 'Duplicate tab',
  description: 'Duplicate a tab next to the original.',
  schema: z.object({ tabId: id }),
  async run({ tabId }) {
    await getTabs([tabId]);
    const copy = await browser.tabs.duplicate(tabId);
    return `Duplicated T${tabId} as T${copy?.id}.`;
  },
});

const discardTabs = defineTool({
  name: 'discard_tabs',
  title: 'Unload tabs',
  description: 'Unload tabs from memory without closing them (they reload when clicked). Active tabs cannot be discarded.',
  schema: z.object({ tabIds }),
  async run({ tabIds }) {
    await getTabs(tabIds);
    const results = await Promise.allSettled(tabIds.map((t) => browser.tabs.discard(t)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = tabIds.filter((_, i) => results[i]!.status === 'rejected');
    return `Discarded ${plural(ok, 'tab')}.${failed.length ? ` Could not discard ${failed.map((t) => `T${t}`).join(', ')} (active tabs can't be discarded).` : ''}`;
  },
});

const sortTabs = defineTool({
  name: 'sort_tabs',
  title: 'Sort tabs',
  description:
    'Reorder tabs within one window. Pass tab IDs in the desired order; they are placed together starting where the first of them currently sits. Pinned tabs always stay before unpinned ones.',
  schema: z.object({
    windowId: id,
    order: z.array(id).min(1).describe('Tab IDs in the new order.'),
  }),
  async run({ windowId, order }) {
    const tabs = await getTabs(order);
    const foreign = tabs.filter((t) => t.windowId !== windowId);
    if (foreign.length) {
      throw new Error(`${foreign.map((t) => `T${t.id}`).join(', ')} are not in W${windowId}. Use move_tabs to move tabs between windows.`);
    }
    const start = Math.min(...tabs.map((t) => t.index));
    for (let i = 0; i < order.length; i++) {
      await browser.tabs.move(order[i]!, { windowId, index: start + i });
    }
    return `Reordered ${plural(order.length, 'tab')} in W${windowId}.`;
  },
});

const restoreClosed = defineTool({
  name: 'restore_closed',
  title: 'Reopen closed',
  description: 'Reopen a recently closed tab or window by its session ID from the snapshot, or the most recent one if no ID is given.',
  schema: z.object({ sessionId: z.string().optional() }),
  async run({ sessionId }) {
    const restored = await browser.sessions.restore(sessionId);
    if (restored?.tab) return `Reopened tab T${restored.tab.id} "${restored.tab.title ?? ''}".`;
    if (restored?.window) return `Reopened window W${restored.window.id} with ${plural(restored.window.tabs?.length ?? 0, 'tab')}.`;
    return 'Reopened the most recently closed item.';
  },
});

const searchBookmarks = defineTool({
  name: 'search_bookmarks',
  title: 'Search bookmarks',
  description: 'Search bookmarks and bookmark folders by words in the title or URL.',
  schema: z.object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(100).default(25),
  }),
  async run({ query, maxResults }) {
    const results = await browser.bookmarks.search(query);
    if (!results.length) return `No bookmarks match "${query}".`;
    return results
      .slice(0, maxResults)
      .map((b) => (b.url ? `bookmark ${b.id} "${b.title}" ${shortUrl(b.url, 120)}` : `folder ${b.id} "${b.title}"`))
      .join('\n') + (results.length > maxResults ? `\n(${results.length - maxResults} more not shown)` : '');
  },
});

async function findOrCreateFolder(folder: string): Promise<Browser.bookmarks.BookmarkTreeNode> {
  // Accept a folder ID or a folder title.
  try {
    const [byId] = await browser.bookmarks.get(folder);
    if (byId && !byId.url) return byId;
  } catch {
    // not an ID
  }
  const matches = (await browser.bookmarks.search({ title: folder })).filter((n) => !n.url);
  if (matches[0]) return matches[0];
  const [root] = await browser.bookmarks.getTree();
  // "Other bookmarks" is conventionally the second root child; fall back to the first.
  const parent = root?.children?.[1] ?? root?.children?.[0];
  return browser.bookmarks.create({ parentId: parent?.id, title: folder });
}

const createBookmark = defineTool({
  name: 'create_bookmark',
  title: 'Bookmark',
  description:
    'Bookmark an open tab (give tabId) or a URL (give url and title). Optionally put it in a folder by name or ID; a missing folder is created under Other bookmarks.',
  schema: z.object({
    tabId: id.optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    folder: z.string().optional(),
  }),
  async run({ tabId, url, title, folder }) {
    let bUrl = url;
    let bTitle = title;
    if (tabId !== undefined) {
      const [tab] = await getTabs([tabId]);
      bUrl = tab!.url;
      bTitle = title ?? tab!.title;
    }
    if (!bUrl) throw new Error('Give a tabId, or a url and title.');
    const parent = folder ? await findOrCreateFolder(folder) : undefined;
    const node = await browser.bookmarks.create({ url: bUrl, title: bTitle ?? bUrl, parentId: parent?.id });
    return `Bookmarked "${node.title}"${parent ? ` in folder "${parent.title}"` : ''}.`;
  },
});

const searchHistory = defineTool({
  name: 'search_history',
  title: 'Search history',
  description: 'Search browsing history by words in the title or URL. Use an empty query to list recent pages.',
  schema: z.object({
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

const getPageText = defineTool({
  name: 'get_page_text',
  title: 'Read page',
  description: "Read the visible text of a tab's page. Use when titles and URLs aren't enough to answer.",
  schema: z.object({
    tabId: id,
    maxChars: z.number().int().min(200).max(50_000).default(8_000),
  }),
  async run({ tabId, maxChars }) {
    const tab = await injectable(tabId);
    const [result] = await browser.scripting.executeScript({
      target: { tabId },
      func: () => (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim(),
    });
    const text = (result?.result as string | undefined) ?? '';
    if (!text) return `T${tabId} "${tab.title ?? ''}" has no readable text.`;
    const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n…(${text.length - maxChars} more characters)` : text;
    return `T${tabId} "${tab.title ?? ''}" ${shortUrl(tab.url, 120)}\n\n${clipped}`;
  },
});

const getPageLinks = defineTool({
  name: 'get_page_links',
  title: 'List page links',
  description: 'List the links on a tab\'s page (text and URL).',
  schema: z.object({
    tabId: id,
    maxLinks: z.number().int().min(1).max(1000).default(200),
  }),
  async run({ tabId, maxLinks }) {
    await injectable(tabId);
    const [result] = await browser.scripting.executeScript({
      target: { tabId },
      func: (limit: number) => {
        const seen = new Set<string>();
        const out: [string, string][] = [];
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
          const href = (a as HTMLAnchorElement).href;
          if (!href.startsWith('http') || seen.has(href)) continue;
          seen.add(href);
          out.push([((a as HTMLElement).innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80), href]);
          if (out.length >= limit) break;
        }
        return out;
      },
      args: [maxLinks],
    });
    const links = (result?.result as [string, string][] | undefined) ?? [];
    if (!links.length) return `No links found on T${tabId}.`;
    return links.map(([text, href]) => `"${text.replace(/\s+/g, ' ')}" ${href}`).join('\n');
  },
});

const listDownloads = defineTool({
  name: 'list_downloads',
  title: 'List downloads',
  description: 'List recent downloads, newest first, optionally filtered by words in the filename or URL.',
  schema: z.object({
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  async run({ query, limit }) {
    const items = await browser.downloads.search({
      query: query ? [query] : undefined,
      orderBy: ['-startTime'],
      limit,
    });
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

const refreshSnapshot = defineTool({
  name: 'refresh_snapshot',
  title: 'Refresh snapshot',
  description: 'Get a fresh browser snapshot (same format as the one in the request). Use after actions if you need current IDs, positions or windows.',
  schema: z.object({}),
  async run() {
    return (await buildSnapshot()).text;
  },
});

export const TOOLS: ToolDef[] = [
  moveTabs,
  newWindowWithTabs,
  focusWindow,
  setWindowState,
  mergeWindows,
  activateTab,
  openTab,
  closeTabs,
  closeWindow,
  pinTabs,
  muteTabs,
  reloadTabs,
  duplicateTab,
  discardTabs,
  sortTabs,
  restoreClosed,
  searchBookmarks,
  createBookmark,
  searchHistory,
  getPageText,
  getPageLinks,
  listDownloads,
  refreshSnapshot,
] as ToolDef[];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function toInputSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  return json as Anthropic.Tool.InputSchema;
}

/** API tool definitions, built once so the bytes are identical on every request (cache prefix). */
export const API_TOOLS: Anthropic.Tool[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: toInputSchema(t.schema),
  // Stream tool input as it is generated so the UI can show it live. With
  // this on, the API doesn't validate input, so agent.ts validates every
  // input against the zod schema before running a tool.
  eager_input_streaming: true,
}));
