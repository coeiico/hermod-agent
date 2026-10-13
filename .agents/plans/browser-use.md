# Plan — Browser Use

Give Hermod hands inside web pages, through a second agent. Today Hermod manages the browser around pages (tabs, windows, bookmarks, history, downloads) and can only read a page's text and links, so any task that happens *on* a site ("add this to my cart", "fill in this form", "find the cheapest flight on this page") is out of reach. This plan:

- keeps `browser_command` as the main agent: fast and cheap, it decides what a command needs;
- adds a `web_task` agent that works inside pages with element refs and screenshots, in its own window, under hard-coded guardrails;
- lets the main agent hand a task to `web_task` with a structured brief;
- lets the user steer a running agent and queue follow-up commands, with the main agent deciding whether a steer goes on to the web task;
- lets commands run in several threads at once, with status dots on the thread list and on the toolbar icon.

Written 2026-10-13 against `c1f8f28` (with uncommitted, unrelated changes in `entrypoints/options/App.tsx`, `lib/detached-window.ts` and `wxt.config.ts`).

## Decisions

These were settled with the user before writing:

- **Two agents.** The main agent, `interactive/browser_command`, stays on Haiku at low effort and handles tab, window and library commands itself. When a command needs work inside pages, it starts `delegated/web_task` (Sonnet, more turns, page tools) with a structured brief, and gets a structured result back. This keeps tab commands cheap, keeps the web task's long, noisy history (page outlines, screenshots) out of the thread, and lets each agent have a prompt and tools that fit its job.
- **Both page approaches, with different jobs.** Element refs are the hands: every action resolves to a real DOM element, so the guardrails can inspect it before acting. Screenshots are the eyes. A click by coordinates is the fallback, and it resolves to the element under the point and goes through the same checks.
- **Autonomy follows the approval mode** the user picks in the popup (`ApprovalMode` in `ai/runtime/context.ts`): `ask` ("Ask first"), `auto` ("Auto"), `never` ("Don't ask"). Under every mode sit hard-coded guardrails: some actions always ask, like the existing `alwaysAsk` tools, and a few are refused outright. Hermod never types passwords or card numbers, and never presses the final order or payment button.
- **Sending while busy queues by default.** A message sent while the thread's command is running waits as the thread's next command. Under it, a **Steer** button sends it into the running command instead. The main agent reads it at its next step and decides whether to act on it itself, pass it to the running web task, or both.
- **Web tasks run in their own window**, so the user can keep browsing.
- **Several threads can run at once.** One command at a time per thread (the queue keeps them in order), any number of threads up to a cap.
- **Status indicators.**
  - Thread list: a pulsing dot left of the title while a thread's agent is working; a green dot once it finishes; opening the thread marks it read and the dot disappears.
  - Toolbar icon: a pulsing dot in the corner while any run is active.
- **Trusted input through `chrome.debugger` is a later phase**, only if real sites need it.

## Architecture

```
popup ──port──▶ background worker
                 ├─ RunScheduler: one queue + at most one active command per thread
                 │    └─ command run: browser_command (Haiku)
                 │         ├─ tab / window / library tools
                 │         └─ start / wait / steer / stop web task ──▶ web_task run (Sonnet)
                 │                                                    ├─ page tools + guardrails
                 │                                                    └─ its own window
                 └─ indicators: toolbar icon, thread activity
```

### Dependency direction

- `ai/runtime/` gains three general capabilities: image tool results, a steering inbox, and sub-runs (a run can start, wait on, steer and stop child runs through `RunContext`). It still imports nothing from `ai/agents/` or `ai/tools/`.
- `ai/tools/` gains the page tools and the guardrails.
- `ai/agents/delegated/web_task/` is the new agent. `ai/agents/interactive/browser_command/` gains the four delegation tools, defined beside its `agent.ts` because they belong to it, not to the browser.
- `lib/` gains the scheduler (queue, concurrency) and the sub-run implementation the worker hands to each command's `RunContext`. `lib/` is where the worker's run orchestration already lives (`run-controller.ts`).

## The handoff

### The brief

`start_web_task` takes a zod-validated brief. The main agent writes the parts only it can know; the code attaches the parts the model must not be trusted to copy.

Written by the main agent:

- `goal`: the outcome in one or two sentences, from the user's point of view ("Add the 1 kg bag of the coffee on this page to the cart").
- `context`: every fact from the thread and snapshot the task needs: names, quantities, preferences, earlier results ("The user said earlier they want the decaf version").
- `done_when`: how the web task knows it has finished ("The cart shows the item"), and what to report back ("the cart total").
- `constraints`: what not to do and limits ("Don't change the delivery address"; "Stop before checkout").
- `start`: where to work: `{ tabId }` to act in an existing tab (when the command is about "this page"), or `{ url }` to open a fresh tab in the task's own window.

Attached by code:

- `userCommand`: the user's command, word for word, so nothing the user said is lost in paraphrase.
- Any steering messages the user sent this command before the handoff, word for word.
- The current time, and the approval mode (so the web task's prompt can say how it will be asked).
- For `{ tabId }`: that tab's title and URL from the live snapshot.

The web task's `task.md` renders all of these, under clear headings. The main agent's `instructions.md` gets a section on writing a brief, with two worked examples.

### The result

The web task ends by calling `report_result`, which the run function reads (falling back to the final text if it's missing):

- `status`: `done`, `needs_user` (it stopped at a guardrail, a login, a CAPTCHA, or something the brief didn't cover), or `failed`.
- `summary`: what it did and what it found, in a few sentences.
- `leftForUser`: the step the user has to take, if any ("Enter your card details and press Place order").
- `tabIds`: the tabs worth showing the user.
- `data`: what `done_when` asked to report, as short text.

The code adds `stopped` or `interrupted` when the run ends that way, with its last few actions so a resume can see how far it got. `wait_for_web_task` returns the result to the main agent, which tells the user and can then act (focus the task's window, close it, start another task).

### Delegation tools (`browser_command`)

- `start_web_task(brief)` → a task ID. Returns straight away.
- `wait_for_web_task(taskId)` → returns when the task finishes, **or early when the user steers**: `{ steering: "<the user's words>" }`, so the main agent can decide what to do with it.
- `steer_web_task(taskId, message)` → passes guidance into the running task. The message carries the user's words verbatim plus the main agent's note.
- `stop_web_task(taskId)`.

Splitting start from wait is what makes steering work: the main agent is never stuck inside one long tool call, and waiting is a step where a steer can reach it. It also leaves room for running two web tasks at once later. These are `write` tools with no confirmation: the web task asks for its own actions.

### The web task agent (`ai/agents/delegated/web_task/`)

`delegated` is a new role folder: agents another agent starts, not the user. `.agents/instructions/hermod-agents-overview.md` gets the role.

- `config.yaml`: `id: web_task.v1`, `model: claude-sonnet-5-5`, `effort: medium`, `max_tokens: 16000`. It ignores the popup's model and effort pickers, which are for the main agent. Settings may get a separate "web task model" picker later.
- Tools (`WEB_TASK_TOOLS` in `ai/tools/catalog.ts`, its own fixed order): the page tools below, plus `open_tab`, `navigate_tab`, `go_back_or_forward`, `activate_tab`, `reload_tabs`, `close_tabs`, `get_page_text`, `get_page_links` and `report_result`. Its tab tools may only touch the task's own window and the tab named in its brief; `tools/resolve.ts` enforces this through the run's ownership (below).
- `system.md` (# Behavior): untrusted page content; never type passwords, card numbers, security codes or one-time codes, and never press the final order or payment button; stop at logins and CAPTCHAs and report `needs_user`; set `consequential: true` on anything that spends money, sends or publishes, changes account settings or can't be undone; follow steering from the user (relayed by the main agent) over the original brief when they conflict.
- `instructions.md`: # Role, # Objective (prefer refs, take a screenshot when the outline doesn't explain the screen or to check a result, refs die when the page changes, finish with `report_result`), # Examples (a search form; stopping at checkout).
- Limits: 60 turns, 20 minutes, its own confirmation timeout of 10 minutes, because a background task may wait for a user who is in another thread.

### Its own window

Unless the brief names a tab, the web task opens a new normal window without focus (`windows.create({ focused: false })`; check that Vivaldi honours it) and works there. Screenshots need the tab to be the active one in a window that isn't minimised, which its own window satisfies. The window stays open at the end when the result has tabs to show; the main agent can focus it if the user asked to see it, or close it.

The worker records which run owns which window and tabs. The snapshot marks them (`W40 [hermod task: thread title]`), and `tools/resolve.ts` refuses another run's tabs. So a tab command in another thread can't move or close a window a web task is working in, the same way the resolver already refuses Hermod's popped-out window.

## Steering and the queue

### What the user sees

- While a thread's command runs, the prompt box still sends. The message appears below the running command as **queued**, with **Steer** and remove buttons.
- When the running command finishes, the oldest queued message starts as the thread's next command, on its own.
- **Steer** sends it into the running command at once. It moves into the running command's transcript, marked as a steer, and the main agent reads it at its next step.
- If the command finishes before the steer is read, the steer runs as the next command instead, so nothing the user typed is dropped.

### How it reaches the agents

- `RunContext` gains a steering inbox. Before each model call, the runner drains it and appends each message as a text block after that turn's tool results, as `<steering>…</steering>` in the same user message. History stays append-only, so the prompt cache is unaffected.
- `wait_for_web_task` also listens to the inbox and returns early with the steer. This is the "next tool call or wait" moment where the main agent decides.
- The main agent's `instructions.md` gets a section on steering. A steer is the user talking, trusted like the command itself. Decide whether it changes what you're doing, the web task's job, or both. Pass it on with `steer_web_task` when it concerns the web task; stop and restart the task when the goal has changed.
- `steer_web_task` writes into the web task's own inbox, which its runner drains the same way. The web task's prompt says relayed steering wins over the brief.

A steer that arrives while a tool is running or a confirmation is waiting is read at the next turn boundary. Tools are capped at 30 seconds, and the confirmation itself can be declined.

### Where the queue lives

The worker's scheduler (`lib/run-scheduler.ts`, new) keeps each thread's queue and its active command. Queued messages are written to `storage.session` with the active runs. If the worker restarts, running commands are filed as interrupted (as today) and the queue is kept but paused: the popup shows it with a Run button, so nothing starts on its own after a crash.

## Concurrent threads

`entrypoints/background.ts` assumes one `active` run today. The change:

- `active` becomes the scheduler's `Map<threadId, ActiveCommand>`. Each command's `RunController`, abort controller, steering inbox, and the web tasks it started live in its entry.
- Port protocol (`lib/run.ts`):
  - `run` queues or starts in the open thread;
  - `steer { queuedId }`, `unqueue { queuedId }`;
  - `stop { threadId }` stops that thread's command and its web tasks;
  - `approve` is routed through an `approvalId → command` map;
  - `state` replaces `runningThreadId` with per-thread activity (below) and carries the open thread's queue.
- `RunUpdate`s from a web task carry the starting tool call's ID (`parentCallId`), so the run view shows the web task's steps nested and collapsible under its `start_web_task` card. Threads store the web task's actions as text only: no screenshots, no outlines.
- **A cap on concurrent commands** (3 to start), so a burst of commands doesn't hammer the API key's rate limits. A command over the cap waits as queued, with a note saying why.
- **One keep-alive interval** while any run is active.
- **Serialised thread storage.** `lib/threads.ts` does read-modify-write on the thread index (`writeThread`). Two runs finishing together would lose one update. All writes go through one promise chain in the worker.
- **Approvals in a thread you're not looking at** turn that thread's dot amber, and turn the toolbar dot amber. Opening the thread shows the question.

## Indicators

Per-thread activity, derived in the worker from the scheduler and a `lastViewedAt` stored on each thread summary:

| State | Thread list dot | Toolbar icon dot |
|---|---|---|
| Running | pulsing (accent colour) | pulsing (accent) |
| Waiting on a confirmation | pulsing amber | pulsing amber |
| Finished since you last opened it | solid green | solid green |
| Finished with an error, unread | solid red | solid red |
| Opened (read) | none | none |

The toolbar shows the most urgent state across all threads: amber, then running, then red, then green. A thread counts as read when it is the thread open in a popup when its command finishes, or when the user opens it later. The threads button in the popup header gets the same dot whenever a thread other than the open one has activity, so it's visible without opening the list.

- Thread list (`components/hermod/thread-list.tsx`): the dot left of the title. It already reloads on `runningId`; it will reload on activity changes instead.
- Toolbar icon (`lib/run-indicator.ts`, new): pre-render the icon at 16 and 32 px with a corner dot at a few opacities (`OffscreenCanvas` from `public/icon/*.png`) and cycle them with `browser.action.setIcon({ imageData })` every ~150 ms while pulsing; a single frame for solid states. Check how Vivaldi renders the toolbar icon at its real size before sizing the dot.

## Page tools

All new tools go in `ai/tools/` and are appended to the end of their catalog list. `BROWSER_TOOLS` doesn't change, because the main agent doesn't get page-action tools.

### `ai/tools/pages.ts` (reading; extend the existing file)

- `read_page(tabId, filter?: 'interactive' | 'all')`: the page as an indented outline of visible elements, each interactive one tagged `[ref_N] role "name"` with its state (value, checked, disabled, expanded). Viewport first, with a character cap and a "… N more elements below" note. Refs are kept in a `Map<string, WeakRef<Element>>` on a global in the extension's isolated world, which persists between `executeScript` calls in the same document. A new document loses them, and the action tools say "ref_N is gone (the page changed): call read_page again".
- `find(tabId, query)`: the elements whose role, name or text contain `query`, with refs.
- `screenshot(tabId)`: `tabs.captureVisibleTab` on the tab's window, downscaled in the worker (`createImageBitmap` + `OffscreenCanvas`) to at most 1280 px wide JPEG. The result records the scale so `click_at` can map image pixels to CSS pixels. Capture is rate-limited by the browser (about two a second), so the tool spaces its calls.

### `ai/tools/page-actions.ts` (new)

Each action resolves its target to an element, gets its descriptor, runs the guardrails, then acts. The approval question comes from `confirm`, which can inspect the page because it is async.

- `click(tabId, ref, consequential?)`: scroll into view, then `click()`.
- `click_at(tabId, x, y, consequential?)`: screenshot coordinates → CSS pixels → `elementFromPoint`, then the same path as `click`. The result names the element it hit.
- `type_text(tabId, ref, text, clear?, submit?, consequential?)`: focus, set the value through the native setter so React and Vue see the change, fire `input` / `change`. `submit: true` presses Enter afterwards and counts as a submit.
- `select_option(tabId, ref, value)`: `<select>`, checkboxes and radios.
- `press_key(tabId, key, ref?, consequential?)`: Enter, Escape, Tab, arrows, page keys. Enter on a form field counts as a submit.
- `scroll(tabId, direction | ref)` and `wait_for(tabId, text | ref, timeoutMs)`: both `read`.

Each action then waits for the page to settle: navigation complete, or no DOM mutations for about 500 ms, capped at a few seconds. It returns a one-line outcome plus what changed ("navigated to …", "a dialog opened", "the field now reads …"), so the agent rarely needs a fresh outline after each step.

Scripts reuse `injectableTab` from `pages.ts`, which already refuses browser-internal pages, extension stores and discarded tabs. Top frame only in this plan.

### `ai/tools/page-guardrails.ts` (new)

The in-page script returns an **element descriptor**: tag, `type`, `role`, `autocomplete`, `name`, `id`, `inputmode`, label text, visible text / `value` / `aria-label`, and for elements in a form, the form's submit button and fields as descriptors. The decision runs in the worker as pure functions with unit tests, and the injected script stays self-contained, as `executeScript` requires.

- `refusal(descriptor, action)` returns a refusal message or null:
  - **Typing:** `type=password`; `autocomplete` starting `cc-`, or `current-password`, `new-password`, `one-time-code`; a name, id or label matching card number, CVV/CVC, security code or expiry.
  - **Pressing** (click, coordinate click, or Enter in its form): text, `value` or `aria-label` matching place order, complete / submit / confirm order, buy now, pay, pay now, complete purchase, confirm payment, send money, send payment or transfer. Also any submit of a form that contains a card field.
- `risk(descriptor, action)` returns `'always' | 'submit' | null`:
  - `always`: send, post, publish, reply, delete, remove, unsubscribe, cancel subscription or close account wording, and `input[type=file]`;
  - `submit`: `button` with no type or `type=submit` in a form, `input[type=submit|image]`, Enter in a form field.

A refusal is a tool error the agent reads ("refused: Hermod never types passwords or card numbers. Report needs_user so the user can enter it"). The rules match English wording and common markup, so they are a backstop, not a guarantee: a site can label its payment button "Continue". `system.md` tells the agent the same rules, so both the prompt and the code have to fail before something gets through.

### Approval rules for page actions

| Action | Ask first | Auto | Don't ask |
|---|---|---|---|
| `read_page`, `find`, `screenshot`, `scroll`, `wait_for` | no | no | no |
| Click / type / select / key on an ordinary element | asks | no | no |
| A submit (`risk` = `submit`) | asks | asks | no |
| The agent sets `consequential: true` | asks | asks | no |
| `risk` = `always` | asks | asks | **asks** |
| A `refusal` | refused | refused | refused |

The `consequential` flag lets the agent ask about things the code can't recognise. The code's checks don't depend on the agent, so a page that talks the agent out of setting the flag still hits them.

## Runtime changes (`ai/runtime/`)

1. **Image tool results.** `run` may return `string | { text: string; image?: { mediaType: 'image/jpeg' | 'image/png'; data: string }; pageView?: true }`. `ToolResult`'s `ok` case carries them, and `toToolResultBlock` builds a content array when there is an image. `RunController` and `lib/threads.ts` keep only the text.
2. **One call can be always-ask.** `confirm` may return `{ question: string; always: true }` as well as a string or null; `approvalQuestion` keeps that question in `never` mode. The static `alwaysAsk` flag stays for the existing tools.
3. **Trimming old page views.** Before each model call, the runner replaces all but the two most recent `pageView` results with `[Older page view removed; call read_page or screenshot for the current page.]`. Changing an earlier message breaks the prompt cache from that point, so it trims in batches (when five have built up, cut back to two), not every turn.
4. **Steering inbox.** `RunContext.steering`: a queue the caller pushes to and the runner drains before each model call (see "How it reaches the agents"). `wait(signal)` resolves when a message arrives, for `wait_for_web_task`.
5. **Sub-runs.** `RunContext.subRuns`: an interface with `start(agent: string, input: unknown) → id`, `wait(id, signal) → result | steering`, `steer(id, message)`, `stop(id)`. The worker implements it (`lib/sub-runs.ts`) and knows how to start `web_task`. A child run gets its own `RunContext`: its cancel signal follows the parent's, it shares the parent's approval mode and `confirm` hook, and it has its own limits and inbox. `ToolRunContext` gains `run: RunContext` so the delegation tools can reach it.
6. **Per-agent limits.** The worker passes limits when it creates each context: `browser_command` keeps 10 turns and 5 minutes of its own working time, with time spent waiting on a web task not counted; `web_task` gets 60 turns and 20 minutes.

## Main agent changes (`ai/agents/interactive/browser_command/`)

- `agent.ts`: tools are `[...BROWSER_TOOLS, ...DELEGATION_TOOLS]`, the delegation tools appended so the existing cached prefix only grows at the end.
- `config.yaml`: `id` → `browser_command.v5`.
- `instructions.md`:
  - **When to delegate.** Anything that needs clicking, typing or reading through a site's pages goes to a web task. Tab, window, bookmark, history and download work stays here. A mixed command does its own part and delegates the page part.
  - **Writing a brief**, with examples.
  - **Steering.**
  - **Reporting a web task's result:** relay `leftForUser` plainly.
- `formatEarlierTurns`: a web task in an earlier turn shows as its brief's goal and its result (status, summary, left for user), not its steps. That keeps follow-ups like "now check out" grounded without replaying the page work.
- Resume: a resumed command whose web task was stopped sees the task's result with its last actions, and can start a new web task whose brief includes the progress so far.

## Mode descriptions (`lib/settings.ts`)

`APPROVAL_MODE_OPTIONS` mention pages:

- Auto "asks before submitting forms and other steps that matter";
- Don't ask "still asks before sending, posting or deleting, and never enters passwords or card numbers or pays for you. A malicious page can still steer ordinary clicks in this mode."

## Phases

Each phase ends with `npm test`, `npm run compile` and `npm run build` passing, updates `.agents/instructions/hermod-agents-overview.md` for what it changed, and is usable on its own.

1. **Runtime groundwork.** Image results, per-call always-ask, page-view trimming, steering inbox, sub-runs interface, per-agent limits. Runner tests with the scripted fake model:
   - an image result reaches the request;
   - page views trim in batches;
   - `{ always: true }` asks in `never` mode;
   - a steer pushed mid-run appears after the next tool results;
   - stopping a parent stops its child.
2. **Page tools and guardrails.** `page-guardrails.ts` with descriptor-fixture tests first; then `read_page`, `find`, `click`, `type_text`, `select_option`, `press_key`, `scroll`, `wait_for`.
3. **The web task agent and the handoff.** `delegated/web_task`, its own window and ownership in the resolver and snapshot, `report_result`, the four delegation tools, `lib/sub-runs.ts`, nested steps in the run view, main agent prompt changes. Manual checks on real sites:
   - a search form;
   - a login page (must stop with `needs_user`);
   - a shop checkout (must stop at payment);
   - a React-controlled form;
   - a mixed command ("close my YouTube tabs and add this to my cart").
4. **Screenshots.** `screenshot` and `click_at`.
5. **Queue and steering UI.** Queued messages with Steer and remove, the port messages, persistence in `storage.session`, the steering section in the main agent's prompt. Check: steer while the main agent works, steer while a web task works (relayed), steer just as the command finishes (becomes the next command).
6. **Concurrent threads and indicators.**
   - The scheduler in `background.ts`, with the concurrency cap and serialised thread writes.
   - Approval routing across threads.
   - Thread activity and `lastViewedAt`.
   - Dots on the thread list and threads button.
   - The toolbar icon dot.
7. **Later, only if needed.**
   - `chrome.debugger` for trusted input and background-tab screenshots, behind the `debugger` permission and its "is debugging this browser" banner.
   - Iframes via `executeScript` `frameIds`.
   - Two web tasks at once within one command.
   - A Settings picker for the web task model.

## Risks and open points

- **Brief quality depends on Haiku at low effort.** If briefs come out thin in phase 3's checks, raise the main agent's effort when it delegates, or give it a fixed brief checklist in `instructions.md`. The code-attached `userCommand` and steering messages are the safety net.
- **Cost.** A 40-turn Sonnet web task costs far more than a tab command; caching and page-view trimming keep it down. The run view's cost display should include the web task's usage, summed into the command.
- **Script-driven input.** `element.click()` and the native value setter cover most sites. Sites that check `isTrusted` won't respond; phase 7 is the answer if that turns out common.
- **Untrusted pages.** Acting on pages makes injection more dangerous than reading them. The guardrails and always-ask rules limit the damage; in Don't ask mode, a malicious page can still steer ordinary clicks, and the mode description says so.
- **Unfocused windows in Vivaldi.** If `focused: false` still steals focus, fall back to a normal window created behind the current one and refocus the user's window straight after.
- **Service worker lifetime.** Runs get longer and overlap. The keep-alive covers them; a 20-minute web task alongside another thread's command is the case to test.
