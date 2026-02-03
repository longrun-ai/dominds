# Memory System / 记忆系统（Agent User View）

Dominds is designed around **intentional, layered memory**.

The goal is simple:

- Keep the **dialog history** disposable.
- Keep a small set of **high-value, curated artifacts** that can survive `clear_mind` and drive reliable progress.

This doc defines the _ideal_ usage contract for these layers, and the expected product behavior that supports it.

## Audience / 读者

This document is written for **agent users (智能体使用者)**.

It intentionally:

- avoids internal storage paths and other implementation details;
- focuses on **the tools you can actually use** and the behavioral contract implied by those tools.

Related vocabulary guide: `dominds/docs/dominds-terminology.md`.

## Table of Contents

- The Layers (what exists, what it’s for)
- The Hygiene Loop (how to work day-to-day)
- Expected Runtime Behavior (what you can rely on)
- Practical examples

## The Layers (what exists, what it’s for)

### 1) Taskdoc (`*.tsk/`) — Canonical task contract

**Purpose**: the single source of truth for the task.

- `goals`: what must be true when done.
- `constraints`: hard rules, safety constraints, style constraints.
- `progress`: distilled state: what changed, key decisions, next steps.

**Properties**:

- Persists across rounds.
- Always meant to be small enough to read every turn.
- Edited only via `change_mind({ selector, category?, content })` (only available in the main dialog; subdialogs must ask the Taskdoc maintainer agent to update — the maintainer @id is printed in the injected Taskdoc status block).
- Extra Taskdoc sections (non-auto-injected) can be read via `recall_taskdoc({ category, selector })`.
- **Shared across teammates** (within the same workspace/taskdoc): every teammate/subdialog sees the same Taskdoc (`goals` / `constraints` / `progress`).

**Shared editing rules (important)**:

- Treat `goals` / `constraints` / `progress` as **team-shared sections** (not personal scratchpads).
- `change_mind` replaces the **entire target section**. Therefore:
  - always start from the current section content;
  - merge/append or compress carefully while preserving meaning;
  - do **not** overwrite or delete other contributors’ entries.
- The Taskdoc is injected inline into the agent context each generation. When you need to review it, rely on the injected Taskdoc content (latest as of this generation) instead of trying to read files under `*.tsk/` via general file tools (they are forbidden and will be rejected).
- When you add/maintain entries, include a clear owner marker, e.g.:
  - `- [owner:@ux] …` or `- [owner:@fullstack] …`
  - or a small owner block like `### @ux` with bullets underneath.

**How to use `progress` (important)**:

- Treat `progress` as a **shared bulletin board**: distilled milestone snapshots only (key decisions / current status / next steps).
- Do **not** use `progress` as a raw worklog. High-frequency details belong in reminders (working set).

**Anti-patterns**:

- Turning `progress` into a scratchpad or raw logs.
- Storing long tool outputs in the Taskdoc.
- Overwriting any Taskdoc section and deleting other contributors’ entries.

### 2) Reminders (提醒项) — Curated working set (worklog)

**Purpose**: a small number of “treasure” context items that the agent actively maintains.

Reminders are the best place for **details that are worth paying prompt tokens for**, because:

- They persist across `clear_mind`.
- They are intentionally _curated_ by the agent via `update_reminder` / `delete_reminder`.
- They are always injected into the next generation, so they actually influence behavior.

**Two types**:

- **Non-owned reminders (agent-managed)**: your primary worklog / working set.
- **Owned reminders (system-managed)**: lifecycle owned by `ReminderOwner` (auto-update/auto-drop). Treat as signals; do not manually delete.

**Ideal usage rules**:

- Keep the reminder set **small** (often 1–3 items total).
- Prefer **update-in-place** (`update_reminder`) over creating many separate reminders.
- Every reminder must justify its token cost: if it no longer changes decisions, **delete it**.

**Scope note**:

- Reminders are **dialog-local** (your working set for this dialog/agent). They are not a team-wide bulletin board.

**Injection semantics (important)**:

- Reminders are **injected into the LLM context every generation**.
- In current code, reminders are rendered primarily as **`role=user` environment guidance** near the last user message.
  This is intentional for salience: reminders should be hard to ignore.
- Reminder injection is **not persisted** into dialog history/events (it is context-only).

**Recommended structure for a single “worklog reminder item”**:

- Last updated: timestamp (human-readable)
- What we are doing now: 1–3 bullets
- Key decisions frozen: 1–5 bullets
- Next steps: 3–8 actionable bullets
- “Do not forget”: 1–3 high-risk notes

### 3) Personal memory — Stable personal habits + responsibility index

**Purpose**: durable “how I work” knowledge for a specific agent persona, plus a compact responsibility-area “workspace index” so you can act without re-reading files.

Use it for:

- personal conventions,
- heuristics,
- stable preferences.
- a **responsibility-area workspace index**: exact file paths (docs and/or code) you own, plus minimal key facts (entrypoints, key symbols, local contracts) that let you directly propose and apply edits without re-reading the workspace.

Do **not** use it for:

- per-task state,
- per-workspace facts that should be shared,
- transient tool outputs.

**Accuracy contract (important)**:

- Treat your responsibility-area workspace index as a curated “single source of truth” for your scope.
- Whenever you change relevant files or detect staleness/conflicts, immediately update personal memory (`replace_memory`) so it tracks the latest workspace facts.

Tools:

- `add_memory`, `replace_memory`, `drop_memory`, `clear_memory`.

### 4) Team memory — Stable shared conventions

**Purpose**: durable knowledge that should be shared across the whole team and all dialogs.

Use it for:

- repo conventions,
- architecture decisions,
- “how we run tests here”,
- cross-agent contracts.

Tools:

- `add_team_memory`, `replace_team_memory`, `drop_team_memory`, `clear_team_memory`.

### 5) Function tool call history / dialog messages — Disposable and unreliable

**Purpose**: short-lived working buffer.

Function tool call results and long file reads can be huge. They are useful to decide the next move, but they are not a good long-term memory substrate.

**Rule**: if you will need it later, **distill it** into:

- Taskdoc `progress` (decision + next steps), and/or
- a reminder item (detailed but curated), and/or
- team memory (only if it’s truly stable), and/or
- personal memory (habits/preferences, plus your responsibility-area workspace index that you keep accurate).

Never rely on “I read it earlier” as a durable assumption.

## The Hygiene Loop (how to work day-to-day)

### Default loop

1. Do work using function tool calls as needed.
2. Distill:
   - update Taskdoc `progress` with decisions and next steps;
   - update a small reminder worklog with any crucial details.
3. `clear_mind` to drop noisy dialog/tool history.

### When context health turns yellow/red

- Yellow (警告): stop adding new large inputs; start distilling now.
- Red (危险): treat as a hard stop: distill immediately; do not continue implementation first.

At yellow/red, the correct behavior is not “keep going until it breaks”. The correct behavior is:

- compress what you need into Taskdoc + reminders,
- then clear.

## Expected Runtime Behavior (what you can rely on)

To make the above reliable, Dominds is expected to:

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
