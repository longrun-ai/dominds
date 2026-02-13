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

Reminders are **session-level** temporary information for tracking pending items in the current dialog.

**Characteristics:**

- Valid only in current dialog
- Automatically cleared after dialog ends
- Can be added, modified, or deleted at any time

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

- **Task marking**: Mark currently processing tasks
- **Blocking records**: Record encountered blocking issues
- **Todo list**: Track pending items

### 2. Taskdoc Update Timing

- **Goal changes**: When task objectives change
- **Constraint adjustments**: When constraints need adjustment
- **Progress updates**: When task status has significant progress

### 3. Update Strategy

- Keep concise: Only modify necessary content each update
- Use clear markers: Use clear format to mark completed/in-progress/pending
- Sync state: Ensure goals, constraints, and progress remain consistent

## Limitations and Notes

1. Reminders are not persisted after dialog ends
2. Taskdoc updates use full section replacement, ensure to merge existing content
3. `change_mind` does not reset dialog rounds
