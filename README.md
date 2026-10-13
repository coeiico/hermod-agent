# Hermod Agent

![Hermod — the Messenger](assets/brand/banner.png)

A Manifest V3 extension for Vivaldi that turns plain-language requests ("move this tab to the window with my GitHub stuff") into browser actions, using Claude through the Messages API.

## Run it

```bash
npm install
npm run build
```

Then in Vivaldi: `vivaldi://extensions` → Developer mode on → **Load unpacked** → pick `.output/chrome-mv3`.

For development, `npm run dev` rebuilds on change; reload the extension in `vivaldi://extensions` to pick up worker changes. `npm test` runs the unit tests.

How agents are structured, and how to add one: [.agents/instructions/hermod-agents-overview.md](.agents/instructions/hermod-agents-overview.md).

First use: click the toolbar icon (or press **Alt+Space**), open **Settings**, paste a Claude Console API key, keep or change the passphrase (default `dank memes`), and **Save key**.

## Layout

| Path | What it is |
| --- | --- |
| `entrypoints/background.ts` | Service worker: owns the key, runs commands, streams progress to the popup |
| `entrypoints/popup/` | Prompt window (AI Elements chat UI) |
| `entrypoints/options/` | Settings / Manage keys page |
| `ai/runtime/` | The agent engine: run loop, tool execution and confirmations, run context and limits, Anthropic provider |
| `ai/agents/interactive/browser_command/` | The command agent: `config.yaml`, `system.md`, `instructions.md`, `task.md`, `agent.ts` |
| `ai/agents/_template/` | Starting point for a new agent; its `config.yaml` documents every option |
| `ai/tools/` | Browser tools grouped by what they act on, the snapshot builder, and the fixed-order catalog |
| `lib/threads.ts` | Saved threads in `storage.local`, and the earlier commands each new command is given as context |
| `lib/run.ts`, `lib/run-controller.ts` | UI run state shared by worker and popup, and the adapter from runtime events to it |
| `lib/vault.ts`, `lib/keystore.ts` | PBKDF2 + AES-GCM key vault; decrypted key only in `storage.session` |
| `components/ai-elements/` | Vendored AI Elements (edited: no remote logos, JSON-only Shiki, no Streamdown plugins) |
| `assets/tailwind.css` | Theme: the Baritone design language (tokens, type and control scale, both themes) |

## Notes and decisions

- **Request shape:** `claude-haiku-5-5` by default (Sonnet 5.5 selectable), adaptive thinking with summarized display, effort `low` by default, `max_tokens` 8000 (thinking counts against it; 1024 risked cutting off tool calls). Tools have `eager_input_streaming`, so every tool input is validated with zod before running.
- **Caching:** an explicit breakpoint on the system block caches tools + system (~7.3K tokens), and top-level automatic caching covers the snapshot so round 2 of a command reads it from cache. Optional 1-hour TTL in Settings.
- **Page access:** `<all_urls>` is requested up front. Optional per-site permissions would need a permission prompt from the popup on first `get_page_text` for each site (the worker can't show one), which works against convenience. Revisit before any store release.
- **Web panels:** tabs whose `vivExtData` has a `panelId` are hidden from the snapshot and rejected by every tool. Check this against your Vivaldi version.
- **Design:** the UI follows the [Baritone design system](https://claude.ai/artifact/2y3oeBNsQtCBxy5mn13dKb): warm neutrals, `surface` islands on a `ground` page, one clay accent, Inter for the interface and Petrona for titles. Fonts are bundled through Fontsource, so nothing loads from Google at runtime. The `components/ui` primitives carry its recipes, so prefer tokens (`ink-2`, `line`, `sage-ink`) and the control heights (`h-[var(--control-h)]`) over raw Tailwind colours and ad-hoc `h-*`.
- **Testing:** `.env` (git-ignored) is only for local testing; the extension never reads it.
