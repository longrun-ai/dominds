# Memory System (Agent User View)

Chinese version: [中文版](./memory-system.zh.md)

Dominds’ “memory system” is really **context engineering**: put information into the right container based on stability and sharing scope, so long‑running work stays fast, correct, and transparent to humans.

TL;DR:

- Make dialog history disposable (noise is cheap to drop).
- Make key artifacts survivable (you can `clear_mind` and still keep moving).
- Publicly declare and openly discuss progress in real time (and keep it auditable) to enforce timely coordination: that’s where the real leverage comes from when multiple agents and multiple mainline dialogs work in parallel (Taskdoc / team memory / env notes).

Key rule: **the Taskdoc is the task’s live coordination bulletin board**. Put key decisions/status/next steps in `progress`, hard rules in `constraints`, and don’t leave them only in chat or reminders.

Related terminology: [dominds-terminology.md](./dominds-terminology.md)

## Table of Contents

- [Layering model (space dimension)](#layering-model-space-dimension)
  - [Permissions and division of labor](#permissions-and-division-of-labor)
- [Layering model (time dimension)](#layering-model-time-dimension)
  - [A) Long-term memory: lock in division of labor and governance](#a-long-term-memory-lock-in-division-of-labor-and-governance)
  - [B) Task-term memory: Taskdoc is the single source of truth](#b-task-term-memory-taskdoc-is-the-single-source-of-truth)
  - [C) Short-term memory: dialog history is a buffer, reminders are a working set](#c-short-term-memory-dialog-history-is-a-buffer-reminders-are-a-working-set)
- [Day-to-day workflow (operational health)](#day-to-day-workflow-operational-health)

---

## Layering model (space dimension)

The same information can be categorized by “who needs to see it / who maintains it”. This axis is orthogonal to long‑term vs short‑term, and helps avoid treating team agreements as personal worklogs (or vice versa).

- **Individual-scope (per-agent / per-dialog)**:
  - `persona` / `knowledge` / `lessons` (role definitions assigned per member)
  - individual memory (`memory`)
  - dialog history (including tool calls and outputs)
  - reminders (working set / worklog)
- **Collective-scope (shared by team/task)**:
  - rtws-level “env notes” (`.minds/env*.md`): the workspace’s baseline facts, runtime constraints, and gotchas
  - team memory (`team_memory`)
  - Taskdoc: in a healthy workflow, the same Taskdoc is expected to be progressed by multiple mainline dialogs (different responders), so treat it as the collective single source of truth

### Permissions and division of labor

“Collective memory” does not mean “everyone can edit everything”. A core Dominds principle is social division of labor:
team governance and team management are functions too.

- Team-memory tools (`add_team_memory` / `replace_team_memory` / `drop_team_memory` / `clear_team_memory`) are typically granted only to a small subset of agents (governance roles).
- Content under `rtws/.minds/` (including env notes) is typically editable only by agents with the **team_mgmt toolset**.
- If you don’t have the permission, the right move is: draft a patch-level proposal (content + rationale + impact) and tellask the responsible role agent to apply it, instead of leaving key agreements in chat or private reminders.

---

## Layering model (time dimension)

This doc uses three time horizons: long-term / task-term / short-term (dialog). This axis is orthogonal to sharing scope (individual vs collective): the same fact has both a time horizon and a scope.

- **A) Long-term memory (stable, cross-dialog)**
  - **Org structure (static definitions)**: `persona` / `knowledge` / `lessons`
  - **Team governance (shared)**: team memory
  - **Agent-owned**: individual memory
- **B) Task-term memory (survives dialog courses)**
  - **Auto-injected Taskdoc core**: `goals` / `constraints` / `progress`
  - **Extra Taskdoc sections (on-demand recall)**: the fixed `bearinmind/` set (`contracts` / `acceptance` / `grants` / `runbook` / `decisions` / `risks`), plus any task-specific sections (see [encapsulated-taskdoc.md](./encapsulated-taskdoc.md))
- **C) Short-term memory (high-noise, disposable)**
  - **Pulled by the agent**: dialog history, tool calls and outputs
  - **Pushed by the environment**: reminders such as background process status, MCP rentals, etc.
  - **Curated by the agent**: part of the reminders set (working set / worklog)
  - **Mental hygiene**: `clear_mind`

### A) Long-term memory: lock in division of labor and governance

Long-term memory is for things that should remain true across dialogs: who you are, what you own, and how the team operates.

#### 1) `persona` / `knowledge` / `lessons`: static role allocation

These docs “pin” an agent into a durable role in the team:

- `persona`: identity + style (voice, working habits, scope boundaries, preference constraints)
- `knowledge`: stable expertise and capability boundaries (what you’re good at; your tool/safety stance)
- `lessons`: accumulated learnings (which paths are safer; which traps to avoid)

They are not for task progress. Their job is to keep the division of labor stable, so the team doesn’t reinvent roles every time.

#### 2) Team memory: shared governance

Team memory should contain only **truly stable, worth-sharing** knowledge, such as:

- repo conventions (naming, directory contracts)
- architecture decisions and invariants
- reusable “how we run tests/deploy here” procedures
- cross-agent collaboration contracts

Tools:

- `add_team_memory` / `replace_team_memory` / `drop_team_memory` / `clear_team_memory`

#### 3) Individual memory: agent-owned, kept accurate

Individual memory is your long-lived “how I work” asset, especially a compact **responsibility-area rtws index**:

- exact paths of key docs/code you own
- minimal key facts (entrypoints, key symbols, local contracts)

This lets you start work within your scope with “0 ripgrep”. The hard constraint is accuracy: if you change related files or detect staleness/conflicts, immediately `replace_memory` to keep it true.

Tools:

- `add_memory` / `replace_memory` / `drop_memory` / `clear_memory`

### B) Task-term memory: Taskdoc is the single source of truth

Taskdocs are the canonical task contract shared by the team. They answer: what we want, what we must not violate, and where we are.

#### The fixed core (auto-injected)

- `goals`: what must be true when done
- `constraints`: hard rules (safety/style/process/compliance)
- `progress`: distilled progress (key decisions, current status, next steps)

#### Practical rules (keep only the essentials)

- Treat `goals / constraints / progress` as a **shared bulletin board**, not a personal scratchpad.
- `progress` is a distilled snapshot; high-frequency details belong in reminders (working set).
- Don’t paste huge tool outputs into Taskdocs. Distill conclusions/evidence, or keep a curated excerpt in reminders.

For extra sections and `*.tsk/` packaging semantics, see: [encapsulated-taskdoc.md](./encapsulated-taskdoc.md).

### C) Short-term memory: dialog history is a buffer, reminders are a working set

Short-term memory is noisy and fast-changing. Use it to move the next step, then distill what matters.

#### 1) Pulled by the agent: dialog history, tool calls, tool outputs

These are useful for immediate decisions, but they grow quickly and go stale. The right pattern is:

- distill “decision + next steps” into Taskdoc `progress`
- keep only token-worthy details in a small reminders set

Never treat “I saw it earlier” as a durable assumption.

#### 2) Pushed by the environment: system reminders

Some reminders are generated by the runtime (e.g. background process status, MCP rentals/expiration). Treat them as signals:

- read and adjust behavior
- but don’t treat them as your personal worklog (their lifecycle is typically system-managed)

#### 3) Curated by the agent: work reminders (working set / worklog)

Reminders are your tiny working set: injected every turn, and preserved across `clear_mind`.

Guidelines:

- keep it to 1–3 items; update-in-place whenever possible
- every item must justify its token cost; delete it when it stops affecting decisions

Tools:

- `add_reminder` / `update_reminder` / `delete_reminder` (some system reminders are managed by a specific tool; update them via that tool)

Recommended structure (one reminder item):

- last updated: timestamp
- what we’re doing now: 1–3 bullets
- frozen key decisions: 1–5 bullets
- next steps: 3–8 actionable bullets
- do not forget: 1–3 high-risk notes

#### 4) `clear_mind`: mental hygiene (start a new course)

When dialog/tool-output noise starts **degrading attention and judgment** (leading to misreads or low-quality decisions), don’t “power through”. Do this instead:

1. distill (Taskdoc + reminders)
2. `clear_mind`

`clear_mind` is designed to make cleanup cheap: dialog history can be dropped, while key artifacts (Taskdocs, memories, reminders) survive so the next course can keep running.

---

## Day-to-day workflow (operational health)

> One bite at a time. One step at a time.

The goal for agents’ day-to-day work is not “write more docs”. It’s a low-cost, reusable cadence: **move one small step → publicly declare progress → drop noise → repeat**.

### Default cadence (close the loop per step)

1. **Move one small step**: make a minimal, verifiable increment (pull history/run commands/read files only when needed).
2. **Publicly declare progress (collective memory)**:
   - put key decisions, current status, and next steps into Taskdoc `progress`
   - put new hard constraints into `constraints` (don’t leave them only in chat/reminders)
   - distill stable conventions into team memory; write rtws baseline facts/constraints into `.minds/env*.md`
3. **Maintain your working set (individual memory)**: compress token-worthy details into a tiny reminders set (1–3 items, prefer update-in-place).
4. **Drop noise (when needed)**: when noise starts degrading attention and judgment, distill first, then `clear_mind` to start a new course.

> Permission note: if you don’t have team-memory tools or the team_mgmt toolset, don’t skip “public declaration”. Draft a merge-ready update and ask the governance/team_mgmt role agent to apply it to `team_memory` or `.minds/**`.

### Where to write what (quick rules)

- **Taskdoc `progress`**: key decisions, current status, next steps (the shared bulletin board)
- **Taskdoc `constraints`**: hard rules/safety/compliance/style (must be visible to all mainlines)
- **Team memory `team_memory`**: stable team conventions and invariants (worth reusing)
- **Env notes `.minds/env*.md`**: rtws baseline facts, runtime constraints, gotchas (align humans + all agents to the same environment)
- **Individual memory `memory`**: personal preferences + responsibility-area rtws index (keep accurate)
- **Reminders**: short-term, high-frequency details (working set / worklog; delete freely)
- **Dialog history / tool output**: disposable by default; only keep distilled excerpts, not raw dumps

### Caution/critical: stop the bleeding first

When context health enters **caution/critical** (see [context-health.md](./context-health.md)), don’t keep piling on new inputs:

1. stop expanding new branches and new large inputs
2. write back what must be shared (Taskdoc / team memory / env notes)
3. compress what you personally still need into reminders
4. `clear_mind` to start a new course
