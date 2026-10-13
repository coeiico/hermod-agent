// Tools that read the content of a page. The text they return is untrusted:
// pages can contain instructions aimed at the model.
import { z } from 'zod';
import { defineTool } from '../runtime/tools';
import { pageScript, type InspectTarget, type PageReply, type PageRequest } from './page-script';
import { getTab, id, type Tab } from './resolve';
import { scopedTab } from './scope';
import { shortUrl } from './snapshot';

const RESTRICTED_URL = /^(vivaldi|chrome|edge|about|devtools|chrome-extension|view-source):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;

/** The tab itself, if an extension may inject a script into it; throws otherwise. */
export function checkInjectable(tab: Tab): Tab {
  const url = tab.url ?? tab.pendingUrl ?? '';
  if (!url || RESTRICTED_URL.test(url)) {
    throw new Error(`Can't read ${url || 'this tab'}: browser-internal pages and extension-store pages block extensions.`);
  }
  if (tab.discarded) throw new Error(`T${tab.id} is discarded (unloaded). Reload it first, then try again.`);
  return tab;
}

/** The tab, if an extension may inject a script into it. */
async function injectableTab(tabId: number): Promise<Tab> {
  return checkInjectable(await getTab(tabId));
}

/** Runs one request through page-script.ts in the tab's top frame. */
export async function runInPage<T>(tabId: number, request: PageRequest): Promise<T> {
  const [result] = await browser.scripting.executeScript({ target: { tabId }, func: pageScript, args: [request] }).catch((err: unknown) => {
    throw new Error(`Couldn't reach the page in T${tabId} (${err instanceof Error ? err.message : String(err)}). It may be loading; try again.`);
  });
  const reply = result?.result as PageReply | undefined;
  if (!reply) throw new Error(`The page in T${tabId} didn't answer. It may be loading; try again.`);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value as T;
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

// ------------------------------------------------------------ seeing a page

// Screenshots are scaled down to this width: enough to read a page, far
// cheaper than a full-resolution capture.
const SCREENSHOT_WIDTH = 1280;
// The browser allows about two captures a second.
const CAPTURE_GAP_MS = 600;
let lastCapture = 0;

/** How the last screenshot of each tab maps to the page: image pixels per device pixel, and device pixels per CSS pixel. */
const screenshots = new Map<number, { scale: number; dpr: number }>();

/** Turns a point in the tab's last screenshot into CSS pixels on the page. */
export function screenshotToPage(tabId: number, x: number, y: number): { x: number; y: number } {
  const shot = screenshots.get(tabId);
  if (!shot) throw new Error(`Take a screenshot of T${tabId} first: points are in its pixels.`);
  return { x: x / shot.scale / shot.dpr, y: y / shot.scale / shot.dpr };
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function downscale(dataUrl: string): Promise<{ data: string; width: number; height: number; scale: number }> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, SCREENSHOT_WIDTH / bitmap.width);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
  return { data: await toBase64(blob), width, height, scale };
}

/** Captures a tab that is the visible page of its window, and remembers how the image maps to the page. */
async function capture(tab: Tab, notVisible: string): Promise<{ data: string; width: number; height: number }> {
  if (!tab.active) throw new Error(`T${tab.id} isn't the visible page of its window, so it can't be captured. ${notVisible}`);
  const window = await browser.windows.get(tab.windowId);
  if (window.state === 'minimized') throw new Error(`T${tab.id}'s window is minimised, so it can't be captured.`);
  const wait = lastCapture + CAPTURE_GAP_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCapture = Date.now();
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
  const { dpr } = await runInPage<{ dpr: number }>(tab.id!, { op: 'viewport' });
  const shot = await downscale(dataUrl);
  screenshots.set(tab.id!, { scale: shot.scale, dpr });
  return shot;
}

export const screenshotTab = defineTool({
  name: 'screenshot',
  title: 'Screenshot',
  effect: 'read',
  description:
    "See a tab's page as an image, as the user sees it. Use it for how a page looks or where things are on it (a layout, an image, \"the text in the top left\"); for reading text, get_page_text is cheaper. Only the active tab of a window can be captured. inspect_element takes points in this image's pixels.",
  input: z.object({ tabId: id }),
  timeoutMs: 20_000,
  async run({ tabId }) {
    const tab = await injectableTab(tabId);
    const shot = await capture(tab, 'activate_tab would show it, but that changes what the user is looking at.');
    return {
      text: `Screenshot of T${tabId} "${tab.title ?? ''}" ${shortUrl(tab.url, 120)}, ${shot.width}x${shot.height}. inspect_element takes x,y in this image's pixels.`,
      image: { mediaType: 'image/jpeg', data: shot.data },
      pageView: true,
    };
  },
});

// ------------------------------------------------------------ inspecting elements

const INSPECTS =
  'the font its text renders in (not just the CSS list), size, weight and colours, where it sits on screen, its place in the page, and its attributes (link targets, image sources)';

const inspectInput = z
  .object({
    tabId: id,
    text: z.string().min(1).max(200).optional().describe('Text the element shows, or its label. The element holding it most closely is inspected.'),
    selector: z.string().min(1).max(500).optional().describe('A CSS selector, like "h1" or "header img".'),
    ref: z.string().min(1).optional().describe('A ref from an earlier result, like k4.12.'),
    x: z.number().min(0).optional().describe("A point's x in the tab's latest screenshot (the image's pixels), with y."),
    y: z.number().min(0).optional(),
    properties: z
      .array(z.string().regex(/^-{0,2}[a-z][a-z0-9-]*$/))
      .max(20)
      .default([])
      .describe('Other CSS properties to read, like "text-shadow" or "border-radius".'),
    limit: z.number().int().min(1).max(20).default(5).describe('How many matching elements to show.'),
  })
  .refine(
    (v) => [v.text, v.selector, v.ref, v.x ?? v.y].filter((t) => t !== undefined).length === 1 && (v.x === undefined) === (v.y === undefined),
    'Give exactly one of text, selector, ref, or x and y together.',
  );

type InspectInput = z.infer<typeof inspectInput>;

function inspectTarget(input: InspectInput): InspectTarget {
  if (input.text !== undefined) return { text: input.text };
  if (input.selector !== undefined) return { selector: input.selector };
  if (input.ref !== undefined) return { ref: input.ref };
  return screenshotToPage(input.tabId, input.x!, input.y!);
}

async function inspect(input: InspectInput): Promise<string> {
  const { tabId, properties, limit } = input;
  return `T${tabId} ${await runInPage<string>(tabId, { op: 'inspect', target: inspectTarget(input), properties, limit })}`;
}

export const inspectElement = defineTool({
  name: 'inspect_element',
  title: 'Inspect element',
  effect: 'read',
  description: `Inspect elements on a tab's page: ${INSPECTS}. Use it for how something on a page looks or is built. Find them by text, a CSS selector, a ref from an earlier result, or a point in your latest screenshot of the tab.`,
  input: inspectInput,
  async run(input) {
    await injectableTab(input.tabId);
    return inspect(input);
  },
});

export const inspectPageElement = defineTool({
  name: 'inspect_element',
  title: 'Inspect element',
  effect: 'read',
  description: `Inspect elements on one of your pages: ${INSPECTS}. Use it when the outline and screenshot don't say how something looks or where it points. Find them by ref, text, a CSS selector, or a point in your latest screenshot.`,
  input: inspectInput,
  async run(input, ctx) {
    checkInjectable(await scopedTab(input.tabId, ctx));
    return inspect(input);
  },
});

// ------------------------------------------------------------ web task reading

export const readPage = defineTool({
  name: 'read_page',
  title: 'Read page',
  effect: 'read',
  description:
    "Read one of your pages as an outline of its visible elements. Each element you can act on has a ref in brackets, like [k4.12], for click, type_text and the other page tools. `interactive` lists those plus headings; `all` adds the page's text; `text` is the plain text only, for reading long content. Refs stay valid until the page changes.",
  input: z.object({
    tabId: id,
    filter: z.enum(['interactive', 'all', 'text']).default('interactive'),
    maxChars: z.number().int().min(1_000).max(40_000).default(12_000),
  }),
  async run({ tabId, filter, maxChars }, ctx) {
    checkInjectable(await scopedTab(tabId, ctx));
    const request: PageRequest = filter === 'text' ? { op: 'text', maxChars } : { op: 'outline', filter, maxChars };
    return { text: `T${tabId} ${await runInPage<string>(tabId, request)}`, pageView: true };
  },
});

export const findInPage = defineTool({
  name: 'find',
  title: 'Find on page',
  effect: 'read',
  description: 'Find elements on one of your pages whose role, label or text contains `query`, with refs. Cheaper than read_page when you know what you want.',
  input: z.object({
    tabId: id,
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(50).default(15),
  }),
  async run({ tabId, query, limit }, ctx) {
    checkInjectable(await scopedTab(tabId, ctx));
    return runInPage<string>(tabId, { op: 'find', query, limit });
  },
});

export const screenshot = defineTool({
  name: 'screenshot',
  title: 'Screenshot',
  effect: 'read',
  description:
    'See one of your pages as an image. Use it when the outline does not explain what is on screen (a canvas, a custom widget, an overlay), or to check that an action worked. The page must be the visible one in its window (show_page). Coordinates in the image are what click_at and inspect_element take.',
  input: z.object({ tabId: id }),
  timeoutMs: 20_000,
  async run({ tabId }, ctx) {
    const tab = checkInjectable(await scopedTab(tabId, ctx));
    const shot = await capture(tab, 'Call show_page first.');
    return {
      text: `Screenshot of T${tabId} "${tab.title ?? ''}" ${shortUrl(tab.url, 120)}, ${shot.width}x${shot.height}. click_at and inspect_element take x,y in this image's pixels.`,
      image: { mediaType: 'image/jpeg', data: shot.data },
      pageView: true,
    };
  },
});
