// Tools that act on tabs.
import { z } from 'zod';
import { defineTool } from '../runtime/tools';
import { writeClipboard } from './clipboard';
import { describeTabs, getTab, getTabs, getWindow, id, plural, tabIds } from './resolve';
import { shortUrl } from './snapshot';

export const moveTabs = defineTool({
  name: 'move_tabs',
  title: 'Move tabs',
  effect: 'write',
  description:
    'Move one or more tabs to a window (the same or another one) at a position. Tabs keep the order given. Use this for every "move these tabs" request in a single call.',
  input: z.object({
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

export const activateTab = defineTool({
  name: 'activate_tab',
  title: 'Switch to tab',
  effect: 'write',
  description: 'Make a tab the active tab in its window and focus that window.',
  input: z.object({ tabId: id }),
  async run({ tabId }) {
    const tab = await getTab(tabId);
    await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    return `Switched to T${tabId} "${tab.title ?? ''}" in W${tab.windowId}.`;
  },
});

export const openTab = defineTool({
  name: 'open_tab',
  title: 'Open tab',
  effect: 'write',
  description: 'Open a new tab with a URL. Defaults to the focused window, at the end, made active.',
  input: z.object({
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

export const closeTabs = defineTool({
  name: 'close_tabs',
  title: 'Close tabs',
  effect: 'destructive',
  description:
    'Close one or more tabs. Depending on their settings, the user may be asked to confirm first. Closed tabs can be brought back with restore_closed.',
  input: z.object({ tabIds }),
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

export const pinTabs = defineTool({
  name: 'pin_tabs',
  title: 'Pin tabs',
  effect: 'write',
  description: 'Pin (value true) or unpin (value false) tabs.',
  input: z.object({ tabIds, value: z.boolean() }),
  async run({ tabIds, value }) {
    await getTabs(tabIds);
    await Promise.all(tabIds.map((t) => browser.tabs.update(t, { pinned: value })));
    return `${value ? 'Pinned' : 'Unpinned'} ${plural(tabIds.length, 'tab')}.`;
  },
});

export const muteTabs = defineTool({
  name: 'mute_tabs',
  title: 'Mute tabs',
  effect: 'write',
  description: 'Mute (value true) or unmute (value false) tabs.',
  input: z.object({ tabIds, value: z.boolean() }),
  async run({ tabIds, value }) {
    await getTabs(tabIds);
    await Promise.all(tabIds.map((t) => browser.tabs.update(t, { muted: value })));
    return `${value ? 'Muted' : 'Unmuted'} ${plural(tabIds.length, 'tab')}.`;
  },
});

export const reloadTabs = defineTool({
  name: 'reload_tabs',
  title: 'Reload tabs',
  effect: 'write',
  description: 'Reload tabs. bypassCache does a hard reload.',
  input: z.object({ tabIds, bypassCache: z.boolean().default(false) }),
  async run({ tabIds, bypassCache }) {
    await getTabs(tabIds);
    await Promise.all(tabIds.map((t) => browser.tabs.reload(t, { bypassCache })));
    return `Reloaded ${plural(tabIds.length, 'tab')}${bypassCache ? ' (bypassing cache)' : ''}.`;
  },
});

export const duplicateTab = defineTool({
  name: 'duplicate_tab',
  title: 'Duplicate tab',
  effect: 'write',
  description: 'Duplicate a tab next to the original.',
  input: z.object({ tabId: id }),
  async run({ tabId }) {
    await getTab(tabId);
    const copy = await browser.tabs.duplicate(tabId);
    return `Duplicated T${tabId} as T${copy?.id}.`;
  },
});

export const discardTabs = defineTool({
  name: 'discard_tabs',
  title: 'Unload tabs',
  effect: 'write',
  description: 'Unload tabs from memory without closing them (they reload when clicked). Active tabs cannot be discarded.',
  input: z.object({ tabIds }),
  async run({ tabIds }) {
    await getTabs(tabIds);
    const results = await Promise.allSettled(tabIds.map((t) => browser.tabs.discard(t)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = tabIds.filter((_, i) => results[i]!.status === 'rejected');
    return `Discarded ${plural(ok, 'tab')}.${failed.length ? ` Could not discard ${failed.map((t) => `T${t}`).join(', ')} (active tabs can't be discarded).` : ''}`;
  },
});

export const sortTabs = defineTool({
  name: 'sort_tabs',
  title: 'Sort tabs',
  effect: 'write',
  description:
    'Reorder tabs within one window. Pass tab IDs in the desired order; they are placed together starting where the first of them currently sits. Pinned tabs always stay before unpinned ones.',
  input: z.object({
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

export const navigateTab = defineTool({
  name: 'navigate_tab',
  title: 'Go to URL',
  effect: 'write',
  description: 'Load a URL in an existing tab, replacing the page it shows. Use open_tab to open it in a new tab instead.',
  input: z.object({
    tabId: id,
    url: z.string().min(1).describe('Full URL including https://'),
  }),
  async run({ tabId, url }) {
    const tab = await getTab(tabId);
    await browser.tabs.update(tabId, { url });
    return `Loaded ${shortUrl(url, 120)} in T${tabId} (was "${tab.title ?? ''}").`;
  },
});

export const goBackOrForward = defineTool({
  name: 'go_back_or_forward',
  title: 'Back or forward',
  effect: 'write',
  description: "Go back or forward one page in a tab's history, like the browser's back and forward buttons.",
  input: z.object({ tabId: id, direction: z.enum(['back', 'forward']) }),
  async run({ tabId, direction }) {
    await getTab(tabId);
    await (direction === 'back' ? browser.tabs.goBack(tabId) : browser.tabs.goForward(tabId));
    return `Went ${direction} in T${tabId}.`;
  },
});

export const zoomTabs = defineTool({
  name: 'zoom_tabs',
  title: 'Zoom tabs',
  effect: 'write',
  description:
    'Set the zoom level of tabs. The browser remembers zoom per site, so other tabs on the same site change too.',
  input: z.object({
    tabIds,
    zoom: z
      .union([z.number().int().min(25).max(500), z.literal('default')])
      .describe('Zoom in percent, such as 150, or "default" to reset.'),
  }),
  async run({ tabIds, zoom }) {
    await getTabs(tabIds);
    // 0 resets to the browser's default zoom.
    const factor = zoom === 'default' ? 0 : zoom / 100;
    const results = await Promise.allSettled(tabIds.map((t) => browser.tabs.setZoom(t, factor)));
    const failed = tabIds.filter((_, i) => results[i]!.status === 'rejected');
    const ok = tabIds.length - failed.length;
    const level = zoom === 'default' ? 'the default' : `${zoom}%`;
    return `Set ${plural(ok, 'tab')} to ${level} zoom.${failed.length ? ` Could not zoom ${failed.map((t) => `T${t}`).join(', ')} (browser-internal pages can't be zoomed by extensions).` : ''}`;
  },
});

function markdownLink(title: string, url: string): string {
  // A parenthesis in the URL would end the Markdown link early.
  const safeUrl = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `- [${title.replace(/[[\]]/g, '\\$&')}](${safeUrl})`;
}

export const copyTabs = defineTool({
  name: 'copy_tabs',
  title: 'Copy tabs',
  effect: 'write',
  description:
    "Copy tabs' full URLs to the clipboard in the order given: one URL per line, each title above its URL, or a Markdown list of links.",
  input: z.object({
    tabIds,
    format: z.enum(['urls', 'titles_and_urls', 'markdown']).default('urls'),
  }),
  async run({ tabIds, format }) {
    const tabs = await getTabs(tabIds);
    const entries = tabs.map((t) => {
      const url = t.url || t.pendingUrl || '';
      const title = t.title || url;
      if (format === 'markdown') return markdownLink(title, url);
      return format === 'titles_and_urls' ? `${title}\n${url}` : url;
    });
    await writeClipboard(entries.join(format === 'titles_and_urls' ? '\n\n' : '\n'));
    return `Copied ${plural(tabs.length, 'tab')} to the clipboard (${describeTabs(tabs)}).`;
  },
});
