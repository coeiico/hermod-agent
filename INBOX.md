# Inbox

## Todo

### Start a new thread for each new tab

Opening a new tab should start a new thread automatically, the same way a new window does, instead of carrying on the thread that was open before.

Each tab keeps the thread it was started on. Going back to an older tab and opening the extension there shows that tab's thread, unless a new thread was created in that tab since, in which case it shows the newer one.

Side note: this is a first idea, not the final design. Something needs to be done about which thread the extension opens on, but we still need to work out a smarter approach that feels intuitive and is better for the user.

## Suggestions

### Skip the second API call when every action succeeds

Every command makes at least two model calls: one that picks and runs the tools, and one more that only writes the closing summary line ("Moved 3 YouTube tabs to a new window."). Measured against the real API, simple commands take 1.9–3.8s, and the second call is roughly a second of that.

Idea: ask the model (in `instructions.md`) to write its one-line summary as text alongside the tool calls in the same response. When every tool call in that response succeeds, and none of them were read-only data tools whose results the model still needs to look at (`search_history`, `get_page_text`, `refresh_snapshot`, ...), end the run with that pre-written summary instead of making the second call. If any call fails, is declined, or returns data to read, continue the loop as now.

Trade-offs to weigh:

- The summary is written before the results exist, so it can claim something that didn't happen. Only use it when every result is `ok`.
- It departs from "loop until `end_turn`" in the original handoff, and changes `ai/runtime/runner.ts`, which every agent shares; it may belong as an opt-in per agent (`config.yaml`).
- Thread history would record the pre-written summary as the answer.

### Browser use toolset for acting inside pages

Claude's browser use tool (`browser_toolset_20260801`, GA, works with Haiku 5.5) lets Claude act inside web pages: click, type, fill forms, read the accessibility tree, take screenshots. It is client-executed: Hermod would have to implement every member action itself, most likely through `chrome.debugger` (CDP) for real clicks, keystrokes, screenshots and the accessibility tree. That shows Vivaldi's "being debugged" banner while it runs.

Worth considering as an opt-in mode later, starting with the read-only members (`read_page`, `find`, `get_page_text`, `screenshot`) and leaving tab management to Hermod's own tools. Anthropic's guidance is to run it in an isolated browser profile, not one with the user's logged-in sessions, because a page can try to steer Claude (prompt injection). Weigh that before enabling clicks and typing in the user's main browser.
