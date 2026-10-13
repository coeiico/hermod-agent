// Hermod in a window of its own, in two forms:
//
// - Popped out: it stays open when it loses focus. While it is open, the
//   toolbar button and the shortcut bring it to the window in use instead of
//   opening a second prompt.
// - Quick: what the `open-prompt` shortcut opens, over the window in use,
//   closing when another browser window takes focus, like the toolbar popup.
//
// The quick window exists for Vivaldi, though it works in any browser: there,
// the popup can't be opened in a chosen window. Vivaldi refuses
// action.openPopup() ("Browser window has no toolbar"), and its own handling
// of the `_execute_action` shortcut can open the popup in another window. Both
// shortcuts stay in the manifest, so the user picks.

const POPUP_PATH = 'popup.html';
const DETACHED_PARAM = 'detached';
const QUICK_PARAM = 'quick';
const KEY = 'detachedWindowId';
const QUICK_KEY = 'quickWindowId';
const SIZE = { width: 440, height: 680 };

/** The manifest command that opens the quick window. */
export const OPEN_COMMAND = 'open-prompt';
/** The browser's own command that opens the toolbar popup. */
export const POPUP_COMMAND = '_execute_action';

/** Whether this page is in a window of its own (popped out or quick) rather than the toolbar popup. */
export function isDetachedPage(): boolean {
  return new URLSearchParams(location.search).has(DETACHED_PARAM);
}

/** Whether this page is the quick window the shortcut opens. */
export function isQuickPage(): boolean {
  return new URLSearchParams(location.search).has(QUICK_PARAM);
}

/** The window stored under `key`, if it is still open. */
async function storedWindow(key: string): Promise<number | undefined> {
  const stored = (await browser.storage.session.get(key))[key] as number | undefined;
  if (stored === undefined) return undefined;
  return browser.windows.get(stored).then(() => stored, () => undefined);
}

/** The popped-out window, if it is still open. */
function openWindowId(): Promise<number | undefined> {
  return storedWindow(KEY);
}

async function remember(windowId: number | undefined): Promise<void> {
  if (windowId === undefined) await browser.storage.session.remove(KEY);
  else await browser.storage.session.set({ [KEY]: windowId });
  // With no popup set, a toolbar click fires action.onClicked instead.
  await browser.action.setPopup({ popup: windowId === undefined ? POPUP_PATH : '' });
}

function focus(windowId: number) {
  return browser.windows.update(windowId, { focused: true });
}

/**
 * The window the user is in. The window flagged focused comes first: the
 * browser's last-focused window can lag behind it.
 */
async function currentWindow(): Promise<Browser.windows.Window | undefined> {
  const all = await browser.windows.getAll().catch(() => []);
  return all.find((w) => w.focused) ?? (await browser.windows.getLastFocused().catch(() => undefined));
}

/** Where the prompt window sits: the top right of the anchor window, like the toolbar popup. */
function placeBeside(anchor: Browser.windows.Window | undefined): { left?: number; top?: number } {
  if (anchor?.left === undefined || anchor.top === undefined || anchor.width === undefined) return {};
  return { left: Math.max(anchor.left, anchor.left + anchor.width - SIZE.width - 16), top: anchor.top + 80 };
}

/** Whether the centre of `inner` lies over `outer`. */
function isOver(inner: Browser.windows.Window, outer: Browser.windows.Window): boolean {
  const { left = 0, top = 0, width = 0, height = 0 } = inner;
  const x = left + width / 2;
  const y = top + height / 2;
  const o = { left: outer.left ?? 0, top: outer.top ?? 0, width: outer.width ?? 0, height: outer.height ?? 0 };
  return x >= o.left && x <= o.left + o.width && y >= o.top && y <= o.top + o.height;
}

/** Focuses the popped-out window, moving it over `anchor` when it sits over another window. */
async function bringTo(windowId: number, anchor: Browser.windows.Window | undefined): Promise<void> {
  const win = await browser.windows.get(windowId).catch(() => undefined);
  const move = win && anchor && anchor.id !== windowId && !isOver(win, anchor);
  await browser.windows.update(windowId, { focused: true, ...(move ? placeBeside(anchor) : {}) });
}

/** Opens the prompt in the window the user is in: the popped-out window if open, else the toolbar popup. */
export async function openPrompt(): Promise<void> {
  const target = await currentWindow();
  const existing = await openWindowId();
  if (existing !== undefined) {
    await bringTo(existing, target);
    return;
  }
  // The window is gone without our noticing (the worker was asleep, say).
  await remember(undefined);
  try {
    await browser.action.openPopup(target?.id === undefined ? {} : { windowId: target.id });
  } catch (err) {
    // Some browsers (Vivaldi among them) can refuse to open the popup from
    // code; a prompt in its own window beats the shortcut doing nothing.
    console.warn('[hermod] could not open the popup, popping out instead', err);
    await popOut();
  }
}

/**
 * What the keyboard shortcut does: Hermod over the window in use. The
 * popped-out window when there is one, else the quick window.
 */
export async function openQuickPrompt(): Promise<void> {
  const target = await currentWindow();
  const existing = (await openWindowId()) ?? (await storedWindow(QUICK_KEY));
  if (existing !== undefined) {
    await bringTo(existing, target);
    return;
  }
  const created = await browser.windows.create({
    url: browser.runtime.getURL(`/${POPUP_PATH}?${DETACHED_PARAM}&${QUICK_PARAM}`),
    type: 'popup',
    focused: true,
    ...SIZE,
    ...placeBeside(target),
  });
  if (created?.id !== undefined) await browser.storage.session.set({ [QUICK_KEY]: created.id });
}

/** Opens the prompt in its own window, near where the toolbar popup sits. A quick window becomes the popped-out one. */
export async function popOut(): Promise<void> {
  const anchor = await browser.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  const existing = await openWindowId();
  if (existing !== undefined) {
    await bringTo(existing, anchor);
    return;
  }
  const quick = await storedWindow(QUICK_KEY);
  if (quick !== undefined) {
    await browser.storage.session.remove(QUICK_KEY);
    const [tab] = await browser.tabs.query({ windowId: quick });
    if (tab?.id !== undefined) await browser.tabs.update(tab.id, { url: browser.runtime.getURL(`/${POPUP_PATH}?${DETACHED_PARAM}`) });
    await remember(quick);
    return;
  }
  const created = await browser.windows.create({
    url: browser.runtime.getURL(`/${POPUP_PATH}?${DETACHED_PARAM}`),
    type: 'popup',
    focused: true,
    ...SIZE,
    ...placeBeside(anchor),
  });
  await remember(created?.id);
}

/** Closes the popped-out window and opens the prompt in the toolbar again. */
export async function reattach(): Promise<void> {
  const windowId = await openWindowId();
  await remember(undefined);
  const target = await browser.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  if (windowId !== undefined) await browser.windows.remove(windowId).catch(() => {});
  if (target?.id === undefined) return;
  await focus(target.id);
  // Needs a recent Chromium; where it fails, the toolbar button works as usual.
  await browser.action.openPopup({ windowId: target.id }).catch(() => {});
}

/** Routes the toolbar button and the shortcut to the prompt in the window in use. */
export function watchDetachedWindow(): void {
  browser.action.onClicked.addListener(() => void openPrompt());
  browser.commands.onCommand.addListener((command) => {
    if (command === OPEN_COMMAND) void openQuickPrompt();
  });
  // The quick window closes when another browser window takes focus. Focus
  // leaving the browser (WINDOW_ID_NONE) is ignored: on Linux it also fires
  // in passing while focus moves between windows.
  browser.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === browser.windows.WINDOW_ID_NONE) return;
    const quick = (await browser.storage.session.get(QUICK_KEY))[QUICK_KEY] as number | undefined;
    if (quick === undefined || quick === windowId) return;
    await browser.storage.session.remove(QUICK_KEY);
    await browser.windows.remove(quick).catch(() => {});
  });
  browser.windows.onRemoved.addListener(async (windowId) => {
    const stored = await browser.storage.session.get([KEY, QUICK_KEY]);
    if (stored[KEY] === windowId) await remember(undefined);
    if (stored[QUICK_KEY] === windowId) await browser.storage.session.remove(QUICK_KEY);
  });
  // A window restored with the session is no longer one we track.
  browser.runtime.onStartup.addListener(() => void remember(undefined));
}
