// Writing to the clipboard from the service worker, which has no DOM to copy
// from: a hidden offscreen document does the copy and answers the message.

export const CLIPBOARD_TARGET = 'hermod-clipboard';

export interface ClipboardRequest {
  target: typeof CLIPBOARD_TARGET;
  text: string;
}

const OFFSCREEN_PATH = '/offscreen.html';
let creating: Promise<void> | undefined;

async function ensureOffscreenDocument(): Promise<void> {
  const existing = await browser.runtime.getContexts({
    contextTypes: [browser.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [browser.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (existing.length) return;
  // Two copies at once must not both try to create it; only one may exist.
  creating ??= browser.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [browser.offscreen.Reason.CLIPBOARD],
      justification: 'Copy tab links to the clipboard when the user asks.',
    })
    .finally(() => (creating = undefined));
  await creating;
}

export async function writeClipboard(text: string): Promise<void> {
  await ensureOffscreenDocument();
  const request: ClipboardRequest = { target: CLIPBOARD_TARGET, text };
  const copied = (await browser.runtime.sendMessage(request)) as boolean | undefined;
  if (copied !== true) throw new Error('The browser refused the clipboard write.');
}
