# CLAUDE.md

## Commits

- Never commit unless the user explicitly instructs you to. A request to make a change is
  not a request to commit it, and an instruction to commit covers that commit only, not
  later work.
- Every commit message follows `.github/commit-message-instructions.md`. Read it before
  writing one.

## Plans

- User requested plans go in `.agents/plans/`.
- You may read plans.
- You may modify plans when requested to do so by a user, or when receiving permission from the user to do so.
- Do not execute plans unless explicitly instructed to.
- Every plan opens with this header: the title, a short paragraph saying what the plan does
  and why, a line recording the date and the commit it was written against
  (`git rev-parse --short HEAD`). The commit tells a later reader
  which code the plan's findings, line references and file lists describe.

  ```md
  # Plan — <Plan Name>

  <One short paragraph: what the plan changes, and why.>

  Written <YYYY-MM-DD> against `<short commit hash>`.
  ```

## General Formatting and Style

- Whenever a language allows, use 2 spaces for indentation.
- If there is no semantic difference between single quotes and double quotes then prefer single quotes over double quotes.

## Code Design

- Use `./.agents/instructions/code-design.md` for how code itself is written: simplicity, function shape, abstraction discipline, data modeling, dependency direction, and error handling.
- Use `./.agents/instructions/project-structure.md` for where code belongs.

## Memory

`.agents/memory/` is the project's memory for agents: what you would otherwise have to rediscover each session. Read the file that covers your task before starting, and keep it true as you work.

- `.agents/memory/codebase-map.md` - where everything lives, one line per file or directory. Update it when you add, move or remove something a reader would look for.
- `.agents/memory/decisions.md` - choices made on purpose and quirks of the project, with the reason for each. Read it before changing anything it covers.

When you learn something a later agent would need and can't get from the code or git history (a decision and why it was made, a quirk, a workaround, a browser or API behaviour you had to discover), write it down here: add it to the file that fits, or start a new file with a short, plain name and list it above. Remove or correct entries that stop being true. Keep it for agents: user-facing documentation belongs in `README.md`.

## Project Overview

Hermod Agent is a Chromium Manifest V3 browser extension (WXT + React + TypeScript + Tailwind + shadcn/ui + AI Elements). The user types a plain-language command and a Claude agent carries it out with browser tools.

- `entrypoints/background.ts` - the service worker: owns the API key, runs agents, streams progress to the popup.
- `entrypoints/popup/`, `entrypoints/options/` - the prompt window and the settings page. Interfaces only; no agent logic.
- `ai/` - the LLM agents, their runtime and their tools (below).
- `lib/` - the rest of the extension: the run state shared with the popup (`run.ts`, `run-controller.ts`, `use-run.ts`), settings, and the key vault.
- `components/` - `ui/` (shadcn), `ai-elements/` (vendored AI Elements, edited: nothing may load from the network), `hermod/` (Hermod's own).

Verify with `npm test` (unit tests), `npm run compile` (types) and `npm run build`. `npm run e2e` builds, then drives the extension end to end in headless Chromium against a local test shop and a scripted fake Claude API (`e2e/`); it needs Playwright's Chromium (`npx playwright install chromium`) or `HERMOD_E2E_CHROME`.

## LLM Agent Overview

The LLM agent infrastructure lives in `ai/`. Each agent is one directory, `ai/agents/<role>/<name>/`, holding its code (`agent.ts`), config and prompts together. The role folder (`interactive`) says what kind of job the agent does, and the name says what it produces or decides, read on its own (`browser_command`). Follow the naming rules in `hermod-agents-overview.md` before adding or renaming an agent. An agent is a `defineAgent(...)` call in its `agent.ts`, which imports its config and prompts with Vite `?raw` imports, plus a run function that shapes the agent's inputs into template variables and calls `streamRun`. The engine that runs agents is `ai/runtime/` (the run loop, prompts, tool execution, run context, the model interface and the Anthropic provider); it imports nothing from `ai/agents/` or `ai/tools/`. Every run takes a `RunContext` (cancel, deadline, limits, and the confirmation hook) and a `Model`. Tools are `Tool` objects built with `defineTool`, each with a zod input schema and a declared effect (`read`, `write`, `destructive`); browser tools live in `ai/tools/`, grouped by what they act on, and `ai/tools/catalog.ts` fixes their order. `task.md` renders with strict `{{ name }}` substitution: a missing variable fails the render.

We use context engineering (more advanced prompt engineering) for each agent: its prompts sit beside `agent.ts` as markdown.

`system.md` - The system prompt (first cached system block)
`instructions.md` - Role, objective and examples (second cached system block; the Messages API has no developer role)
`task.md` - The user prompt, the only templated prompt
`config.yaml` - The model and request config; `ai/agents/_template/config.yaml` lists every option, and an unknown key fails at load

`system.md` and `instructions.md` are part of the cached prompt prefix and must never contain template variables, timestamps or anything else that changes per request.

- Use './.agents/instructions/hermod-agents-overview.md' for more context and or structural overview when working on AI/LLM related task.
- Keep './.agents/instructions/hermod-agents-overview.md' updated if any changes are made to the agent architecture.

The system prompt 'system.md' has the following required headers:
```md
# Behavior
```

The instructions prompt 'instructions.md' has the following required headers:
```md
# Role
# Objective
# Examples (optional)
```

The user prompt 'task.md' has the following required headers:
```md
# Task
```

`ai/agents/agents.test.ts` checks these headers and every config for each agent directory.
