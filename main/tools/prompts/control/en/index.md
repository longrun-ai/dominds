# control Dialog Control Tools Manual

## Template (Index)

### One-line Positioning

- <What this toolset is for, in one sentence>

### Tool List

- <Enumerate core tools or point to the Tools section>

### 30-Second Quickstart

1. <call ...>
2. <observe ...>
3. <next step ...>

### Navigation

- principles / tools / scenarios / errors

### Boundaries vs Other Toolsets

- <When to use this vs a sibling toolset>

control is Dominds' **dialog control toolset** for managing dialog state, reminders, taskdocs, and inter-dialog reply closure semantics:

- **Reminder management**: Three reminder scopes: `dialog` / `task` / `agent`. Default to `task` for current work under the same Taskdoc; use `dialog` only for truly dialog-local notes; use `agent` only for urgent, short-lived, globally visible cues
- **Taskdoc operations**: Append to, replace, or delete task contract sections (goals/constraints/progress); within Taskdoc, `progress` is the team-shared, quasi-real-time, scannable task bulletin board
- **Context maintenance**: Reduce cognitive load without losing key resume state
- **Reply routing**: Separate `tellaskBack`, `replyTellask*`, and plain text by responsibility in Side Dialog / ask-back flows

## Quick Navigation

| Topic                         | Description                                                               |
| ----------------------------- | ------------------------------------------------------------------------- |
| [principles](./principles.md) | Core concepts, reminder lifecycle, taskdoc structure, reply-routing model |
| [tools](./tools.md)           | Usage guidance, boundaries, and reply quick reference                     |
| [scenarios](./scenarios.md)   | Common usage scenarios (copy-paste ready)                                 |
| [errors](./errors.md)         | Error codes and solutions                                                 |

## Status

- Status: Implemented
- Main implementation files:
  - Tool implementation: `dominds/main/tools/ctrl.ts`
  - Toolset metadata: `dominds/main/tools/builtins.ts`, `dominds/main/tools/registry.ts`

## Core Concepts

### Reminder

Reminders are temporary current-work information for:

- Marking pending tasks
- Tracking current next steps / blockers
- Recording blocking issues
- Holding continuation-package bridge notes before `clear_mind`

Reminders are not for manually copying Dominds runtime-maintained environment state, such as background process status, in-flight background asks/collaboration, or browser/session attachment state. Runtime-managed reminders, panels, and tool outputs are the single source of truth; manual notes go stale easily and create cognitive noise.

Scope rule:

- `dialog`: current-dialog current work
- `task`: current work under the current Taskdoc, and the default scope
- `agent`: urgent, short-lived, globally visible cues you should keep seeing in all later dialogs you lead

### Taskdoc

Taskdoc is a **task contract** containing:

- **goals**: Task objectives
- **constraints**: Constraints
- **progress**: A quasi-real-time team task bulletin board / current effective-state snapshot for team-wide sync
