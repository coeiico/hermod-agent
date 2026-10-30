# Codebase map

Where things live in Hermod Agent, one line each. Read it to find your way before searching; update it when you add, move or remove a file or directory that a reader would look for.

## Extension entrypoints

| Path | What it is |
| --- | --- |
| `entrypoints/background.ts` | Service worker: owns the key, runs commands and web tasks, streams progress to the popup |
| `entrypoints/popup/` | Prompt window (AI Elements chat UI) |
| `entrypoints/options/` | Settings page: API key, mode, model, shortcuts, threads, page access |
| `entrypoints/offscreen/` | Hidden page that copies text to the clipboard for the worker |
| `wxt.config.ts` | Manifest: permissions, icons, keyboard commands |

## Agents and tools (`ai/`)

| Path | What it is |
| --- | --- |
| `ai/runtime/` | The agent engine: run loop, prompts, tool execution and confirmations, run context and limits, model interface |
| `ai/runtime/providers/anthropic.ts` | The Anthropic Messages API provider |
| `ai/models.ts` | The models offered in the UI, with prices for the per-command cost |
| `ai/agents/interactive/browser_command/` | The main agent: runs the user's command. `delegation.ts` starts, steers and waits on web tasks |
| `ai/agents/delegated/web_task/` | The web task agent: works inside pages, in its own window, for the main agent |
| `ai/agents/_template/` | Starting point for a new agent; its `config.yaml` documents every option |
| `ai/agents/agents.test.ts` | Checks every agent's prompt headers and config |
| `ai/tools/catalog.ts` | Every tool, in the fixed order that is part of the prompt-cache prefix |
| `ai/tools/tabs.ts`, `windows.ts`, `library.ts` | Main agent tools: tabs, windows, and bookmarks, history and downloads |
| `ai/tools/pages.ts` | Reading pages: text, links, screenshots, `inspect_element`, and the web task's `read_page` and `find` |
| `ai/tools/task-pages.ts`, `page-actions.ts` | Web task tools: its pages, and clicking, typing and scrolling in them |
| `ai/tools/page-script.ts` | Code injected into pages for the web task (must be self-contained) |
| `ai/tools/page-guardrails.ts` | Hard-coded refuse/always-ask rules for acting in a page, under every approval mode |
| `ai/tools/scope.ts` | The window and tabs a web task may act in, claimed from other runs |
| `ai/tools/resolve.ts` | Turns model-written IDs into real tabs, windows and bookmarks; the trust boundary for tool input |
| `ai/tools/snapshot.ts` | The browser snapshot each request opens with |
| `ai/tools/clipboard.ts` | Clipboard writes through the offscreen document |
| `ai/tools/chat-export.ts`, `chat-transcript.ts` | Exporting a ChatGPT or Claude chat as Markdown: the tool, and the site-specific parsing |

## The rest of the extension (`lib/`)

| Path | What it is |
| --- | --- |
| `lib/run.ts`, `lib/run-controller.ts` | UI run state shared by worker and popup, and the adapter from runtime events to it |
| `lib/use-run.ts` | Popup side of the worker connection |
| `lib/rpc.ts` | One-off request/response messages from the popup and settings page to the worker |
| `lib/slash-commands.ts` | The prompt's slash commands (`/export_chat_to_markdown`): names, matching and parsing; the worker runs them in `runSlashCommand` |
| `lib/threads.ts` | Saved threads in `storage.local`, and the earlier commands each new command is given as context |
| `lib/command-queue.ts` | Commands waiting to run, per thread |
| `lib/web-tasks.ts` | The worker's side of the web tasks a command starts |
| `lib/vault.ts`, `lib/keystore.ts` | PBKDF2 + AES-GCM key vault; decrypted key only in `storage.session` |
| `lib/settings.ts` | Non-secret preferences; defaults come from the main agent's `config.yaml` |
| `lib/detached-window.ts` | Hermod in a window of its own: popped out, and the quick window |
| `lib/run-indicator.ts` | The status dot on the toolbar icon |
| `lib/theme.ts` | Follows the OS light/dark setting |

## Interface

| Path | What it is |
| --- | --- |
| `components/hermod/` | Hermod's own components: run view, thread list, unlock dialog, usage meter, queued messages, slash command menu |
| `components/ui/` | shadcn primitives, carrying the Baritone recipes |
| `components/ai-elements/` | Vendored AI Elements (edited: no remote logos, JSON-only Shiki, no Streamdown plugins) |
| `assets/tailwind.css` | Theme: the Baritone design language (tokens, type and control scale, both themes) |
| `assets/brand/` | Logo master, README banner, concepts, and how the icons were made |
| `public/icon/` | Icon sizes generated from the master (`npm run brand:icons`) |

## Tests and tooling

| Path | What it is |
| --- | --- |
| `*.test.ts` | Unit tests beside the code they cover (`npm test`) |
| `e2e/` | End-to-end run in headless Chromium: a local test shop (`site.mjs`), a scripted fake Claude API (`model.mjs`), a CDP client (`cdp.mjs`) |
| `scripts/generate-icons.sh` | Regenerates `public/icon/` from the brand master |
| `.agents/instructions/` | How code is written and structured, and how agents are built |
| `.agents/plans/` | Plans the user asked for |
| `.agents/memory/` | This file and the other agent memory |
| `INBOX.md` | To-dos and ideas not yet planned |
