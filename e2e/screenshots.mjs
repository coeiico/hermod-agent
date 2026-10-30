// Screenshots of the popup for the README: the built extension in headless
// Chromium, a few made-up tabs, and generic commands answered by a scripted
// fake Claude API, so nothing leaves the machine and no API credit is spent.
// The pages are served offline by CDP request interception.
//
// Run with `npm run screenshots` (it builds first). It needs the same Chromium
// as `npm run e2e`. Every shot goes to .output/screenshots/; copy the ones the
// README shows into assets/screenshots/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, sleep } from './cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, '.output/chrome-mv3');
const OUT = join(ROOT, '.output/screenshots');
const log = (...a) => console.log('[screenshots]', ...a);

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

// ------------------------------------------------ the made-up pages

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui,sans-serif;margin:40px;max-width:720px} button,a,input{font-size:16px} .row{margin:12px 0}</style></head><body>${body}</body></html>`;

const pricing = (name, plans) => page(`Pricing · ${name}`, `<h1>${name} pricing</h1>${plans.map((p) => `<h2>${p[0]}</h2><p>${p[1]}</p>`).join('')}`);

const SHOP = page('Ethiopian Yirgacheffe · Northwind Coffee', `
<h1>Ethiopian Yirgacheffe</h1>
<p>Floral and bright, with notes of bergamot and lemon.</p>
<a href="#" id="cart">Cart (0)</a>
<fieldset><legend>Size</legend>
  <label><input type="radio" name="size" value="250g" checked> 250 g · $12.00</label>
  <label><input type="radio" name="size" value="1kg"> 1 kg · $38.00</label>
</fieldset>
<div class="row"><button type="button" id="add">Add to cart</button></div>
<script>
  document.getElementById('add').addEventListener('click', () => {
    const big = document.querySelector('input[name=size]:checked').value === '1kg';
    document.getElementById('cart').textContent = 'Cart (1) · ' + (big ? '$38.00' : '$12.00');
  });
</script>`);

// Two windows: one of reading for a side project, one for notes apps and coffee.
const WINDOWS = [
  [
    ['https://github.com/wxt-dev/wxt', 'wxt-dev/wxt: Next-gen Web Extension Framework'],
    ['https://developer.chrome.com/docs/extensions/reference/api/tabs', 'chrome.tabs | API | Chrome for Developers'],
    ['https://www.youtube.com/watch?v=hermod-demo-1', 'Lo-fi beats to study and code to - YouTube'],
    ['https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API', 'Web Crypto API - Web APIs | MDN'],
    ['https://www.youtube.com/watch?v=hermod-demo-2', 'How JavaScript engines work - YouTube'],
    ['https://news.ycombinator.com/', 'Hacker News'],
    ['https://developer.chrome.com/docs/extensions/reference/api/bookmarks', 'chrome.bookmarks | API | Chrome for Developers'],
    ['https://www.youtube.com/watch?v=hermod-demo-3', 'CSS grid in 20 minutes - YouTube'],
  ],
  [
    ['https://fieldnote.example.com/pricing', 'Pricing · Fieldnote', pricing('Fieldnote', [['Free', 'Free forever for one person, up to 1,000 notes.'], ['Pro', '$6 a month: unlimited notes and sync.']])],
    ['https://inkwell.example.com/pricing', 'Pricing · Inkwell', pricing('Inkwell', [['Starter', 'Free: 3 notebooks and 7 days of page history.'], ['Plus', '$10 a month: unlimited notebooks.']])],
    ['https://slate.example.com/pricing', 'Pricing · Slate', pricing('Slate', [['Trial', 'Try everything free for 14 days.'], ['Personal', '$8 a month.'], ['Team', '$15 per person a month.']])],
    ['https://shop.example.com/ethiopian-yirgacheffe', 'Ethiopian Yirgacheffe · Northwind Coffee', SHOP],
  ],
];
const PAGES = new Map(WINDOWS.flat().map(([url, title, html]) => [url, html ?? page(title, `<h1>${title}</h1>`)]));

// ------------------------------------------------ the scripted Claude API

let counter = 0;
function respond(model, blocks, stop) {
  // Usage in the range a real command reports, so cost and context look right.
  const usage = { input_tokens: 1800, cache_read_input_tokens: 9400, cache_creation_input_tokens: 0, output_tokens: 1 };
  const events = [{ type: 'message_start', message: { id: `msg_${++counter}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${++counter}`, name: block.name, input: {} } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 140 } });
  events.push({ type: 'message_stop' });
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}
const tool = (name, input) => ({ type: 'tool_use', name, input });
const text = (t) => ({ type: 'text', text: t });

function textOf(content) {
  if (typeof content === 'string') return content;
  return content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? textOf(b.content ?? '') : '')).join('\n');
}

/** The tabs in the request's snapshot: id, window, title and address. */
function tabsOf(snapshot) {
  const tabs = [];
  let windowId;
  for (const line of snapshot.split('\n')) {
    const win = line.match(/^W(\d+)/);
    if (win) windowId = Number(win[1]);
    const tab = line.match(/^\s+T(\d+) #\d+ .*?"(.*?)" (\S+)/);
    if (tab) tabs.push({ id: Number(tab[1]), windowId, title: tab[2], url: tab[3] });
  }
  return tabs;
}

const HAIKU = 'claude-haiku-5-5';
const byTitle = (tabs, part) => tabs.find((t) => t.title.includes(part));

// Each command is a list of steps; step n answers the request after n replies.
const COMMANDS = {
  'Close my YouTube tabs and sort the rest by site': (n, { tabs }) => {
    const youtube = tabs.filter((t) => t.title.endsWith('YouTube'));
    const windowId = youtube[0]?.windowId;
    const host = (t) => t.url.replace(/^https?:\/\/(www\.)?/, '');
    const rest = tabs.filter((t) => t.windowId === windowId && !youtube.includes(t)).sort((a, b) => host(a).localeCompare(host(b)));
    return [
      () => [tool('close_tabs', { tabIds: youtube.map((t) => t.id) })],
      () => [tool('sort_tabs', { windowId, order: rest.map((t) => t.id) })],
      () => [text(`Closed ${youtube.length} YouTube tabs and sorted the other ${rest.length} by site.`)],
    ][n];
  },
  'Bookmark the Chrome extension docs into a folder called Extension docs': (n, { tabs }) =>
    [
      () => tabs.filter((t) => t.title.includes('Chrome for Developers')).map((t) => tool('create_bookmark', { tabId: t.id, folder: 'Extension docs' })),
      () => [text('Bookmarked chrome.tabs and chrome.bookmarks in a new **Extension docs** folder.')],
    ][n],
  'Which of these note apps has a free plan?': (n, { tabs }) =>
    [
      () => tabs.filter((t) => t.title.startsWith('Pricing')).map((t) => tool('get_page_text', { tabId: t.id })),
      () => [
        text(
          'Two of them do:\n\n' +
            '- **Fieldnote**: free forever for one person, up to 1,000 notes.\n' +
            '- **Inkwell**: free with 3 notebooks and 7 days of page history.\n\n' +
            "**Slate** has no free plan, only a 14-day trial; after that it's $8 a month.",
        ),
      ],
    ][n],
  'Add the 1 kg bag of this coffee to my cart': (n, { tabs, result }) => {
    if (n === 0) {
      return () => [
        text('Handing this to a web task.'),
        tool('start_web_task', {
          goal: 'Add the 1 kg bag of the coffee on this page to the cart',
          context: 'The user wants the 1 kg size.',
          doneWhen: 'The cart shows the 1 kg bag; report the cart total.',
          constraints: 'Stop before checkout.',
          start: { tabId: byTitle(tabs, 'Northwind').id },
        }),
      ];
    }
    if (result.includes('ended')) return () => [text('Added the 1 kg bag of Ethiopian Yirgacheffe to your cart. The cart total is $38.00.')];
    return () => [tool('wait_for_web_task', { taskId: result.match(/\bK\d+\b/)?.[0] ?? 'K1' })];
  },
  "Delete today's history from Hacker News": (n) =>
    [() => [tool('delete_history', { query: 'news.ycombinator.com', startTime: `${new Date().toLocaleDateString('sv')}T00:00` })], () => [text('Deleted it.')]][n],
};

// The guess at the next command after each one, shown as the prompt's hint.
const GUESSES = {
  'Close my YouTube tabs and sort the rest by site': 'Put the Chrome docs in a new window',
  'Bookmark the Chrome extension docs into a folder called Extension docs': 'Close the Chrome docs tabs',
  'Which of these note apps has a free plan?': 'Bookmark the Fieldnote and Inkwell pricing pages',
  'Add the 1 kg bag of this coffee to my cart': 'Go to the cart',
};

const task = { tabId: undefined };
function webTask(body, n, result) {
  if (n === 0) task.tabId = Number(textOf(body.messages[0].content).match(/<start>\nT(\d+)/)[1]);
  const { tabId } = task;
  const ref = (pattern) => result.match(pattern)?.[1];
  const steps = [
    () => tool('find', { tabId, query: '1 kg' }),
    () => tool('click', { tabId, ref: ref(/\[([a-z0-9]+\.\d+)\] radio "1 kg/) }),
    () => tool('find', { tabId, query: 'Add to cart' }),
    () => tool('click', { tabId, ref: ref(/\[([a-z0-9]+\.\d+)\] button "Add to cart"/) }),
    () => tool('find', { tabId, query: 'Cart' }),
    () => tool('report_result', { status: 'done', summary: 'Chose the 1 kg bag and added it to the cart.', data: 'Cart: 1 kg Ethiopian Yirgacheffe, $38.00', tabIds: [tabId] }),
  ];
  return steps[n] ? respond('claude-sonnet-5-5', [steps[n]()], 'tool_use') : respond('claude-sonnet-5-5', [text('Added it.')], 'end_turn');
}

function reply(body) {
  const n = body.messages.filter((m) => m.role === 'assistant').length;
  const last = body.messages.at(-1);
  const result = Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result').map((b) => textOf(b.content ?? '')).join('\n') : '';
  const system = body.system.map((b) => b.text).join('\n');
  if (system.includes("You are Hermod's web task agent")) return webTask(body, n, result);
  const first = textOf(body.messages[0].content);
  if (system.includes("You only guess the user's next command")) {
    const latest = [...first.matchAll(/<command>(.*?)<\/command>/g)].at(-1)?.[1] ?? '';
    return respond(HAIKU, [text(GUESSES[latest] ?? 'NONE')], 'end_turn');
  }
  const command = first.match(/<command>\n([\s\S]*?)\n<\/command>/)?.[1] ?? '';
  const step = COMMANDS[command]?.(n, { tabs: tabsOf(first), result });
  if (!step) return respond(HAIKU, [text(`No script for "${command}" at step ${n}.`)], 'end_turn');
  const blocks = step();
  return respond(HAIKU, blocks, blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
}

// ------------------------------------------------ the run

if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error('No build in .output/chrome-mv3. Run `npm run build` first (`npm run screenshots` does).');
  process.exit(1);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'hermod-shots-'));
const chrome = spawn(findChromium(), [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${EXT}`,
  `--load-extension=${EXT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1280,900',
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
  'about:blank',
], { stdio: 'ignore' });

try {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  const cdp = new CDP(`ws://127.0.0.1:${port}${path}`);
  await cdp.ready();

  let sw;
  for (let i = 0; i < 100 && !sw; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
    if (!sw) await sleep(100);
  }
  if (!sw) throw new Error('extension service worker not found');
  const extId = new URL(sw.url).host;
  const swSession = await cdp.attach(sw.targetId);

  // The Claude API, answered from the script.
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://api.anthropic.com/*' }] }, swSession);
  cdp.on(async (msg) => {
    if (msg.method !== 'Fetch.requestPaused' || msg.sessionId !== swSession) return;
    const { requestId, request } = msg.params;
    let raw = request.postData;
    if (!raw && request.postDataEntries) raw = Buffer.concat(request.postDataEntries.map((e) => Buffer.from(e.bytes, 'base64'))).toString('utf8');
    const sse = reply(JSON.parse(raw));
    // A real call takes a moment; without it every command reports 0.0s.
    await sleep(500 + Math.random() * 400);
    await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/event-stream' }], body: Buffer.from(sse).toString('base64') }, swSession);
  });

  // The made-up pages, served to every tab.
  const servePages = async (session) => {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*', resourceType: 'Document' }] }, session);
  };
  cdp.on(async (msg) => {
    if (msg.method !== 'Fetch.requestPaused' || msg.sessionId === swSession) return;
    const { requestId, request } = msg.params;
    const html = PAGES.get(request.url) ?? page('Not found', '');
    await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }], body: Buffer.from(html).toString('base64') }, msg.sessionId);
  });
  const openTab = async (url, newWindow) => {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow });
    const session = await cdp.attach(targetId);
    await servePages(session);
    await cdp.send('Page.navigate', { url }, session);
    return session;
  };
  for (const [w, tabs] of WINDOWS.entries()) {
    for (const [i, [url]] of tabs.entries()) await openTab(url, i === 0 && w > 0);
  }
  // Close the blank tab Chromium started with.
  const { targetInfos } = await cdp.send('Target.getTargets');
  for (const t of targetInfos.filter((t) => t.type === 'page' && t.url === 'about:blank')) await cdp.send('Target.closeTarget', { targetId: t.targetId });
  await sleep(1000);

  // An extension page to talk to the worker as the popup does.
  const { targetId: ctlTarget } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/options.html`, newWindow: true });
  const ctl = await cdp.attach(ctlTarget);
  await sleep(800);
  await cdp.evaluate(ctl, `chrome.runtime.sendMessage({ type: 'save-key', apiKey: 'sk-ant-test-local-only', passphrase: 'screenshots' })`);
  await cdp.evaluate(ctl, `(() => {
    window.__msgs = [];
    window.__port = chrome.runtime.connect({ name: 'hermod-popup' });
    window.__port.onMessage.addListener((m) => window.__msgs.push(m));
    return true;
  })()`);
  await sleep(300);
  const send = (m) => cdp.evaluate(ctl, `window.__port.postMessage(${JSON.stringify(m)}), true`);
  const lastState = () => cdp.evaluate(ctl, `JSON.parse(JSON.stringify(window.__msgs.filter((m) => m.type === 'state').at(-1) ?? null))`);
  const approvals = () => cdp.evaluate(ctl, `window.__msgs.filter((m) => m.type === 'update' && m.update.type === 'tool-approval-request').map((m) => m.update.approvalId)`);

  /** Runs a command in a new thread, approving what it asks, and waits for it to finish. */
  const answered = new Set();
  const run = async (command, { approve = true } = {}) => {
    await send({ type: 'new-thread' });
    await sleep(200);
    await send({ type: 'run', command });
    let state;
    for (let i = 0; i < 300; i++) {
      await sleep(100);
      for (const id of await approvals()) {
        if (answered.has(id) || !approve) continue;
        answered.add(id);
        await send({ type: 'approve', approvalId: id, approved: true });
      }
      if (!approve && (await approvals()).some((id) => !answered.has(id))) break;
      state = await lastState();
      if (state?.thread?.turns?.length && !state.run) break;
    }
    log(`ran "${command}"`);
    return state?.thread?.id;
  };

  const threads = {};
  threads.coffee = await run('Add the 1 kg bag of this coffee to my cart');
  threads.bookmarks = await run('Bookmark the Chrome extension docs into a folder called Extension docs');
  threads.tidy = await run('Close my YouTube tabs and sort the rest by site');
  threads.plans = await run('Which of these note apps has a free plan?');

  // The popup, at its real size, on a high-density screen.
  const { targetId: popupTarget } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html`, newWindow: true });
  const popup = await cdp.attach(popupTarget);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 600, deviceScaleFactor: 2, mobile: false }, popup);
  await sleep(1500);
  const shoot = async (name) => {
    await sleep(600);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, popup);
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    log(`shot ${name}.png`);
  };
  const click = (expression) => cdp.evaluate(popup, `(() => { const el = ${expression}; el?.click(); return !!el; })()`);

  for (const [name, id] of Object.entries(threads)) {
    await send({ type: 'open-thread', threadId: id });
    await shoot(name);
    // The same thread from the top, with the user's message.
    await cdp.evaluate(popup, `(() => { document.querySelector('.is-user')?.scrollIntoView({ block: 'start' }); return true; })()`);
    await shoot(`${name}-top`);
  }

  // The web task's steps, opened.
  await send({ type: 'open-thread', threadId: threads.coffee });
  await sleep(500);
  await click(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Web task'))`);
  await shoot('coffee-steps');

  // The thread list.
  await click(`document.querySelector('[aria-label="Threads"]') ?? [...document.querySelectorAll('button')].find((b) => /thread/i.test(b.getAttribute('aria-label') ?? ''))`);
  await shoot('threads');
  await click(`document.querySelector('[aria-label="Threads"]') ?? [...document.querySelectorAll('button')].find((b) => /thread/i.test(b.getAttribute('aria-label') ?? ''))`);

  // A question before a change that can't be undone, left unanswered.
  run("Delete today's history from Hacker News", { approve: false });
  await sleep(2500);
  await shoot('approval');
} finally {
  chrome.kill();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(0);
