# Hermod Agent

A Manifest V3 extension for Vivaldi that turns plain-language requests ("move this tab to the window with my GitHub stuff") into browser actions, using Claude through the Messages API.

## Run it

```bash
npm install
npm run build
```

Then in Vivaldi: `vivaldi://extensions` → Developer mode on → **Load unpacked** → pick `.output/chrome-mv3`.

For development, `npm run dev` rebuilds on change; reload the extension in `vivaldi://extensions` to pick up worker changes.

First use: click the toolbar icon (or press **Alt+Space**), open **Settings**, paste a Claude Console API key, keep or change the passphrase (default `dank memes`), and **Save key**.

## Layout

| Path | What it is |
| --- | --- |
| `entrypoints/background.ts` | Service worker: owns the key, runs commands, streams progress to the popup |
| `entrypoints/popup/` | Prompt window (AI Elements chat UI) |
| `entrypoints/options/` | Settings / Manage keys page |
| `lib/agent.ts` | The tool-use loop (streaming, prompt caching, confirmations, 10-round cap) |
| `lib/tools.ts` | Tool catalogue, one thin wrapper per `chrome.*` call |
| `lib/snapshot.ts` | Compact browser snapshot sent with every command |
| `lib/system-prompt.ts` | Cached system prompt (no per-request data allowed here) |
| `lib/run.ts` | Run events + reducer shared by worker and popup |
| `lib/vault.ts`, `lib/keystore.ts` | PBKDF2 + AES-GCM key vault; decrypted key only in `storage.session` |
| `components/ai-elements/` | Vendored AI Elements (edited: no remote logos, JSON-only Shiki, no Streamdown plugins) |

## Notes and decisions

- **Request shape:** `claude-haiku-5-5` by default (Sonnet 5.5 selectable), adaptive thinking with summarized display, effort `low` by default, `max_tokens` 8000 (thinking counts against it; 1024 risked cutting off tool calls). Tools have `eager_input_streaming`, so every tool input is validated with zod before running.
- **Caching:** an explicit breakpoint on the system block caches tools + system (~7.3K tokens), and top-level automatic caching covers the snapshot so round 2 of a command reads it from cache. Optional 1-hour TTL in Settings.
- **Page access:** `<all_urls>` is requested up front. Optional per-site permissions would need a permission prompt from the popup on first `get_page_text` for each site (the worker can't show one), which works against convenience. Revisit before any store release.
- **Web panels:** tabs whose `vivExtData` has a `panelId` are hidden from the snapshot and rejected by every tool. Check this against your Vivaldi version.
- **Testing:** `.env` (git-ignored) is only for local testing; the extension never reads it.
