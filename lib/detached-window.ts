// Hermod popped out of the toolbar into a window of its own, which stays open
// when it loses focus. While it is open, the toolbar button and Alt+Space
// focus it instead of opening a second prompt as a popup.

const POPUP_PATH = 'popup.html';
const DETACHED_PARAM = 'detached';
const KEY = 'detachedWindowId';
const SIZE = { width: 440, height: 680 };

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

/** Opens the prompt in its own window, near where the toolbar popup sits. */
export async function popOut(): Promise<void> {
  const existing = await openWindowId();
  if (existing !== undefined) {
    await focus(existing);
    return;
  }
  const anchor = await browser.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
  const placed =
    anchor?.left !== undefined && anchor.top !== undefined && anchor.width !== undefined
      ? { left: Math.max(anchor.left, anchor.left + anchor.width - SIZE.width - 16), top: anchor.top + 80 }
      : {};
  const created = await browser.windows.create({
    url: browser.runtime.getURL(`/${POPUP_PATH}?${DETACHED_PARAM}`),
    type: 'popup',
    focused: true,
    ...SIZE,
    ...placed,
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

/** Keeps the toolbar button pointed at the popped-out window while it is open. */
export function watchDetachedWindow(): void {
  browser.action.onClicked.addListener(async () => {
    const windowId = await openWindowId();
    if (windowId !== undefined) {
      await focus(windowId);
      return;
    }
    // The window is gone without our noticing (the worker was asleep, say).
    await remember(undefined);
    await browser.action.openPopup().catch(() => {});
  });
  browser.windows.onRemoved.addListener(async (windowId) => {
    const stored = (await browser.storage.session.get(KEY))[KEY];
    if (stored === windowId) await remember(undefined);
  });
  // A window restored with the session is no longer one we track.
  browser.runtime.onStartup.addListener(() => void remember(undefined));
}
