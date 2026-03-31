# control Principles and Core Concepts

## Template (Principles)

### Design Goals

- <Goal 1>
- <Goal 2>

### Contract Principles

- <Input/Output contract rules>

### Safety & Boundaries

- <Access constraints / guardrails>

### Failure & Recovery

- <What to do when a call fails>

### Glossary

- <Toolset-specific terms>

## Core Concepts

### 1. Reminder

Reminders are temporary working-set notes with two scopes:

- `dialog`: current-dialog only
- `personal`: visible in all later dialogs you lead

Default to `dialog`. Use `personal` only when you should keep seeing that note in all later dialogs you lead while carrying the same responsibility.

**Characteristics:**

- `dialog` reminders stay in the current dialog only
- `personal` reminders stay visible in all later dialogs you lead
- Can be added, modified, or deleted at any time
- Should stay compact, scannable, and directly actionable by default
- Before `clear_mind`, default to a structured continuation-package reminder; if the current course is already under system remediation, rough multi-reminder carry-over is acceptable

**Difference from memory:**
| Feature | dialog reminder | personal reminder | personal memory |
|---------|-----------------|-------------------|-----------------|
| Persistence | Current dialog only | Across all later dialogs you lead | Long-term / file-backed |
| Visibility | Current dialog | Current responder agent | Current agent |
| Best for | Current next step, blocker, volatile clue | Responsibility-linked operating cue | Stable facts / reusable knowledge |

### 1.1 Scope Choice Rule

- Use `personal` for responsibility-related reminders:
  - a preferred smoke-check command this agent should keep using in similar dialogs
  - a recurring safety check this agent should keep applying
  - an operating watchpoint that should survive dialog boundaries for you
- Use `dialog` for everything else:
  - current blockers
  - temporary paths, ids, commands, sample inputs
  - bridge notes that matter only for this dialog / current course
- If the content is a durable fact or knowledge asset rather than an active working-set cue, it likely belongs in `personal_memory`, not in either reminder scope.

### 2. Taskdoc

Taskdoc is a **task contract** defining goals, constraints, and progress.

**Structure:**

- **goals.md**: Task objectives
- **constraints.md**: Constraints
- **progress.md**: Progress status

**Update Rules:**

- Each `change_mind` call replaces entire chapter
- Does not reset dialog rounds
- Changes visible to all teammates

## Tool Overview

| Tool            | Function                                    |
| --------------- | ------------------------------------------- |
| add_reminder    | Add reminder                                |
| delete_reminder | Delete reminder                             |
| update_reminder | Update reminder content                     |
| change_mind     | Update taskdoc (goals/constraints/progress) |
| recall_taskdoc  | Read taskdoc chapter                        |

## Inter-dialog Reply Routing

### Decision Rules

- If the current sideline is unfinished, blocked, uncertain, or needs an upstream clarification: call `tellaskBack({ tellaskContent })`
- If the current sideline is complete and the assignment header says `replyTellask`: call `replyTellask({ replyContent })`
- If the current sideline is complete and the assignment header says `replyTellaskSessionless`: call `replyTellaskSessionless({ replyContent })`
- If you are answering an upstream `tellaskBack` follow-up and runtime exposes `replyTellaskBack`: call `replyTellaskBack({ replyContent })`
- Plain text is not the normal completion channel for inter-dialog delivery; if you emit plain text instead of the reply tool, runtime may temporarily inject a `role=user` reminder telling you to use the correct reply function

### Low-Burden Rule

- Focus on doing the current task correctly first; use `reply*` only when final upstream delivery is actually ready
- Do not memorize reply variants by yourself; follow the current assignment header and the function currently exposed by runtime
- `reply*` tool descriptions are intentionally minimal and spec-like; use this manual's principles / scenarios for situational guidance
- If runtime exposes only one `reply*`, that is the only correct completion path for the current state
- `tellaskBack` is for ask-back only, not final delivery

## Best Practices

### 1. Reminder Usage Scenarios

- **Current working set**: next step, blockers, key pointers
- **Easy-to-lose details**: temporary paths, ids, commands, sample inputs
- **Course transition**: continuation-package notes before `clear_mind`, including rough multi-reminder carry-over when already degraded
- **Responsibility-linked carry-over**: if you should keep seeing the note in all later dialogs you lead, use `personal`

### 2. Taskdoc Update Timing

- **Goal changes**: When task objectives change
- **Constraint adjustments**: When constraints need adjustment
- **Progress updates**: When task status has significant progress

### 3. Update Strategy

- Keep concise: reminders are often 1-3 items; prefer `update_reminder` to compress/merge
- Separate carriers: shared decisions/status belong in Taskdoc; reminders keep local resume details
- Collapse before clearing: default to a structured continuation-package reminder; if the current course is already under system remediation, rough multi-reminder carry-over is acceptable but must be reconciled first in the new course
- Avoid raw-material dumps: do not paste long logs or large tool outputs into reminders

## Limitations and Notes

1. `dialog` reminders end with the dialog; `personal` reminders stay visible in all later dialogs you lead
2. Taskdoc updates use full section replacement, ensure to merge existing content
3. `change_mind` does not reset dialog rounds
4. A continuation-package reminder should keep only details not already covered by Taskdoc but easy to lose during resume
5. Do not turn `personal` reminders into a long-term fact dump; move durable knowledge into `personal_memory`
