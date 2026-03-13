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

Reminders are **session-level** temporary working-set information for tracking pending items and resume clues in the current dialog.

**Characteristics:**

- Valid only in current dialog
- Automatically cleared after dialog ends
- Can be added, modified, or deleted at any time
- Should stay compact, scannable, and directly actionable by default
- Before `clear_mind`, default to a structured continuation-package reminder; if the current course is already under system remediation, rough multi-reminder carry-over is acceptable

**Difference from memory:**
| Feature | reminder | memory |
|---------|----------|--------|
| Persistence | Session-level | Permanent |
| Visibility | Current dialog | Current agent |
| Capacity | No strict limit | No strict limit |

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

## Best Practices

### 1. Reminder Usage Scenarios

- **Current working set**: next step, blockers, key pointers
- **Easy-to-lose details**: temporary paths, ids, commands, sample inputs
- **Course transition**: continuation-package notes before `clear_mind`, including rough multi-reminder carry-over when already degraded

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

1. Reminders are not persisted after dialog ends
2. Taskdoc updates use full section replacement, ensure to merge existing content
3. `change_mind` does not reset dialog rounds
4. A continuation-package reminder should keep only details not already covered by Taskdoc but easy to lose during resume
