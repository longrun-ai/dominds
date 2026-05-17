# Memory System (Agent User View)

Chinese version: [中文版](./memory-system.zh.md)

Dominds’ “memory system” is really **context engineering**: put information into the right container based on stability, sharing scope, and execution semantics, so long‑running work stays fast, correct, and transparent to humans.

TL;DR:

- Make dialog history disposable (noise is cheap to drop).
- Make key artifacts survivable (you can `clear_mind` and still keep moving).
- Treat skills as first-class context assets: memory stores facts/indexes/consensus, while skills capture reusable “when to do it, how to do it, and where the boundary is” operating guidance.
- Publicly declare and openly discuss progress in real time (and keep it auditable) to enforce timely coordination: that’s where the real leverage comes from when multiple agents and multiple Main Dialogs work in parallel (Taskdoc / team memory / env notes).

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
  - [Where to write what (quick rules)](#where-to-write-what-quick-rules)
  - [Memory vs skills: selection rules](#memory-vs-skills-selection-rules)

---

## Layering model (space dimension)

The same information can be categorized by “who needs to see it / who maintains it”. This axis is orthogonal to long‑term vs short‑term, and helps avoid treating team agreements as personal worklogs (or vice versa).

- **Individual-scope (per-agent / per-dialog)**:
  - `persona` / `knowhow` / `pitfalls` (role definitions assigned per member)
  - individual memory (`personal_memory`)
  - individual skills (`.minds/skills/individual/<member-id>/...`)
  - dialog history (including tool calls and outputs)
  - reminders (working set / worklog)
- **Collective-scope (shared by team/task)**:
  - rtws-level “env notes” (`.minds/env*.md`): the workspace’s baseline facts, runtime constraints, and gotchas
  - team memory (`team_memory`)
  - team-shared skills (`.minds/skills/team_shared/...`; the `linkable` pool is a reusable source maintained by team management)
  - Taskdoc: in a healthy workflow, the same Taskdoc is expected to be progressed by multiple Main Dialogs (different Dialog Responders), so treat it as the collective single source of truth

Skills and memory are both long-lived context assets, but they are not the same thing: **memory is the storage layer for facts, indexes, and consensus; skills are the execution-guidance layer for reusable prompt skills and operating procedures**. At startup, the runtime lists summaries of visible skills and the model can call `read_skill` for the body when needed. Upstream metadata such as `allowed-tools` is advisory for migration only; it does not grant Dominds tool permissions. Team collaboration SOPs should usually be skills: they should describe collaboration roles, inputs/outputs, escalation rules, synchronization cadence, and acceptance policy instead of making current-workspace paths part of the body.

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
  - **Org structure (static definitions)**: `persona` / `knowhow` / `pitfalls`
  - **Team governance (shared)**: team memory
  - **Agent-owned**: individual memory
  - **Reusable skill assets**: individual / team-shared skills (prompt guidance), plus MCP resource skills
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

#### 1) `persona` / `knowhow` / `pitfalls`: static role allocation

These docs “pin” an agent into a durable role in the team:

- `persona`: identity + style (voice, working habits, scope boundaries, preference constraints)
- `knowhow`: positive, durable knowledge accumulation (what you’re good at, which methods are proven, your tool/safety stance)
- `pitfalls`: negative lessons and anti-traps (which traps not to repeat, which signals imply risk, which paths are safer)

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

This lets you start work within your scope with “0 ripgrep”. The hard constraint is accuracy: if you change related files or detect staleness/conflicts, immediately `replace_personal_memory` to keep it true.

Tools:

- `add_personal_memory` / `replace_personal_memory` / `drop_personal_memory` / `clear_personal_memory`

Key notes:

- Do not read/write/list `.minds/memory/**` via general file tools (it will be hard-denied). Manage personal memory via the tools above.
- Personal memory is automatically isolated on disk under `.minds/memory/individual/<member-id>/...`, so your `path` must NOT include your member id (do not write `<member-id>/...`).
- If you have zero personal memory entries, just call `add_personal_memory` — the directory will be created automatically.

#### 4) Skills: reusable operating capability (prompt skill assets)

Skills are for **procedural thinking**, **reusable operating paths**, and **trigger/boundary guidance**. A skill answers “when this class of task appears, how should I handle it?”, not “what facts are currently true in this workspace?”.

Common forms:

- Individual skill: `.minds/skills/individual/<member-id>/<skill-id>/`
- Team-shared skill: `.minds/skills/team_shared/<skill-id>/`
- MCP resource skill: a virtual skill exposed by MCP resources

Good skill content:

- portable debugging/review/design/acceptance routines
- team collaboration SOPs, responsibility splits, handoff/escalation/synchronization flows, acceptance and rollback policy
- task-class procedures, checklists, and failure-recovery strategies
- applicability, non-applicability, and required permissions/tools/inputs

Poor skill content:

- current rtws paths, file indexes, architecture facts, or temporary state: use `personal_memory` / `team_memory` / `.minds/env*.md` / Taskdoc instead
- quasi-real-time task state, next steps, or blockers: use Taskdoc `progress`
- content that really needs scripts, privileged tools, MCP, external binaries, or reusable execution capability: elevate it into a Dominds app / toolset / teammate contract instead of leaving it as a Markdown skill

A useful split: **workspace-coupled facts go to memory; workspace-independent operating methods go to skills**. If an experience contains both, split it: put the portable method in a skill, put this repo’s paths, command entrypoints, and local contracts in memory or env notes, and have the skill say to consult those assets first. If an SOP looks path-heavy, first try to abstract it into generic collaboration concepts; keep paths as binding data, not as the SOP body.

### B) Task-term memory: Taskdoc is the single source of truth

Taskdocs are the canonical task contract shared by the team. They answer: what we want, what we must not violate, and where we are.

#### The fixed core (auto-injected)

- `goals`: what must be true when done
- `constraints`: hard rules (safety/style/process/compliance)
- `progress`: distilled progress (key decisions, current status, next steps)

#### Section semantics

- `progress` is the team’s shared milestone bulletin board: key decisions, current status, and next steps. It is not a raw log and not a personal work record.
- `goals` / `constraints` are the more stable task contract: every update must preserve still-valid entries from others instead of turning shared state into personal notes.

#### Practical rules (keep only the essentials)

- Treat `goals / constraints / progress` as a **shared bulletin board**, not a personal scratchpad.
- `progress` is a distilled snapshot; each update should preserve a complete current picture that teammates can scan quickly; high-frequency details belong in reminders (working set).
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
- if they do not materially change your judgment/plan/risk, make no user-visible reply at all (do not send filler like “silently noted” or “received”)
- if they do matter, reflect that only inside the next substantive reply rather than acknowledging them separately
- but don’t treat them as your personal worklog (their lifecycle is typically system-managed)
- in message semantics, these should be treated as **system notices**: they typically appear on the `role=user` side with an explicit notice prefix, so they do not get mistaken for self-authored work notes

#### 3) Curated by the agent: work reminders (working set / worklog)

Reminders are your tiny working set: injected every turn, and preserved across `clear_mind`.

In message semantics, default injected reminder wrappers should still be treated as **runtime system notices**: Dominds' built-in and fallback wrappers belong on the `role=user` side, carry a standard notice marker such as `[System notice]`, and address the LLM in second person (for example, “You set a reminder so the runtime system can remind you: ...”). Ideally they would use `role=environment`, but current LLM APIs generally do not support that role, so Dominds carries default runtime wrappers on `role=user`; custom reminder owners keep responsibility for the role they emit under their own contract. Insert the reminder projection before the real dialog messages and wrap it in a paired header/footer; the footer should say that only the reminder items between that header and footer are system reminders rather than user instructions, so it does not weaken real user instructions in the dialog history.

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
- **Taskdoc `constraints`**: hard rules/safety/compliance/style (must be visible to all Main Dialogs)
- **Team memory `team_memory`**: stable team conventions and invariants (worth reusing)
- **Env notes `.minds/env*.md`**: rtws baseline facts, runtime constraints, gotchas (align humans + all agents to the same environment)
- **Individual memory `personal_memory`**: personal preferences + responsibility-area rtws index (keep accurate)
- **Skills**: reusable operating guidance, checklists, triggers, and boundaries (portable procedure, not a fact warehouse)
- **Reminders**: short-term, high-frequency details (working set / worklog; delete freely)
- **Dialog history / tool output**: disposable by default; only keep distilled excerpts, not raw dumps

### Memory vs skills: selection rules

Ask four questions first:

1. **Is it strongly tied to the current workspace?** Exact paths, symbols, interface facts, repo conventions, and rtws runtime constraints belong in memory/env; cross-workspace methods belong in skills.
2. **Is it a fact or a method?** “File X owns Y” is memory. “When reviewing X-class changes, check A/B/C” is a skill.
3. **Who needs it?** Stable facts everyone must share go to `team_memory`; team collaboration SOPs and team-wide procedures usually go to team-shared skills. A member’s entry map goes to `personal_memory`; that member’s operating preference goes to an individual skill.
4. **Does it need real execution capability?** If it needs scripts, permissions, MCP, external binaries, or a stable UI/API, do not leave it as a skill only. Design an app/toolset/teammate contract and keep the skill as the usage/judgment guidance.

Additional design considerations:

- **Context budget**: memory should be short, exact, and frequently maintained; skills may be longer, but their summaries must help the model decide whether to call `read_skill`.
- **Staleness cost**: facts that change with the repo should not be hidden inside skills, or skills become a stale knowledge source.
- **Auditability**: team-shared skills and team memory are team assets and should be maintained by governance roles; personal assets must still be updated when they go stale.
- **Language and semantics**: when user-facing semantics are involved, follow the project i18n rules; Chinese remains the semantic baseline.

### Caution/critical: stop the bleeding first

When context health enters **caution/critical** (see [context-health.md](./context-health.md)), don’t keep piling on new inputs:

1. stop expanding new branches and new large inputs
2. write back what must be shared (Taskdoc / team memory / env notes)
3. compress what you personally still need into reminders
4. `clear_mind` to start a new course
