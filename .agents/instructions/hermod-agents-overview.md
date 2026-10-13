# Hermod Agents Overview

How Hermod's LLM agents are built: where each piece lives, how a run flows, and the rules for adding or changing an agent. Read this before working on anything under `ai/`.

## Layout

```
ai/
  models.ts                 Claude models offered in the UI, their prices, costOf()
  runtime/                  The engine. Imports nothing from agents/ or tools/.
    definition.ts           AgentConfigSchema (config.yaml), defineAgent()
    prompts.ts              renderTemplate(): strict {{ name }} substitution for task.md
    context.ts              RunContext: cancel, deadline, limits, approval mode, confirm(), steering inbox, child runs; RunCancelled, RunDeadlineExceeded
    events.ts               RunEvent / ModelEvent unions, Usage, ToolResult, RunResult
    tools.ts                Tool + defineTool(), executeToolCall(): validate, confirm, timeout; ToolRefusal
    model.ts                The Model interface the runner calls
    providers/anthropic.ts  AnthropicModel: request shape, prompt caching, streaming, error translation
    runner.ts               streamRun(): the turn loop, steering, page-view trimming
  tools/                    Browser tools, grouped by what they act on
    resolve.ts              Model-written IDs -> real tabs/windows (the trust boundary); refuses tabs a web task holds
    scope.ts                A web task's pages (its window, its brief's tab): scopedTab() is the page tools' trust boundary
    snapshot.ts             buildSnapshot() and the refresh_snapshot tool
    tabs.ts, windows.ts, library.ts
    pages.ts                Reading a page: get_page_text/get_page_links (main agent), read_page/find/screenshot (web task)
    page-script.ts          The function injected into pages: outlines, refs, clicking, typing, keys (self-contained)
    page-actions.ts         click, click_at, type_text, select_option, press_key, scroll, wait_for
    page-guardrails.ts      refusal() and risk(): the hard-coded rules for acting in a page
    task-pages.ts           A web task's own pages: list_pages, open_page, go_to, go_back, show_page, close_page
    catalog.ts              BROWSER_TOOLS and WEB_TASK_TOOLS, each in a fixed order
  agents/
    _template/              Copy this to start an agent; its config.yaml documents every option
    <role>/<name>/          One agent per directory
      agent.ts              defineAgent(...) and the run function that shapes inputs into variables
      config.yaml           Model and request settings
      system.md             # Behavior
      instructions.md       # Role, # Objective, optional # Examples
      task.md               # Task: the opening user message, the only templated prompt
```

There are two agents:

- `agents/interactive/browser_command` carries out a typed command. It changes the browser around pages itself, and hands work inside pages to a web task with its delegation tools (`delegation.ts`: start, wait for, steer and stop a web task).
- `agents/delegated/web_task` works inside pages in its own window, from a brief, and ends with `report_result`. It runs on its own model (Sonnet), not the one picked in the popup.

## Naming

- The role folder says what kind of job the agent does: `interactive` for agents a user talks to directly, `delegated` for agents another agent starts and waits on. Add a role only when an agent doesn't fit an existing one, for example `background` for scheduled jobs.
- The name says what the agent produces or decides, read on its own: `browser_command`, not `agent2` or `helper`.
- `config.yaml`'s `id` is the name with a version suffix (`browser_command.v1`). Bump the version when a change to the prompts or config changes behaviour, so logs show which version ran.

## How a run flows

1. The caller (the background worker) gathers the agent's inputs. For `browser_command` it builds the snapshot itself, so it can show it in the popup, and turns the open thread's finished commands into `EarlierTurn`s (`lib/threads.ts`).
2. The agent's run function (`streamBrowserCommand`) turns inputs into `task.md` variables and calls `streamRun` with a `Model` and any config overrides (the model and effort the user picked).
3. `streamRun` sends `[system.md, instructions.md]` as the system blocks and the rendered `task.md` as the first user message. It then loops: a model turn, then the turn's tool calls run one at a time in the order written, and every result goes back in one user message.
4. After `limits.maxTurns` turns that used tools, one more turn runs with `tool_choice: none` to force an answer.
5. It yields `RunEvent`s throughout and ends with `run-finished`. Failures throw: `RunCancelled`, `RunDeadlineExceeded`, `AgentRefused`, `OutputLimitReached`, `ModelError`.
6. The worker's `RunController` (`lib/run-controller.ts`) turns runtime events into UI updates. The runtime knows nothing about the UI.

### Web tasks

1. The main agent calls `start_web_task` with a brief (`WebTaskBrief`: goal, context, doneWhen, constraints, start). The tool reaches `RunContext.children`, which the worker implements in `lib/web-tasks.ts`.
2. `WebTasks.start` resolves the start (a tab through `resolve.ts`, or a URL opened in a new unfocused window), builds a `TaskScope`, and runs `streamWebTask` under a child `RunContext`: cancelled with its command, the same approval mode and confirmation hook, its own limits (`WEB_TASK_LIMITS`) and steering inbox. The code attaches what the model must not be trusted to copy: the user's command and steers, word for word, and the approval mode.
3. The task's `RunController` broadcasts through its command's as `task-update`s, so the popup shows its steps nested under the `start_web_task` call, and approvals inside it are answered through the command's controller.
4. `wait_for_web_task` returns the task's report (`formatReport`), or returns early when the user steers, so the main agent can decide where the steer goes. When the command ends, any task still running is stopped.
5. While a task runs, its scope is claimed: `resolve.ts` refuses its tabs and window to every other run, and the snapshot marks them.

### Steering and the queue

The worker (`entrypoints/background.ts`) runs one command per thread, up to `MAX_RUNNING` threads at once. A message sent while a thread's command runs waits in `lib/command-queue.ts`; the user can steer it in instead. A steer goes into the command's `SteeringInbox`; the runner appends it as a `<steering>` text block after the next tool results (or carries on after a final answer it arrived with) and reports `steering-read`. A steer that arrives after the run ends is queued as the thread's next command.

Each run is a fresh API conversation; its message history lives only inside the run. Context across commands comes from threads instead: the worker saves every finished command to its thread (`lib/threads.ts`, in `storage.local`), and the next command in that thread gets the last `MAX_EARLIER_TURNS` of them in `task.md` as text (command, actions with trimmed results, answer). Earlier snapshots and thinking are not replayed: the live snapshot is the truth, and the IDs in old turns may be stale. Resuming a stopped, interrupted or failed command is a new run too: it sends the same command as `Resume: <command>` (`resumed` on the run and its `EarlierTurn`), the stopped turn's actions show how far it got, and `instructions.md` says to do only what is left. Tool calls cut off by a stop are recorded as `Not run` or `Interrupted ... may already have taken effect`, so the resumed run knows which to check.

## Rules

- **Prompt caching.** The cached prefix is tools, then `system.md`, then `instructions.md`. `defineAgent` rejects `{{` in `system.md` or `instructions.md`. Anything that varies per request (time, browser state, user input) goes in `task.md`. Never reorder `BROWSER_TOOLS`; append new tools at the end.
- **Strict templates.** A `{{ name }}` in `task.md` without a variable fails the render. Pass every variable the template names.
- **Strict config.** An unknown key in `config.yaml` fails at load. Adding an option means adding it to `AgentConfigSchema`, to `buildParams` in `providers/anthropic.ts`, and to `_template/config.yaml`; a test fails if the template misses one.
- **Tools.** Define each tool with `defineTool`, a zod `input` schema and an `effect` (`read`, `write`, `destructive`). Every input is validated before running, because streamed tool input is not validated by the API. A `destructive` tool must have `confirm`, which returns the question for the user or null to skip asking; a `write` tool may have one for the calls that warrant asking (starting a download). The run's approval mode (`RunContext.approval`, the user's Mode in the popup) decides who is asked: `ask` confirms every `write` and `destructive` call, `auto` only what a tool's `confirm` asks, `never` only what an `alwaysAsk` tool's `confirm` asks (calls that can't be undone, like deleting bookmarks or history, or that a page could have asked for, like a download). `confirm` may instead return `{ question, when }` to set the level per call: `ask` (only in ask mode), `auto` (ask and auto), `always` (every mode); the page actions use it. Tools return a short string saying what changed (or `{ text, image?, pageView? }`), and throw with a message the model can act on; `ToolRefusal` reports a `refused` error for what no mode allows. Resolve IDs through `tools/resolve.ts`, which refuses unknown IDs, Vivaldi web panels, Hermod's own popped-out window (the snapshot leaves both out too) and anything a running web task holds. Page tools resolve tabs through `scopedTab()` in `tools/scope.ts` instead, which only allows the calling task's own pages.
- **Page guardrails.** Every page action describes its target element in the page and checks it with `page-guardrails.ts` before asking or acting: `refusal()` (passwords, one-time codes, card and bank fields, final order or payment buttons, submitting a form with card fields) is refused in every mode; `risk()` makes send, post, delete and unsubscribe buttons and file inputs `always` ask, and form submits ask in `auto`. The model's `consequential` flag also asks in `auto`. The rules match markup and English wording, so they are a backstop; the web task's `system.md` carries the same rules.
- **Injected page code.** `page-script.ts`'s `pageScript` is sent to pages by `scripting.executeScript`, which sends its source, not its closure: everything it uses must be defined inside it.
- **Page views.** Tool results marked `pageView` (outlines, screenshots) are trimmed by the runner once five build up, down to the newest two, in one batch so the prompt cache is rebuilt rarely. Screenshots go to the model as image blocks and are never stored in threads.
- **Untrusted content.** Page text, titles, URLs, bookmarks, history, page outlines and screenshots can carry instructions. Each agent's `system.md` says never to follow them; keep that rule in any agent that reads them. Steering (`<steering>` blocks) is the user, and the prompts say so.
- **Model calls.** Only `providers/anthropic.ts` talks to the API. Request-shape decisions (adaptive thinking, effort, eager input streaming, cache breakpoints) live there.

## Adding an agent

1. Copy `ai/agents/_template/` to `ai/agents/<role>/<name>/`.
2. Fill in `config.yaml` with only the options it needs, and write the three prompts with their required headings.
3. Give it tools from `ai/tools/` (add new ones there, grouped by what they act on).
4. Write its run function to shape inputs into `task.md` variables.
5. Run `npm test`. `ai/agents/agents.test.ts` checks every agent directory automatically.

## Verifying

- `npm test` runs the unit tests: the runner against a scripted fake model, every agent's config and prompts, the page guardrails, the command queue, the thread store and the key vault.
- `npm run compile` type-checks; `npm run build` builds the extension.
- `npm run e2e` builds and runs `e2e/run.mjs`: the built extension in headless Chromium, a local test shop (`e2e/site.mjs`), and a scripted fake Claude API (`e2e/model.mjs`) answering through CDP request interception. It covers delegation, steering, the queue, the guardrails, approvals inside a web task, concurrent threads and the popup's rendering. When an agent's tools or the delegation flow change, update `model.mjs`'s scripts to match.
