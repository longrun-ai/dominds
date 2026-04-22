# control Dialog Control Tools Manual

## Template (Index)

### One-line Positioning

- <What this toolset is for, in one sentence>

### Tool List

- <Enumerate core tools or point to Tools/Schema section>

### 30-Second Quickstart

1. <call ...>
2. <observe ...>
3. <next step ...>

### Navigation

- principles / tools / scenarios / errors

### Boundaries vs Other Toolsets

- <When to use this vs a sibling toolset>

control is Dominds' **dialog control toolset** for managing dialog state, reminders, taskdocs, and inter-dialog reply closure semantics:

- **Reminder management**: Two reminder scopes. Default to dialog-local working set; use `personal` only for responsibility-linked notes that you should keep seeing in all later dialogs you lead
- **Taskdoc operations**: Update task contracts (goals/constraints/progress); within Taskdoc, `progress` is the team-shared, quasi-real-time, scannable task bulletin board
- **Context maintenance**: Reduce cognitive load without losing key resume state
- **Reply routing**: Separate `tellaskBack`, `replyTellask*`, and plain text by responsibility in Side Dialog / ask-back flows

## Quick Navigation

| Topic                         | Description                                                               |
| ----------------------------- | ------------------------------------------------------------------------- |
| [principles](./principles.md) | Core concepts, reminder lifecycle, taskdoc structure, reply-routing model |
| [tools](./tools.md)           | Complete tool list, minimal interface contracts, reply quick reference    |
| [scenarios](./scenarios.md)   | Common usage scenarios (copy-paste ready)                                 |
| [errors](./errors.md)         | Error codes and solutions                                                 |

## Status

- Status: Implemented
- Main implementation files:
  - Tool implementation: `dominds/main/tools/ctrl.ts`
  - Toolset metadata: `dominds/main/tools/builtins.ts`, `dominds/main/tools/registry.ts`

## Core Concepts

### Reminder

Reminders are temporary working-set information for:

- Marking pending tasks
- Tracking current next steps / blockers
- Recording blocking issues
- Holding continuation-package bridge notes before `clear_mind`

Scope rule:

- `dialog`: current-dialog working set
- `personal`: responsibility-related reminders that you should keep seeing in all later dialogs you lead

### Taskdoc

Taskdoc is a **task contract** containing:

- **goals**: Task objectives
- **constraints**: Constraints
- **progress**: A quasi-real-time team task bulletin board / current effective-state snapshot for team-wide sync
