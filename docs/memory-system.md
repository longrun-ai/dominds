# Memory System (Agent User View)

Dominds is designed around **intentional, layered memory**.

The goal is simple:

- Keep the **chat history** disposable.
- Keep a small set of **high-value, curated artifacts** that can survive `clear_mind` and drive reliable progress.

This doc defines the *ideal* usage contract for these layers, and the expected product behavior that supports it.

## The Layers (what exists, what it’s for)

### 1) Taskdoc (`*.tsk/`) — Canonical task contract

**Purpose**: the single source of truth for the task.

- `goals`: what must be true when done.
- `constraints`: hard rules, safety constraints, style constraints.
- `progress`: distilled state: what changed, key decisions, next steps.

**Properties**:

- Persists across rounds.
- Always meant to be small enough to read every turn.
- Edited only via `change_mind({ selector, content })`.

**Anti-patterns**:

- Turning `progress` into a scratchpad or raw logs.
- Storing long tool outputs in the Taskdoc.

### 2) Reminders (提醒项) — Curated working set (worklog)

**Purpose**: a small number of “treasure” context items that the agent actively maintains.

Reminders are the best place for **details that are worth paying prompt tokens for**, because:

- They persist across `clear_mind`.
- They are intentionally *curated* by the agent via `update_reminder` / `delete_reminder`.
- They are always injected into the next generation, so they actually influence behavior.

**Two types**:

- **Non-owned reminders (agent-managed)**: your primary worklog / working set.
- **Owned reminders (system-managed)**: lifecycle owned by `ReminderOwner` (auto-update/auto-drop). Treat as signals; do not manually delete.

**Ideal usage rules**:

- Keep the reminder set **small** (often 1–3 items total).
- Prefer **update-in-place** (`update_reminder`) over creating many separate reminders.
- Every reminder must justify its token cost: if it no longer changes decisions, **delete it**.

**Recommended structure for a single “worklog reminder item”**:

- Last updated: timestamp (human-readable)
- What we are doing now: 1–3 bullets
- Key decisions frozen: 1–5 bullets
- Next steps: 3–8 actionable bullets
- “Do not forget”: 1–3 high-risk notes

### 3) Personal memory (`.minds/memory/individual/<memberId>/…`) — Stable personal habits

**Purpose**: durable “how I work” knowledge for a specific agent persona.

Use it for:

- personal conventions,
- heuristics,
- stable preferences.

Do **not** use it for:

- per-task state,
- per-workspace facts that should be shared,
- transient tool outputs.

Tools:

- `add_memory`, `replace_memory`, `drop_memory`, `clear_memory`.

### 4) Team memory (`.minds/memory/team_shared/…`) — Stable shared conventions

**Purpose**: durable knowledge that should be shared across the whole team and all dialogs.

Use it for:

- repo conventions,
- architecture decisions,
- “how we run tests here”,
- cross-agent contracts.

Tools:

- `add_team_memory`, `replace_team_memory`, `drop_team_memory`, `clear_team_memory`.

### 5) Tool-call history / chat messages — Disposable and unreliable

**Purpose**: short-lived working buffer.

Tool-call results and long file reads can be huge. They are useful to decide the next move, but they are not a good long-term memory substrate.

**Rule**: if you will need it later, **distill it** into:

- Taskdoc `progress` (decision + next steps), and/or
- a reminder item (detailed but curated), and/or
- team/personal memory (only if it’s truly stable).

Never rely on “I read it earlier” as a durable assumption.

## The Hygiene Loop (how to work day-to-day)

### Default loop

1) Do work using tool calls as needed.
2) Distill:
   - update Taskdoc `progress` with decisions and next steps;
   - update a small reminder worklog with any crucial details.
3) `clear_mind` to drop noisy chat/tool history.

### When context health turns yellow/red

- Yellow (警告): stop adding new large inputs; start distilling now.
- Red (危险): treat as a hard stop: distill immediately; do not continue implementation first.

At yellow/red, the correct behavior is not “keep going until it breaks”. The correct behavior is:

- compress what you need into Taskdoc + reminders,
- then clear.

## Expected Product Behavior (what Dominds should enforce)

To make the above reliable, Dominds should:

- Treat reminders as a **first-class working set**, not as an annoyance.
- Encourage **update-in-place** reminder maintenance, and discourage reminder spam.
- Make owned reminders clearly “system-managed” without suggesting manual deletion.
- Make `clear_mind` psychologically cheap:
  - explicitly state that Taskdoc and reminders are preserved,
  - explicitly instruct the distill → clear sequence.

## Practical examples

### Example: huge tool output

- Put only the decision + next step in Taskdoc `progress`.
- Put the essential excerpt (not the whole dump) in a reminder worklog.
- Then `clear_mind`.

### Example: stable repo convention

- Put it in team memory, not in reminders.

### Example: my personal workflow preference

- Put it in personal memory.
