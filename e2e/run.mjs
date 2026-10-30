// End-to-end run of the built extension in headless Chromium: a command that
// delegates to a web task on a local shop (site.mjs), a steer while it works,
// the guardrails, approvals inside a web task, two threads at once, and the
// popup rendering it all. The Claude API is answered by the scripted model in
// model.mjs through CDP request interception, with a fake key: nothing leaves
// the machine and no API credit is spent.
//
// Run with `npm run e2e` (it builds first). It needs a Chromium that still
// accepts --load-extension, which branded Chrome no longer does: by default
// Playwright's, installed with `npx playwright install chromium`, or any
// Chromium named by HERMOD_E2E_CHROME. The popup screenshot and the logs go
// to .output/e2e/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, sleep } from './cdp.mjs';
import { createModel } from './model.mjs';
import { startSite } from './site.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, '.output/chrome-mv3');
const OUT = join(ROOT, '.output/e2e');

/** HERMOD_E2E_CHROME, else the newest Chromium Playwright has installed. */
function findChromium() {
  if (process.env.HERMOD_E2E_CHROME) return process.env.HERMOD_E2E_CHROME;
  const cache = join(homedir(), '.cache/ms-playwright');
  const builds = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)) : [];
  builds.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  const found = builds.map((d) => join(cache, d, 'chrome-linux/chrome')).find(existsSync);
  if (!found) {
    console.error('No Chromium found. Run `npx playwright install chromium`, or set HERMOD_E2E_CHROME to a Chromium binary.');
    process.exit(1);
  }
  return found;
}

if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error('No build in .output/chrome-mv3. Run `npm run build` first (`npm run e2e` does).');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const CHROME = findChromium();
const log = (...a) => console.log('[e2e]', ...a);
const failures = [];
const check = (ok, what) => {
  log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const { server, base } = await startSite();
const profile = mkdtempSync(join(tmpdir(), 'hermod-e2e-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${EXT}`,
  `--load-extension=${EXT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1280,900',
  // Headless Chromium reports no mouse, and Tailwind applies hover styles only
  // where a pointer can hover: report a desktop mouse (hover, fine pointer).
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
  `${base}/shop`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
chrome.stderr.on('data', (d) => (stderr += d));

try {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const cdp = new CDP(`ws://127.0.0.1:${port}${path}`);
  await cdp.ready();

  // ------------------------------------------------ the extension's worker
  let sw;
  for (let i = 0; i < 100 && !sw; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
    if (!sw) await sleep(100);
  }
  if (!sw) throw new Error('extension service worker not found');
  const extId = new URL(sw.url).host;
  log('extension', extId);
  const swSession = await cdp.attach(sw.targetId);
  const swErrors = [];
  const swLogs = [];
  cdp.on((msg) => {
    if (msg.sessionId !== swSession) return;
    if (msg.method === 'Runtime.exceptionThrown') swErrors.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
    if (msg.method === 'Runtime.consoleAPICalled') {
      const line = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      swLogs.push(`${msg.params.type}: ${line}`);
      if (msg.params.type === 'error') swErrors.push(line.slice(0, 400));
    }
  });
  await cdp.send('Runtime.enable', {}, swSession);

  // ------------------------------------------------ the fake Claude API
  const model = createModel(log, base);
  let apiCalls = 0;
  let taskCalls = 0;
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://api.anthropic.com/*' }] }, swSession);
  cdp.on(async (msg) => {
    if (msg.method !== 'Fetch.requestPaused' || msg.sessionId !== swSession) return;
    const { requestId, request } = msg.params;
    let raw = request.postData;
    if (!raw && request.postDataEntries) raw = Buffer.concat(request.postDataEntries.map((e) => Buffer.from(e.bytes, 'base64'))).toString('utf8');
    const body = JSON.parse(raw);
    apiCalls++;
    const isTask = model.isTask(body);
    if (isTask) taskCalls++;
    // Hold the web task for a moment mid-way, so a steer can arrive while it works.
    if (isTask && body.messages.filter((m) => m.role === 'assistant').length === 6) await sleep(3500);
    if (!isTask && model.commandOf(body).startsWith('slow ')) await sleep(3000);
    const sse = model.reply(body);
    await cdp.send(
      'Fetch.fulfillRequest',
      { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/event-stream' }], body: Buffer.from(sse).toString('base64') },
      swSession,
    );
  });

  // ------------------------------------------------ an extension page to talk to the worker
  const { targetId: ctlTarget } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
  const ctl = await cdp.attach(ctlTarget);
  await sleep(800);
  const saved = await cdp.evaluate(ctl, `chrome.runtime.sendMessage({ type: 'save-key', apiKey: 'sk-ant-test-local-only', passphrase: 'dank memes' })`);
  check(saved?.ok === true, 'saved a test key in the vault');
  await cdp.evaluate(
    ctl,
    `(() => {
      window.__msgs = [];
      window.__port = chrome.runtime.connect({ name: 'hermod-popup' });
      window.__port.onMessage.addListener((m) => window.__msgs.push(m));
      return true;
    })()`,
  );
  await sleep(300);
  const lastState = () => cdp.evaluate(ctl, `JSON.parse(JSON.stringify(window.__msgs.filter((m) => m.type === 'state').at(-1) ?? null))`);
  const send = (m) => cdp.evaluate(ctl, `window.__port.postMessage(${JSON.stringify(m)}), true`);

  // ------------------------------------------------ the command
  await send({ type: 'run', command: 'add the 1kg bag of this coffee to my cart' });
  let state;
  let taskStarted = false;
  for (let i = 0; i < 50 && !taskStarted; i++) {
    taskStarted = await cdp.evaluate(ctl, `window.__msgs.some((m) => m.type === 'update' && m.update.type === 'task-start')`);
    if (!taskStarted) await sleep(100);
  }
  state = await lastState();
  check(taskStarted, 'the command started a web task');
  const threadId = state.thread.id;
  check(['running', 'waiting'].includes(state.activity[threadId]), `thread activity while working: ${state.activity[threadId]}`);

  // A follow-up sent while it runs is queued; Steer sends it in.
  await sleep(1500);
  await send({ type: 'run', command: 'use test@example.com for the email' });
  for (let i = 0; i < 30 && !(state?.queue?.length); i++) {
    await sleep(100);
    state = await lastState();
  }
  check(state.queue.length === 1, 'the follow-up was queued, not run');
  await send({ type: 'steer', queuedId: state.queue[0].id });

  // Wait for the command to finish.
  for (let i = 0; i < 300; i++) {
    state = await lastState();
    if (!state.run && state.thread?.turns?.length) break;
    await sleep(100);
  }
  const turn = state.thread.turns.at(-1);
  check(turn?.status === 'done', `the command finished: ${turn?.status} ${turn?.error ?? ''}`);
  check(model.state.steeredMain, 'the steer reached the main agent while it waited');
  check(model.state.taskSawSteer, 'the main agent passed the steer to the web task');
  const task = Object.values(turn.tasks ?? {})[0];
  check(task?.needsUser === true && /Left for you/.test(task?.summary ?? ''), 'the web task reported needs_user with what is left');

  // Guardrails and actions, from what the web task saw.
  const results = model.state.results.map(([who, r]) => `${who}: ${r}`).join('\n');
  check(/refused: Hermod never enters payment card details/.test(results), 'typing a card number was refused');
  check(/refused: .*Place order.*final order or payment step/.test(results), 'pressing Place order was refused');
  check(/Clicked radio "1 kg"/.test(results), 'clicked the 1 kg radio');
  check(/Clicked button "Add to cart"/.test(results), 'clicked Add to cart');
  check(/The field now reads "test@example.com"/.test(results), 'typed the email');
  check(/Screenshot of T\d+/.test(results), 'took a screenshot');
  check(/Opened T\d+ "Your cart"/.test(results), 'opened a page in its own window');
  check(/\[\w+\.\d+\] clickable "Gift wrap"/.test(results), 'outline found a pointer-cursor div');

  // The page itself.
  const { targetInfos } = await cdp.send('Target.getTargets');
  const shopTarget = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(base));
  const shop = await cdp.attach(shopTarget.targetId);
  const page = await cdp.evaluate(shop, `({ title: document.title, model: document.getElementById('model')?.textContent, cart: localStorage.cart, card: document.querySelector('[name=cardnumber]')?.value })`);
  check(page.cart?.includes('yirgacheffe-1kg'), `the cart holds the 1 kg bag (${page.cart})`);
  check(page.model === 'test@example.com', `the page's own model saw the typed email (${page.model})`);
  check(page.title !== 'ORDER PLACED' && !page.card, 'no order placed and no card typed');

  // Steer shown in the transcript, as read.
  const steerPart = turn.messages[1].parts.find((p) => p.type === 'data-steer');
  check(steerPart?.data?.state === 'read', `the steer shows as read (${steerPart?.data?.state})`);
  check(state.queue.length === 0, 'the queue is empty after the steer');

  // Thread news: finished while a popup was connected, so it's read.
  check(!state.activity[threadId], `no dot for a thread finished in front of the user (${state.activity[threadId]})`);

  // ------------------------------------------------ concurrency and unread
  // A slow command in one thread and a quick one in another run at once. The
  // slow one finishes while the other thread is open: it ends unread.
  await send({ type: 'new-thread' });
  await sleep(200);
  await send({ type: 'run', command: 'slow command in thread A' });
  await sleep(500);
  const threadA = (await lastState()).thread.id;
  await send({ type: 'new-thread' });
  await sleep(200);
  await send({ type: 'run', command: 'quick command in thread B' });
  let both = false;
  for (let i = 0; i < 30 && !both; i++) {
    await sleep(100);
    // The quick command can start and finish between polls, so look at every state the worker sent.
    both = await cdp.evaluate(ctl, `window.__msgs.some((m) => m.type === 'state' && Object.values(m.activity).filter((v) => v === 'running').length === 2)`);
  }
  check(both, 'two threads ran at the same time');
  for (let i = 0; i < 60; i++) {
    state = await lastState();
    if (state.activity[threadA] === 'done') break;
    await sleep(100);
  }
  check(state.activity[threadA] === 'done', `the slow thread finished out of view shows as unread (${state.activity[threadA]})`);
  check(!state.activity[state.thread.id], 'the open thread, finished in view, has no dot');
  await send({ type: 'open-thread', threadId: threadA });
  await sleep(300);
  state = await lastState();
  check(!state.activity[threadA], 'opening the thread marks it read');

  // ------------------------------------------------ approvals inside a web task
  // In "Don't ask", a Send button still asks; the question comes from inside the
  // web task, and the answer reaches it.
  await cdp.send('Page.navigate', { url: `${base}/shop` }, shop);
  await sleep(800);
  await cdp.evaluate(ctl, `chrome.storage.local.set({ settings: { approvalMode: 'never' } }).then(() => true)`);
  await send({ type: 'new-thread' });
  await sleep(200);
  await send({ type: 'run', command: 'feedback on this shop' });
  let request;
  for (let i = 0; i < 50 && !request; i++) {
    await sleep(100);
    request = await cdp.evaluate(
      ctl,
      `(() => { const m = window.__msgs.find((m) => m.type === 'update' && m.update.type === 'task-update' && m.update.update.type === 'tool-approval-request'); return m ? m.update.update : null; })()`,
    );
  }
  check(!!request && /Send feedback/.test(request.reason), `Don't ask still asked before Send feedback (${request?.reason})`);
  const sentBefore = await cdp.evaluate(shop, `document.getElementById('feedback').textContent`);
  check(sentBefore === 'Send feedback', 'nothing was clicked before the answer');
  if (request) await send({ type: 'approve', approvalId: request.approvalId, approved: true });
  for (let i = 0; i < 50; i++) {
    state = await lastState();
    if (!state.run && state.thread?.turns?.length) break;
    await sleep(100);
  }
  const sentAfter = await cdp.evaluate(shop, `document.getElementById('feedback').textContent`);
  check(sentAfter === 'Feedback sent', 'approving let the click through');

  // In "Bypass all" the same Send button asks nothing.
  await cdp.send('Page.navigate', { url: `${base}/shop` }, shop);
  await sleep(800);
  await cdp.evaluate(ctl, `chrome.storage.local.set({ settings: { approvalMode: 'bypass' } }).then(() => true)`);
  const msgsBefore = await cdp.evaluate(ctl, `window.__msgs.length`);
  await send({ type: 'new-thread' });
  await sleep(200);
  await send({ type: 'run', command: 'feedback on this shop' });
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    state = await lastState();
    if (!state.run && state.thread?.turns?.length) break;
  }
  const bypassAsked = await cdp.evaluate(
    ctl,
    `window.__msgs.slice(${msgsBefore}).some((m) => m.type === 'update' && m.update.type === 'task-update' && m.update.update.type === 'tool-approval-request')`,
  );
  check(!bypassAsked, 'Bypass all asked nothing before Send feedback');
  const sentBypass = await cdp.evaluate(shop, `document.getElementById('feedback').textContent`);
  check(sentBypass === 'Feedback sent', 'Bypass all clicked Send feedback');
  await cdp.evaluate(ctl, `chrome.storage.local.set({ settings: {} }).then(() => true)`);

  // ------------------------------------------------ inspecting a page
  // By text, by selector and by point, on the shop the user has open. A point needs a screenshot first.
  await send({ type: 'new-thread' });
  await sleep(200);
  const seen = model.state.results.length;
  await send({ type: 'run', command: 'inspect the fonts on this shop' });
  for (let i = 0; i < 50; i++) {
    state = await lastState();
    if (!state.run && state.thread?.turns?.length) break;
    await sleep(100);
  }
  const [byText = '', bySelector = '', shotResult = '', byPoint = ''] = model.state.results.slice(seen).map(([, r]) => r);
  check(/heading1 "Ethiopian Yirgacheffe"[\s\S]*renders in Inter Variable \(a web font the page loads\)/.test(byText), 'inspect_element by text names the web font the heading renders in');
  check(/link "Cart \(\d+\)"[\s\S]*renders in the browser's default sans-serif font/.test(bySelector), 'inspect_element by selector names the fallback font');
  check(/href="http:\/\/127\.0\.0\.1:\d+\/cart"/.test(bySelector) && /text-decoration-line: underline/.test(bySelector), 'inspect_element resolves the link and reads an extra property');
  check(/^Screenshot of T\d+ "Coffee shop/.test(shotResult), `the main agent took a screenshot of the user's tab (${shotResult.slice(0, 120)})`);
  check(/heading1 "Ethiopian Yirgacheffe" at \d+,\d+/.test(byPoint), `inspect_element by point found the heading (${byPoint.split('\n')[3] ?? byPoint})`);

  // ------------------------------------------------ the popup, rendered
  await send({ type: 'open-thread', threadId });
  await sleep(300);
  const { targetId: popupTarget } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  const popup = await cdp.attach(popupTarget);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 1400, deviceScaleFactor: 1, mobile: false }, popup);
  await sleep(1500);
  // The top of the thread: the user's message bubble.
  await cdp.evaluate(popup, `(() => { document.querySelector('.is-user')?.scrollIntoView({ block: 'start' }); return true; })()`);
  await sleep(300);
  const topShot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 420, height: 320, scale: 1 } }, popup);
  writeFileSync(join(OUT, 'message.png'), Buffer.from(topShot.data, 'base64'));
  // Open the web task card's steps.
  await cdp.evaluate(popup, `(() => { const t = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Web task')); t?.click(); return !!t; })()`);
  await sleep(500);
  await cdp.evaluate(popup, `(() => { const t = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Web task')); t?.scrollIntoView({ block: 'start' }); return true; })()`);
  await sleep(300);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, popup);
  writeFileSync(join(OUT, 'popup.png'), Buffer.from(shot.data, 'base64'));
  const popupText = await cdp.evaluate(popup, `document.body.innerText`);
  check(/Web task · needs you/.test(popupText), 'the popup shows the web task card as needing the user');
  check(/Steer/.test(popupText), 'the popup shows the steer');

  // The lock button: lock, then unlock straight from it, with no command waiting.
  const clickLabel = (label) => cdp.evaluate(popup, `(() => { const b = document.querySelector('[aria-label="${label}"]'); b?.click(); return !!b; })()`);
  check(await clickLabel('Lock (forget the unlocked key)'), 'the lock button locks the key');
  await sleep(400);
  check(await clickLabel('Unlock your API key'), 'the lock button shows the key as locked');
  await sleep(400);
  const dialogOpen = await cdp.evaluate(popup, `!!document.querySelector('[role="dialog"] input[type="password"]')`);
  check(dialogOpen, 'clicking the locked button opens the unlock dialog');
  await cdp.evaluate(popup, `(() => { document.querySelector('[role="dialog"] input[type="password"]').focus(); return true; })()`);
  await cdp.send('Input.insertText', { text: 'dank memes' }, popup);
  await cdp.evaluate(popup, `(() => { [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Unlock'))?.click(); return true; })()`);
  await sleep(800);
  const unlockedAgain = await cdp.evaluate(popup, `!!document.querySelector('[aria-label="Lock (forget the unlocked key)"]') && !document.querySelector('[role="dialog"]')`);
  check(unlockedAgain, 'unlocking from the dialog unlocks the key and closes it');

  // Slash commands: typing a slash offers them, Tab completes, Enter runs it in the
  // worker. The tab in front isn't a ChatGPT or Claude chat, so the export says so.
  const key = (keyName, code, text) =>
    cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code: keyName, windowsVirtualKeyCode: code, ...(text ? { text } : {}) }, popup);
  await cdp.evaluate(popup, `(() => { document.querySelector('textarea').focus(); return true; })()`);
  await cdp.send('Input.insertText', { text: '/exp' }, popup);
  await sleep(200);
  const menu = await cdp.evaluate(popup, `document.querySelector('[aria-label="Slash commands"]')?.innerText ?? ''`);
  check(/\/export_chat_to_markdown/.test(menu), `typing a slash offers the slash commands (${menu})`);
  await key('Tab', 9);
  await sleep(100);
  const completed = await cdp.evaluate(popup, `document.querySelector('textarea').value`);
  check(completed === '/export_chat_to_markdown', `Tab completes the slash command (${completed})`);
  await key('Enter', 13, '\r');
  await sleep(800);
  const notice = await cdp.evaluate(popup, `[...document.querySelectorAll('[role="alert"]')].map((a) => a.innerText).join(' | ')`);
  check(/ChatGPT or Claude conversation|No browser tab/.test(notice), `the slash command runs and reports why it could not export (${notice})`);
  await cdp.evaluate(popup, `(() => { document.querySelector('[role="alert"] [aria-label="Dismiss"]')?.click(); return true; })()`);

  // The thread list, with a thread working: its dot sits beside the title without moving it.
  await send({ type: 'new-thread' });
  await sleep(200);
  await send({ type: 'run', command: 'slow command while the thread list shows' });
  await sleep(500);
  await cdp.evaluate(popup, `(() => { document.querySelector('[aria-label="Threads"]').click(); return true; })()`);
  await sleep(700);
  const rows = await cdp.evaluate(
    popup,
    `[...document.querySelectorAll('li button:first-child')].map((b) => {
      const dot = b.querySelector('[role="img"]');
      const [title, meta] = [b.querySelector('.truncate'), b.lastElementChild];
      const box = (el) => el.getBoundingClientRect();
      return { dot: !!dot, title: Math.round(box(title).left), meta: Math.round(box(meta).left), level: dot ? Math.abs(box(dot).top + box(dot).height / 2 - (box(title).top + box(title).height / 2)) < 1.5 : true };
    })`,
  );
  const plain = rows.filter((r) => !r.dot);
  const dotted = rows.filter((r) => r.dot);
  check(
    dotted.length > 0 &&
      new Set(rows.map((r) => r.meta)).size === 1 &&
      plain.every((r) => r.title === r.meta) &&
      dotted.every((r) => r.title > r.meta && r.level),
    `only the title moves for a dot, which sits level with it (${JSON.stringify(rows)})`,
  );
  const pane = await cdp.evaluate(
    popup,
    `(() => { const v = document.querySelector('[data-slot="scroll-area-viewport"]'); return v ? { fits: v.scrollWidth <= v.clientWidth } : null; })()`,
  );
  check(pane?.fits === true, `the thread pane scrolls in the shadcn scroll area without widening (${JSON.stringify(pane)})`);
  // The delete button floats over the row's end and only shows on hover.
  const rowLayout = await cdp.evaluate(
    popup,
    `(() => {
      const li = [...document.querySelectorAll('li')].find((l) => l.querySelector('[aria-label^="Delete thread"]'));
      const del = li.querySelector('[aria-label^="Delete thread"]');
      return { rowFills: li.querySelector('button').getBoundingClientRect().width === li.getBoundingClientRect().width, hidden: getComputedStyle(del).opacity === '0' };
    })()`,
  );
  check(rowLayout.rowFills && rowLayout.hidden, `rows fill the list and delete is hidden until hover (${JSON.stringify(rowLayout)})`);
  const hoverAt = await cdp.evaluate(
    popup,
    `(() => { const r = [...document.querySelectorAll('li')][1].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverAt.x, y: hoverAt.y }, popup);
  await sleep(300);
  const shown = await cdp.evaluate(popup, `getComputedStyle([...document.querySelectorAll('li')][1].querySelector('[aria-label^="Delete thread"]')).opacity`);
  check(shown === '1', `hovering a row shows its delete button (opacity ${shown})`);
  const listShot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 420, height: 420, scale: 1 } }, popup);
  writeFileSync(join(OUT, 'threads.png'), Buffer.from(listShot.data, 'base64'));
  // Settings: clearing threads. Every thread here was started today, so none are stale;
  // clearing all keeps the one still running.
  // A thread from yesterday, written straight into storage the way the thread store keeps it.
  await cdp.evaluate(
    ctl,
    `(async () => {
      const day = 24 * 60 * 60 * 1000;
      const old = { id: 'old-thread', title: 'from yesterday', createdAt: Date.now() - day, updatedAt: Date.now() - day, turnCount: 0 };
      const { threadIndex = [] } = await chrome.storage.local.get('threadIndex');
      await chrome.storage.local.set({ threadIndex: [...threadIndex, old], 'thread:old-thread': { ...old, turns: [] } });
      return true;
    })()`,
  );
  const stale = await cdp.evaluate(ctl, `chrome.runtime.sendMessage({ type: 'clear-threads', which: 'stale' })`);
  const afterStale = (await cdp.evaluate(ctl, `chrome.runtime.sendMessage({ type: 'list-threads' })`)).threads;
  check(
    stale.ok && stale.cleared === 1 && !afterStale.some((t) => t.id === 'old-thread') && afterStale.length > 0,
    `clearing stale threads deleted yesterday's and kept today's (${JSON.stringify(stale)})`,
  );
  const listed = afterStale.length;
  const { targetId: optionsTarget } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
  const options = await cdp.attach(optionsTarget);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 2200, deviceScaleFactor: 1, mobile: false }, options);
  await sleep(1200);
  await cdp.evaluate(options, `(() => { [...document.querySelectorAll('[data-slot="card-title"]')].find((t) => t.textContent === 'Threads')?.scrollIntoView(); return true; })()`);
  const cardText = await cdp.evaluate(options, `document.body.innerText`);
  check(cardText.includes(`You have ${listed} threads, 0 from before today.`), 'Settings shows how many threads there are');
  const card = await cdp.evaluate(
    options,
    `(() => { const r = [...document.querySelectorAll('[data-slot="card"]')].find((c) => c.innerText.startsWith('Threads')).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
  );
  const cardShot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...card, scale: 1 } }, options);
  writeFileSync(join(OUT, 'settings-threads.png'), Buffer.from(cardShot.data, 'base64'));
  check(/Popup[\s\S]*Alt\+Space[\s\S]*Over the window in use[\s\S]*Alt\+Shift\+Space/.test(cardText), 'Settings shows both keyboard shortcuts');
  const keys = await cdp.evaluate(
    options,
    `(() => { const r = [...document.querySelectorAll('[data-slot="card"]')].find((c) => c.innerText.startsWith('Keyboard shortcuts')).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
  );
  const keysShot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...keys, scale: 1 } }, options);
  writeFileSync(join(OUT, 'settings-shortcuts.png'), Buffer.from(keysShot.data, 'base64'));
  const all = await cdp.evaluate(ctl, `chrome.runtime.sendMessage({ type: 'clear-threads', which: 'all' })`);
  const left = (await cdp.evaluate(ctl, `chrome.runtime.sendMessage({ type: 'list-threads' })`)).threads;
  check(all.ok && all.cleared === listed - 1 && all.keptRunning === 1 && left.length === 1, `clearing all threads kept only the running one (${JSON.stringify(all)})`);
  await sleep(3000);

  check(!swLogs.some((l) => l.includes('could not update the toolbar icon')), 'the toolbar icon dot drew without errors');
  check(swErrors.length === 0, `no errors in the worker${swErrors.length ? `: ${swErrors.join(' | ')}` : ''}`);
  log(`API calls: ${apiCalls} (${taskCalls} from the web task)`);
  writeFileSync(join(OUT, 'results.txt'), results + '\n\n--- worker log ---\n' + swLogs.join('\n'));
  await cdp.send('Browser.close').catch(() => {});
} catch (err) {
  failures.push(String(err?.stack ?? err));
  log('ERROR', err);
  chrome.kill();
} finally {
  server.close();
  await sleep(300);
  chrome.kill();
  rmSync(profile, { recursive: true, force: true });
  log(failures.length ? `${failures.length} FAILED` : 'ALL PASSED');
  if (failures.length && stderr) writeFileSync(join(OUT, 'chrome-stderr.txt'), stderr);
  process.exit(failures.length ? 1 : 0);
}
