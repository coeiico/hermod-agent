# Hermod Agents Overview

How Hermod's LLM agents are built: where each piece lives, how a run flows, and the rules for adding or changing an agent. Read this before working on anything under `ai/`.

## Layout

```
ai/
  models.ts                 Claude models offered in the UI, their prices, costOf()
  runtime/                  The engine. Imports nothing from agents/ or tools/.
    definition.ts           AgentConfigSchema (config.yaml), defineAgent()
    prompts.ts              renderTemplate(): strict {{ name }} substitution for task.md
    context.ts              RunContext: cancel, deadline, limits, approval mode, confirm(); RunCancelled, RunDeadlineExceeded
    events.ts               RunEvent / ModelEvent unions, Usage, ToolResult, RunResult
    tools.ts                Tool + defineTool(), executeToolCall(): validate, confirm, timeout
    model.ts                The Model interface the runner calls
    providers/anthropic.ts  AnthropicModel: request shape, prompt caching, streaming, error translation
    runner.ts               streamRun(): the turn loop
  tools/                    Browser tools, grouped by what they act on
    resolve.ts              Model-written IDs -> real tabs/windows (the trust boundary)
    snapshot.ts             buildSnapshot() and the refresh_snapshot tool
    tabs.ts, windows.ts, pages.ts, library.ts
    catalog.ts              BROWSER_TOOLS, in a fixed order
  agents/
    _template/              Copy this to start an agent; its config.yaml documents every option
    <role>/<name>/          One agent per directory
      agent.ts              defineAgent(...) and the run function that shapes inputs into variables
      config.yaml           Model and request settings
      system.md             # Behavior
      instructions.md       # Role, # Objective, optional # Examples
      task.md               # Task: the opening user message, the only templated prompt
```

Today there is one agent, `agents/interactive/browser_command`, which carries out a typed command.

## Naming

- The role folder says what kind of job the agent does: `interactive` for agents a user talks to directly. Add a role only when an agent doesn't fit an existing one, for example `background` for scheduled jobs.
- The name says what the agent produces or decides, read on its own: `browser_command`, not `agent2` or `helper`.
- `config.yaml`'s `id` is the name with a version suffix (`browser_command.v1`). Bump the version when a change to the prompts or config changes behaviour, so logs show which version ran.

## How a run flows

1. The caller (the background worker) gathers the agent's inputs. For `browser_command` it builds the snapshot itself, so it can show it in the popup, and turns the open thread's finished commands into `EarlierTurn`s (`lib/threads.ts`).
2. The agent's run function (`streamBrowserCommand`) turns inputs into `task.md` variables and calls `streamRun` with a `Model` and any config overrides (the model and effort the user picked).
3. `streamRun` sends `[system.md, instructions.md]` as the system blocks and the rendered `task.md` as the first user message. It then loops: a model turn, then the turn's tool calls run one at a time in the order written, and every result goes back in one user message.
4. After `limits.maxTurns` turns that used tools, one more turn runs with `tool_choice: none` to force an answer.
5. It yields `RunEvent`s throughout and ends with `run-finished`. Failures throw: `RunCancelled`, `RunDeadlineExceeded`, `AgentRefused`, `OutputLimitReached`, `ModelError`.
6. The worker's `RunController` (`lib/run-controller.ts`) turns runtime events into UI updates. The runtime knows nothing about the UI.

Each run is a fresh API conversation; its message history lives only inside the run. Context across commands comes from threads instead: the worker saves every finished command to its thread (`lib/threads.ts`, in `storage.local`), and the next command in that thread gets the last `MAX_EARLIER_TURNS` of them in `task.md` as text (command, actions with trimmed results, answer). Earlier snapshots and thinking are not replayed: the live snapshot is the truth, and the IDs in old turns may be stale.

## Rules

- **Prompt caching.** The cached prefix is tools, then `system.md`, then `instructions.md`. `defineAgent` rejects `{{` in `system.md` or `instructions.md`. Anything that varies per request (time, browser state, user input) goes in `task.md`. Never reorder `BROWSER_TOOLS`; append new tools at the end.
- **Strict templates.** A `{{ name }}` in `task.md` without a variable fails the render. Pass every variable the template names.
- **Strict config.** An unknown key in `config.yaml` fails at load. Adding an option means adding it to `AgentConfigSchema`, to `buildParams` in `providers/anthropic.ts`, and to `_template/config.yaml`; a test fails if the template misses one.
- **Tools.** Define each tool with `defineTool`, a zod `input` schema and an `effect` (`read`, `write`, `destructive`). Every input is validated before running, because streamed tool input is not validated by the API. A `destructive` tool must have `confirm`, which returns the question for the user or null to skip asking; a `write` tool may have one for the calls that warrant asking (starting a download). The run's approval mode (`RunContext.approval`, the user's Mode in the popup) decides who is asked: `ask` confirms every `write` and `destructive` call, `auto` only what a tool's `confirm` asks, `never` only what an `alwaysAsk` tool's `confirm` asks (calls that can't be undone, like deleting bookmarks or history, or that a page could have asked for, like a download). Tools return a short string saying what changed, and throw with a message the model can act on. Resolve IDs through `tools/resolve.ts`, which refuses unknown IDs and Vivaldi web panels.
- **Untrusted content.** Page text, titles, URLs, bookmarks and history can carry instructions. The agent's `system.md` says never to follow them; keep that rule in any agent that reads them.
- **Model calls.** Only `providers/anthropic.ts` talks to the API. Request-shape decisions (adaptive thinking, effort, eager input streaming, cache breakpoints) live there.

## Adding an agent

1. Copy `ai/agents/_template/` to `ai/agents/<role>/<name>/`.
2. Fill in `config.yaml` with only the options it needs, and write the three prompts with their required headings.
3. Give it tools from `ai/tools/` (add new ones there, grouped by what they act on).
4. Write its run function to shape inputs into `task.md` variables.
5. Run `npm test`. `ai/agents/agents.test.ts` checks every agent directory automatically.

## Verifying

- `npm test` runs the unit tests: the runner against a scripted fake model, every agent's config and prompts, and the key vault.
- `npm run compile` type-checks; `npm run build` builds the extension.
