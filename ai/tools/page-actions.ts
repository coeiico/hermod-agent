// Tools that act inside a web task's pages: click, type, choose, press keys,
// scroll and wait. Each action resolves its target to a real element, checks
// it against the guardrails, asks when the approval mode says to, acts, and
// then waits for the page to settle and says what changed.
import { z } from 'zod';
import { defineTool, ToolRefusal, type Confirmation, type ToolRunContext } from '../runtime/tools';
import { refusal, risk, type PageAction } from './page-guardrails';
import type { DescribedElement, PageKey } from './page-script';
import { checkInjectable, runInPage, screenshotToPage } from './pages';
import { id, type Tab } from './resolve';
import { scopedTab } from './scope';
import { shortUrl } from './snapshot';

const ref = z.string().min(1).describe('An element ref from read_page or find, like k4.12.');
const consequential = z
  .boolean()
  .default(false)
  .describe('True when this spends money, sends or publishes something, changes account settings, or cannot be undone.');

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function hostOf(tab: Tab): string {
  try {
    return new URL(tab.url ?? '').host || 'this page';
  } catch {
    return 'this page';
  }
}

async function describeRef(tabId: number, elementRef: string, ctx: ToolRunContext): Promise<{ tab: Tab; el: DescribedElement }> {
  const tab = checkInjectable(await scopedTab(tabId, ctx));
  return { tab, el: await runInPage<DescribedElement>(tabId, { op: 'describe', ref: elementRef }) };
}

async function describePoint(tabId: number, x: number, y: number, ctx: ToolRunContext): Promise<{ tab: Tab; el: DescribedElement }> {
  const tab = checkInjectable(await scopedTab(tabId, ctx));
  const point = screenshotToPage(tabId, x, y);
  return { tab, el: await runInPage<DescribedElement>(tabId, { op: 'at-point', ...point }) };
}

/** Throws a refusal when any of the actions crosses a guardrail. */
function guard(el: DescribedElement, actions: PageAction[]): void {
  for (const action of actions) {
    const why = refusal(el.descriptor, action);
    if (why) throw new ToolRefusal(why);
  }
}

/** The approval question for these actions on this element. A refused action asks nothing: its run refuses. */
function approval(el: DescribedElement, actions: PageAction[], question: string, isConsequential: boolean): Confirmation {
  if (actions.some((a) => refusal(el.descriptor, a))) return null;
  const levels = actions.map((a) => risk(el.descriptor, a));
  if (levels.includes('always')) return { question, when: 'always' };
  if (levels.includes('submit') || isConsequential) return { question, when: 'auto' };
  return { question, when: 'ask' };
}

interface Before {
  url?: string;
  title?: string;
  /** Tabs this tab had already opened. */
  children: Set<number | undefined>;
}

async function before(tabId: number): Promise<Before> {
  const [tab, all] = await Promise.all([browser.tabs.get(tabId), browser.tabs.query({})]);
  return { url: tab.url, title: tab.title, children: new Set(all.filter((t) => t.openerTabId === tabId).map((t) => t.id)) };
}

/**
 * Waits for the page to finish what the action started (a navigation, then a
 * quiet DOM, each capped) and describes what changed, as " Then …" or "".
 */
async function settle(tabId: number, was: Before, signal: AbortSignal): Promise<string> {
  await sleep(200, signal);
  let tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab) return ' The tab closed.';
  for (const deadline = Date.now() + 10_000; tab.status === 'loading' && Date.now() < deadline; ) {
    await sleep(250, signal);
    tab = await browser.tabs.get(tabId).catch(() => undefined);
    if (!tab) return ' The tab closed.';
  }
  // A quiet DOM matters for single-page apps; a page that never settles is
  // still usable, so failing to wait is not an error.
  await runInPage(tabId, { op: 'quiet' }).catch(() => undefined);
  tab = (await browser.tabs.get(tabId).catch(() => undefined)) ?? tab;

  const changes: string[] = [];
  if (tab.url !== was.url) changes.push(`the page navigated to ${shortUrl(tab.url, 120)}`);
  if (tab.title !== was.title) changes.push(`its title is now "${tab.title ?? ''}"`);
  if (tab.status === 'loading') changes.push('it is still loading');
  const opened = (await browser.tabs.query({})).filter((t) => t.openerTabId === tabId && !was.children.has(t.id));
  for (const t of opened) changes.push(`it opened T${t.id} "${t.title || t.pendingUrl || t.url || ''}"`);
  return changes.length ? ` Then ${changes.join('; ')}.` : '';
}

async function clickElement(tabId: number, el: DescribedElement, signal: AbortSignal): Promise<string> {
  guard(el, ['click']);
  const was = await before(tabId);
  await runInPage(tabId, { op: 'click', ref: el.ref });
  return `Clicked ${el.label}.${await settle(tabId, was, signal)}`;
}

export const click = defineTool({
  name: 'click',
  title: 'Click',
  effect: 'write',
  description: 'Click an element by its ref. Checkboxes, radios and custom dropdown options are clicked too.',
  input: z.object({ tabId: id, ref, consequential }),
  async confirm({ tabId, ref, consequential }, ctx) {
    const { tab, el } = await describeRef(tabId, ref, ctx);
    return approval(el, ['click'], `Click ${el.label} on ${hostOf(tab)}?`, consequential);
  },
  async run({ tabId, ref }, ctx) {
    const { el } = await describeRef(tabId, ref, ctx);
    return clickElement(tabId, el, ctx.signal);
  },
});

export const clickAt = defineTool({
  name: 'click_at',
  title: 'Click at point',
  effect: 'write',
  description:
    "Click the element at a point in the tab's last screenshot (x, y in the image's pixels). Use only when the element has no ref: prefer click. The result names the element that was clicked.",
  input: z.object({ tabId: id, x: z.number().min(0), y: z.number().min(0), consequential }),
  async confirm({ tabId, x, y, consequential }, ctx) {
    const { tab, el } = await describePoint(tabId, x, y, ctx);
    return approval(el, ['click'], `Click ${el.label} on ${hostOf(tab)}?`, consequential);
  },
  async run({ tabId, x, y }, ctx) {
    const { el } = await describePoint(tabId, x, y, ctx);
    return clickElement(tabId, el, ctx.signal);
  },
});

function typeActions(submit: boolean): PageAction[] {
  return submit ? ['type', 'enter'] : ['type'];
}

export const typeText = defineTool({
  name: 'type_text',
  title: 'Type',
  effect: 'write',
  description:
    'Type into a text field or editor by its ref. `clear` replaces what is there; otherwise the text is added at the end. `submit` presses Enter afterwards, which usually submits the form.',
  input: z.object({
    tabId: id,
    ref,
    text: z.string().max(5_000),
    clear: z.boolean().default(true),
    submit: z.boolean().default(false),
    consequential,
  }),
  async confirm({ tabId, ref, text, submit, consequential }, ctx) {
    const { tab, el } = await describeRef(tabId, ref, ctx);
    const shown = text.length > 60 ? `${text.slice(0, 59)}…` : text;
    return approval(el, typeActions(submit), `Type "${shown}" into ${el.label}${submit ? ' and submit' : ''} on ${hostOf(tab)}?`, consequential);
  },
  async run({ tabId, ref, text, clear, submit }, ctx) {
    const { el } = await describeRef(tabId, ref, ctx);
    guard(el, typeActions(submit));
    const was = await before(tabId);
    let result = await runInPage<string>(tabId, { op: 'type', ref, text, clear });
    if (submit) result += ` ${await runInPage<string>(tabId, { op: 'key', key: 'Enter', ref })}`;
    return `Typed into ${el.label}. ${result}${await settle(tabId, was, ctx.signal)}`;
  },
});

export const selectOption = defineTool({
  name: 'select_option',
  title: 'Choose option',
  effect: 'write',
  description: 'Choose an option in a <select> dropdown by its ref, by the option\'s text or value. For custom dropdowns, click to open them and click the option.',
  input: z.object({ tabId: id, ref, option: z.string().min(1), consequential }),
  async confirm({ tabId, ref, option, consequential }, ctx) {
    const { tab, el } = await describeRef(tabId, ref, ctx);
    return approval(el, ['select'], `Choose "${option}" in ${el.label} on ${hostOf(tab)}?`, consequential);
  },
  async run({ tabId, ref, option }, ctx) {
    const { el } = await describeRef(tabId, ref, ctx);
    guard(el, ['select']);
    const was = await before(tabId);
    const result = await runInPage<string>(tabId, { op: 'select', ref, option });
    return `${result} in ${el.label}.${await settle(tabId, was, ctx.signal)}`;
  },
});

const KEYS = [
  'Enter', 'Escape', 'Tab', 'Shift+Tab', 'Space', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End',
] as const satisfies readonly PageKey[];

/** What pressing this key on this element amounts to, for the guardrails. */
function keyActions(key: PageKey, el: DescribedElement): PageAction[] {
  if (key !== 'Enter' && key !== 'Space') return [];
  const { tag, type } = el.descriptor;
  const field = tag === 'textarea' || tag === 'select' || (tag === 'input' && !['button', 'submit', 'reset', 'image', 'checkbox', 'radio'].includes(type ?? ''));
  if (field) return key === 'Enter' ? ['enter'] : [];
  return ['click'];
}

export const pressKey = defineTool({
  name: 'press_key',
  title: 'Press key',
  effect: 'write',
  description:
    'Press a key on an element by its ref, or on whatever has focus. Enter and Space need a ref: Enter in a field submits its form, and on a button presses it. Escape closes dialogs and menus; arrows, PageUp/PageDown, Home and End move or scroll.',
  input: z
    .object({ tabId: id, key: z.enum(KEYS), ref: ref.optional(), consequential })
    .refine((v) => v.ref !== undefined || (v.key !== 'Enter' && v.key !== 'Space'), 'Enter and Space need a ref.'),
  async confirm({ tabId, key, ref, consequential }, ctx) {
    if (!ref) return { question: `Press ${key}?`, when: consequential ? 'auto' : 'ask' };
    const { tab, el } = await describeRef(tabId, ref, ctx);
    return approval(el, keyActions(key, el), `Press ${key} on ${el.label} on ${hostOf(tab)}?`, consequential);
  },
  async run({ tabId, key, ref }, ctx) {
    let label = 'the focused element';
    if (ref) {
      const { el } = await describeRef(tabId, ref, ctx);
      guard(el, keyActions(key, el));
      label = el.label;
    } else {
      checkInjectable(await scopedTab(tabId, ctx));
    }
    const was = await before(tabId);
    const result = await runInPage<string>(tabId, { op: 'key', key, ref });
    return `Pressed ${key} on ${label}. ${result}${await settle(tabId, was, ctx.signal)}`;
  },
});

export const scrollPage = defineTool({
  name: 'scroll',
  title: 'Scroll',
  effect: 'read',
  description: 'Scroll one of your pages up or down by most of a screen, to the top or bottom, or until an element (by ref) is in view.',
  input: z.object({ tabId: id, direction: z.enum(['up', 'down', 'top', 'bottom']).optional(), ref: ref.optional() }),
  async run({ tabId, direction, ref }, ctx) {
    checkInjectable(await scopedTab(tabId, ctx));
    return runInPage<string>(tabId, { op: 'scroll', direction, ref });
  },
});

export const waitFor = defineTool({
  name: 'wait_for',
  title: 'Wait for',
  effect: 'read',
  description: 'Wait until text appears on one of your pages, or an element (by ref) is visible, for up to `seconds`. Use after an action that loads content slowly.',
  input: z
    .object({ tabId: id, text: z.string().min(1).optional(), ref: ref.optional(), seconds: z.number().min(1).max(20).default(10) })
    .refine((v) => v.text !== undefined || v.ref !== undefined, 'Give text or a ref to wait for.'),
  async run({ tabId, text, ref, seconds }, ctx) {
    checkInjectable(await scopedTab(tabId, ctx));
    const what = text !== undefined ? `"${text}"` : ref!;
    for (const deadline = Date.now() + seconds * 1000; Date.now() < deadline; ) {
      // While a page loads, the script may not run yet; keep polling.
      const found = await runInPage<boolean>(tabId, { op: 'has', text, ref }).catch(() => false);
      if (found) return `${what} is on the page.`;
      await sleep(400, ctx.signal);
    }
    throw new Error(`${what} did not appear within ${seconds} seconds.`);
  },
});
