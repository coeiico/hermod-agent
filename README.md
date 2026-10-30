# Hermod Agent

![Hermod — the Messenger](assets/brand/banner.png)

Tell your browser what you want in plain language, and Hermod does it.

Hermod is a Manifest V3 extension for Chromium browsers (Chrome, Edge, Brave, Vivaldi, Opera and others). Type a command into its prompt, and a Claude agent carries it out with your tabs, windows, bookmarks, history and downloads, or works through a website for you in a window of its own.

## What it can do

- **Tabs and windows.** Open, close, move, sort, pin, mute and reload tabs; merge windows, or move and resize them across your screens; copy a set of tabs as a list.
- **Bookmarks, history and downloads.** Create, file and sort bookmarks; search or clear history; reopen closed tabs and windows; pause, resume or cancel downloads.
- **Reading pages.** Answer questions about the pages you have open, pull out their text or links, and look at how something on a page is styled.
- **Exporting AI chats.** Save a ChatGPT or Claude conversation to your downloads as Markdown, word for word, without it passing through the model. The `/export_chat_to_markdown` slash command does the same straight away, with no API call.
- **Working inside websites.** Hand off a multi-step task on a site, such as searching, filling in a form or adding to a cart. It runs in a window of its own while you keep browsing, and you can watch it, steer it or stop it.

Commands come in threads, so a follow-up like "close those" or "undo that" knows what you mean. Threads are saved, and you can come back to one later.

## Install

Hermod isn't in an extension store yet; build it from source. You need [Node.js](https://nodejs.org/) 22 or later.

```bash
git clone https://github.com/coeiico/hermod-agent.git
cd hermod-agent
npm install
npm run build
```

Then load it into your browser:

1. Open the extensions page (`chrome://extensions`, `edge://extensions`, `vivaldi://extensions`, ...).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick the `.output/chrome-mv3` folder.

## Set up

Hermod uses your own [Claude Console](https://console.anthropic.com/) API key. That is pay-as-you-go API billing, separate from a Claude Pro or Max subscription.

1. Click the Hermod icon in the toolbar (or press **Alt+Space**) and open **Settings**.
2. Paste your API key.
3. Choose a passphrase and click **Save key**.

The key is encrypted with your passphrase and stored only in this browser. After the browser restarts, Hermod asks for the passphrase once to unlock it again.

## Use it

Open the prompt and type a command:

- **Alt+Space** opens the toolbar popup.
- **Alt+Shift+Space** opens Hermod over the window you're using.

If a shortcut clashes with your system or browser, change it on your browser's extension shortcuts page (`chrome://extensions/shortcuts`).

**Press Tab for the next step.** Once a command finishes, the empty prompt suggests what you're likely to ask next in that thread, like "Go to the cart" after adding something to it. Press **Tab** to fill it in, then edit it or press Enter.

**Choose how much it asks.** The mode below the prompt decides when Hermod checks with you first:

| Mode | What it does |
| --- | --- |
| Ask first | Asks before every change. |
| Auto (default) | Asks before risky changes. |
| Don't ask | Asks only before what can't be undone. |
| Bypass all | Never asks, even before what can't be undone. |

**Choose a model.** Claude Haiku 5.5 is the default: fast and cheap, and right for clear commands. Switch to Claude Sonnet 5.5 for fuzzy or many-step requests. Each command shows what it cost.

## Privacy

- Hermod talks only to the Claude API (`api.anthropic.com`), with your key. There is no Hermod server, account or analytics.
- Each command sends Claude a summary of your open windows and tabs (titles and addresses), plus whatever the command needs: page text when you ask about a page, a screenshot when you ask how something looks.
- After each command, Hermod makes one more small call (always on Claude Haiku) with the same summary and the thread so far, to suggest your next command.
- Hermod has access to all sites so it can read a page when you ask. It reads pages only for a command, never in the background. Browser-internal pages and extension stores can't be read.
- Your key, settings and threads stay in this browser.
- A web page can contain text written to steer an AI agent. Hermod's guardrails refuse or always ask about risky actions inside pages, but in **Don't ask** mode a page could still steer its ordinary clicks, and in **Bypass all** it could steer a send, post or delete. Use **Auto** or **Ask first** on sites you don't trust.

## Development

```bash
npm run dev      # rebuild on change; reload the extension to pick up worker changes
npm test         # unit tests
npm run compile  # type check
npm run e2e      # end-to-end run in headless Chromium against a local test shop
```

`npm run e2e` needs Playwright's Chromium (`npx playwright install chromium`) or a browser path in `HERMOD_E2E_CHROME`. It answers with a scripted fake Claude API, so it spends no API credit.

Contributor and agent notes live in [CLAUDE.md](CLAUDE.md) and [.agents/](.agents/): how agents are built is in [.agents/instructions/hermod-agents-overview.md](.agents/instructions/hermod-agents-overview.md), and where everything lives is in [.agents/memory/codebase-map.md](.agents/memory/codebase-map.md).

## License

[MIT](LICENSE)
