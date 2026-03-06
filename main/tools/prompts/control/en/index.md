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

control is Dominds' **dialog control toolset** for managing dialog state, reminders, and taskdocs:

- **Reminder management**: Dialog-local working set; usually keep it small, prefer continuation-package cleanup before `clear_mind`, but rough multi-reminder carry-over is allowed when context is already degraded
- **Taskdoc operations**: Update task contracts (goals/constraints/progress)
- **Context maintenance**: Reduce cognitive load without losing key resume state

## Quick Navigation

| Topic                         | Description                                          |
| ----------------------------- | ---------------------------------------------------- |
| [principles](./principles.md) | Core concepts, reminder lifecycle, taskdoc structure |
| [tools](./tools.md)           | Complete tool list and interface contracts           |
| [scenarios](./scenarios.md)   | Common usage scenarios (copy-paste ready)            |
| [errors](./errors.md)         | Error codes and solutions                            |

## Status

- Status: Implemented
- Main implementation files:
  - Tool implementation: `dominds/main/tools/ctrl.ts`
  - Toolset metadata: `dominds/main/tools/builtins.ts`, `dominds/main/tools/registry.ts`

## Core Concepts

### Reminder

Reminders are **session-level** temporary working-set information for:

- Marking pending tasks
- Tracking current next steps / blockers
- Recording blocking issues
- Holding continuation-package bridge notes before `clear_mind`

### Taskdoc

Taskdoc is a **task contract** containing:

- **goals**: Task objectives
- **constraints**: Constraints
- **progress**: Progress status
