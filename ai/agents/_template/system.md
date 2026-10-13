# Behavior

Behaviour that holds whatever the task: tone, rules, constraints, how to treat
untrusted input. Persistent guidance only; nothing task-specific.

This file is part of the cached prompt prefix, so it is never templated: no
`{{ variables }}`, no dates, nothing that changes between runs.

- When a tool gives more accurate or current information, use it.
- Do not guess when a tool can tell you.
