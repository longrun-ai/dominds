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

control is Dominds' **dialog control toolset** for managing dialog state, reminders, taskdocs, and Tellask reply closure semantics:

- **Reminder management**: Main Dialogs always show a fixed "Goal for this Main Dialog" reminder. If it says to ask the human first, ask immediately and record the answer with `set_dialog_goal`. Ordinary reminders have three scopes: `dialog` / `task` / `agent`. Default to `task` for ordinary current work under the same Taskdoc; use `dialog` for truly dialog-local continuation details; use `agent` only for urgent, short-lived, globally visible cues
- **Taskdoc operations**: Append to, replace, or delete task contract sections (goals/constraints/progress); within Taskdoc, `progress` is the team-shared, quasi-real-time, scannable task bulletin board
- **Context maintenance**: Reduce cognitive load without losing key resume state
- **Tellask reply routing**: Separate asking the tellasker back, sending the final Tellask reply, and ordinary plain text in Side Dialog / ask-back flows

## Quick Navigation

| Topic                         | Description                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------- |
| [principles](./principles.md) | Core concepts, reminder lifecycle, taskdoc structure, Tellask reply-routing model |
| [tools](./tools.md)           | Usage guidance, boundaries, and Tellask reply quick reference                     |
| [scenarios](./scenarios.md)   | Common usage scenarios (copy-paste ready)                                         |
| [errors](./errors.md)         | Error codes and solutions                                                         |

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
- Holding current-dialog scoped continuation-package bridge notes before `clear_mind`

Main Dialogs always carry a Dominds-managed "Goal for this Main Dialog" reminder. Read the whole reminder. If it says to ask the human first, ask what this Main Dialog should work on next, then record the answer with `set_dialog_goal`. If it says "proceed from the Taskdoc" and has no parallel-dialog note, continue from the Taskdoc; if the same reminder says Dominds has confirmed a parallel dialog, ask the human first.

Reminders are not for manually copying environment state automatically maintained by Dominds, such as background process status, in-flight background asks/collaboration, or browser/session attachment state. Dominds-managed reminders, panels, and tool outputs are the authoritative place for that state; manual notes go stale easily and create cognitive noise.

Scope rule:

- `dialog`: current-dialog current work and continuation details. Main Dialog goals come from the fixed goal reminder; Side Dialog continuation packages must state this Side Dialog's task goal
- `task`: current work under the current Taskdoc, and the default scope
- `agent`: urgent, short-lived, globally visible cues you should keep seeing across later dialogs you lead

### Taskdoc

Taskdoc is a **task contract** containing:

- **goals**: Task objectives
- **constraints**: Constraints
- **progress**: A quasi-real-time team task bulletin board / current effective-state snapshot for team-wide sync
