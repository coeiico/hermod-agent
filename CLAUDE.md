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

## LLM Agent Overview

The primary folder that contains the LLM agent infrastructure is `src/baritone/ai`. Each agent is one directory, `src/baritone/ai/agents/<role>/<name>/`, holding its code (`agent.py`), config and prompts together. The role folder (`analysis`, `assessment`, `response`, `gates`, `policy`, `interactive`, `research`) says what kind of job the agent does, and the name says what it produces or decides, read on its own (`incident_profile`, `reanalysis_gate`). Agents are not named after the incident field they write: Elasticsearch field names stay as they are. Follow the naming rules in `baritone-agents-overview.md` before adding or renaming an agent. Every agent inherits from the base agent in `src/baritone/ai/runtime/agent.py`, which finds the agent's directory from the subclass's module, so no agent declares a path. The engine that runs agents is `src/baritone/ai/runtime/` (the run loop, prompts, tools, sub-agents, providers); it imports nothing from `agents/`, `tools/`, `policies/`, `elastic/` or `ingestion/`. Every agent's `run` takes a `RunContext` (site, actor, permissions, limits) first, tools are `Tool` objects the agent class declares (`tools = (...)`), each with a declared effect, and templates render with `StrictUndefined`.
We use context engineering (more advanced prompt engineering) for each agent: its prompts sit beside `agent.py` and use markdown and jinja2. Partials shared between agents live in `src/baritone/ai/agents/_partials/`.

`system.md` - The system prompt
`instructions.md` - The developer prompt (sent as the developer message)
`task.md` - The user prompt
`output_schema.json` - The structured output format, if the agent returns structured output; the runtime parses the answer against it
`config.yaml` - The model and sampling config; `agents/_template/config.yaml` lists every option, and an unknown key fails at load

- Use './.agents/instructions/baritone-agents-overview.md' for more context and or structural overview when working on AI/LLM related task.
- Keep './.agents/instructions/baritone-agents-overview.md' updated if any changes are made to the agent architecture.

The system prompt 'system.md' has the following required headers:
```md
# Behavior
```

The developer prompt 'instructions.md' has the following required headers:
```md
# Role
# Objective
# Examples (optional)
# Structured Output (Context and Guidance for Structured Output)
(this header is only required for agents that have an `output_schema.json` file indicating that the agent returns structured output)
```

The user prompt 'task.md' has the following required headers:
```md
# Task
```