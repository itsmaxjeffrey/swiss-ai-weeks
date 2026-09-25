# USER.md - User Model

Store stable user preferences and profile facts as directives that can guide future sessions.

Use one directive per entry:

```md
<!-- observed: YYYY-MM-DD | status: active -->

- Prefer concise progress updates during implementation work.
```

- Begin each directive with an imperative such as `Always`, `Never`, or `Prefer`.
- Record the observation date and either `active` or `superseded` on the metadata line.
- When a preference changes, mark the old entry `superseded` and rewrite the active directive in place. Never append a contradictory active directive.
- Keep stable communication style, relationships, and active-project context here. Put durable non-profile facts and decisions in `MEMORY.md`.
- Save this file at the workspace root as `USER.md`. It loads every session with a separate 4,000-character budget.

## Directives

<!-- observed: 2026-09-24 | status: active -->

- Always break non-trivial tasks into explicit numbered steps before starting, announce which step is in progress as work advances, and briefly explain how each step is done (tool, command, or method and why) — keep explanations short, not essays.

<!-- observed: 2026-09-24 | status: active -->

- For multi-step work, always maintain a progress card (`progress_card`) with an ordered plan checklist (pending/in_progress/completed) and update it as each step completes, so progress stays visible outside the chat transcript.

## Related

- [Agent workspace](/concepts/agent-workspace)
