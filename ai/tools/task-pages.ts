// A web task's own pages: listing them, opening and navigating them, and
// closing the ones it opened. Everything stays inside the task's scope, and
// only http and https pages can be opened.
import { z } from 'zod';
import { defineTool } from '../runtime/tools';
import { id } from './resolve';
import { openInScope, scopedTab, scopedTabs, scopeFor } from './scope';
import { shortUrl } from './snapshot';

const webUrl = z.url({ protocol: /^https?$/ }).describe('A full http or https URL.');

/** Waits (up to a cap) for a tab to finish loading, and returns how it ended up. */
async function loaded(tabId: number): Promise<string> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
    const tab = await browser.tabs.get(tabId).catch(() => undefined);
    if (!tab) return `T${tabId} closed.`;
    if (tab.status === 'complete') return `T${tabId} "${tab.title ?? ''}" ${shortUrl(tab.url, 120)}`;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return `T${tabId} is still loading.`;
}

export const listPages = defineTool({
  name: 'list_pages',
  title: 'List pages',
  effect: 'read',
  description: 'List the pages (tabs) this task may work in: its own window, and the tab it was given.',
  input: z.object({}),
  async run(_, ctx) {
    const tabs = await scopedTabs(ctx);
    if (!tabs.length) return 'No pages yet. Open one with open_page.';
    return tabs.map((t) => `T${t.id}${t.active ? ' [visible]' : ''} "${t.title ?? ''}" ${shortUrl(t.url ?? t.pendingUrl, 120)}`).join('\n');
  },
});

export const openPage = defineTool({
  name: 'open_page',
  title: 'Open page',
  effect: 'write',
  description: "Open a URL in a new tab in this task's own window, and wait for it to load.",
  input: z.object({ url: webUrl }),
  async run({ url }, ctx) {
    const tab = await openInScope(scopeFor(ctx), url);
    return `Opened ${await loaded(tab.id!)}.`;
  },
});

export const goTo = defineTool({
  name: 'go_to',
  title: 'Go to URL',
  effect: 'write',
  description: 'Load a URL in one of your pages, replacing what it shows, and wait for it to load.',
  input: z.object({ tabId: id, url: webUrl }),
  async run({ tabId, url }, ctx) {
    await scopedTab(tabId, ctx);
    await browser.tabs.update(tabId, { url });
    return `Loaded ${await loaded(tabId)}.`;
  },
});

export const goBack = defineTool({
  name: 'go_back',
  title: 'Back or forward',
  effect: 'write',
  description: "Go back (or forward) one page in one of your pages' history.",
  input: z.object({ tabId: id, direction: z.enum(['back', 'forward']).default('back') }),
  async run({ tabId, direction }, ctx) {
    await scopedTab(tabId, ctx);
    await (direction === 'back' ? browser.tabs.goBack(tabId) : browser.tabs.goForward(tabId));
    return `Went ${direction}: ${await loaded(tabId)}.`;
  },
});

export const showPage = defineTool({
  name: 'show_page',
  title: 'Show page',
  effect: 'write',
  description: "Make one of your pages the visible tab of its window (screenshots need that). It doesn't focus the window.",
  input: z.object({ tabId: id }),
  async run({ tabId }, ctx) {
    const tab = await scopedTab(tabId, ctx);
    await browser.tabs.update(tabId, { active: true });
    return `T${tabId} "${tab.title ?? ''}" is now the visible tab of its window.`;
  },
});

export const closePage = defineTool({
  name: 'close_page',
  title: 'Close page',
  effect: 'write',
  description: 'Close a page this task opened. Pages the user had open are not closed.',
  input: z.object({ tabId: id }),
  async run({ tabId }, ctx) {
    const scope = scopeFor(ctx);
    const tab = await scopedTab(tabId, ctx);
    if (!scope.opened.has(tabId) && tab.windowId !== scope.windowId) {
      throw new Error(`T${tabId} was open before this task started, so the task can't close it.`);
    }
    await browser.tabs.remove(tabId);
    scope.opened.delete(tabId);
    return `Closed T${tabId} "${tab.title ?? ''}".`;
  },
});
