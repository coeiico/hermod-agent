// The hidden page that copies text for the background worker (see
// ai/tools/clipboard.ts). It ignores every other message, so the worker's own
// replies to the popup are unaffected.
import { CLIPBOARD_TARGET, type ClipboardRequest } from '@/ai/tools/clipboard';

browser.runtime.onMessage.addListener((msg: ClipboardRequest, _sender, sendResponse) => {
  if (msg?.target !== CLIPBOARD_TARGET) return;
  // navigator.clipboard needs a focused document, which this page never is;
  // execCommand works with the clipboardWrite permission.
  const area = document.createElement('textarea');
  area.value = msg.text;
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  sendResponse(copied);
});
