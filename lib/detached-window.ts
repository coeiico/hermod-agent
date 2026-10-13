// Hermod popped out of the toolbar into a window of its own, which stays open
// when it loses focus. While it is open, the toolbar button and the shortcut
// bring it to the window in use instead of opening a second prompt as a popup.

const POPUP_PATH = 'popup.html';
const DETACHED_PARAM = 'detached';
const KEY = 'detachedWindowId';
const SIZE = { width: 440, height: 680 };

/** The manifest command that opens the prompt. */
export const OPEN_COMMAND = 'open-prompt';

/** Whether this page is the popped-out window rather than the toolbar popup. */
export function isDetachedPage(): boolean {
  return new URLSearchParams(location.search).has(DETACHED_PARAM);
}

/** The popped-out window, if it is still open. */
async function openWindowId(): Promise<number | undefined> {
  const stored = (await browser.storage.session.get(KEY))[KEY] as number | undefined;
  if (stored === undefined) return undefined;
  return browser.windows.get(stored).then(() => stored, () => undefined);
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
  await browser.action.openPopup(target?.id === undefined ? {} : { windowId: target.id }).catch(() => {});
}

/** Opens the prompt in its own window, near where the toolbar popup sits. */
export async function popOut(): Promise<void> {
  const anchor = await browser.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  const existing = await openWindowId();
  if (existing !== undefined) {
    await bringTo(existing, anchor);
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
    if (command === OPEN_COMMAND) void openPrompt();
  });
  browser.windows.onRemoved.addListener(async (windowId) => {
    const stored = (await browser.storage.session.get(KEY))[KEY];
    if (stored === windowId) await remember(undefined);
  });
  // A window restored with the session is no longer one we track.
  browser.runtime.onStartup.addListener(() => void remember(undefined));
}
