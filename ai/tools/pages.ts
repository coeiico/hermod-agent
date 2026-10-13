// Tools that read the content of a page. The text they return is untrusted:
// pages can contain instructions aimed at the model.
import { z } from 'zod';
import { defineTool } from '../runtime/tools';
import { getTab, id, type Tab } from './resolve';
import { shortUrl } from './snapshot';

const RESTRICTED_URL = /^(vivaldi|chrome|edge|about|devtools|chrome-extension|view-source):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;

/** The tab, if an extension may inject a script into it. */
async function injectableTab(tabId: number): Promise<Tab> {
  const tab = await getTab(tabId);
  const url = tab.url ?? tab.pendingUrl ?? '';
  if (!url || RESTRICTED_URL.test(url)) {
    throw new Error(`Can't read ${url || 'this tab'}: browser-internal pages and extension-store pages block extensions.`);
  }
  if (tab.discarded) throw new Error(`T${tabId} is discarded (unloaded). Reload it with reload_tabs first, then try again.`);
  return tab;
}

export const getPageText = defineTool({
  name: 'get_page_text',
  title: 'Read page',
  effect: 'read',
  description: "Read the visible text of a tab's page. Use when titles and URLs aren't enough to answer.",
  input: z.object({
    tabId: id,
    maxChars: z.number().int().min(200).max(50_000).default(8_000),
  }),
  async run({ tabId, maxChars }) {
    const tab = await injectableTab(tabId);
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

export const getPageLinks = defineTool({
  name: 'get_page_links',
  title: 'List page links',
  effect: 'read',
  description: "List the links on a tab's page (text and URL).",
  input: z.object({
    tabId: id,
    maxLinks: z.number().int().min(1).max(1000).default(200),
  }),
  async run({ tabId, maxLinks }) {
    await injectableTab(tabId);
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
