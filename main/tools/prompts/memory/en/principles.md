# memory Principles and Core Concepts

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

## Memory Model

The memory toolset uses a **path key-value storage** model:

- **Path**: Unique identifier for the memory, similar to a file system path, e.g., `project/todo` or `user/preferences/theme`
- **Content**: Actual content of the memory, can be arbitrary text

## Tool Overview

| Tool           | Function                                     |
| -------------- | -------------------------------------------- |
| add_memory     | Create new memory (when path does not exist) |
| replace_memory | Update existing memory (when path exists)    |
| drop_memory    | Delete memory                                |
| clear_memory   | Clear all personal memory (irrecoverable)    |

## Memory Lifecycle

1. **Create (add)**: Use `add_memory` to create new memory
2. **Read**: Agent can read existing memory during response generation
3. **Update (replace)**: Use `replace_memory` to update memory content
4. **Delete (drop)**: Use `drop_memory` to delete specific memory

## Best Practices

### 1. Path Naming Conventions

- Use descriptive paths: `project/architecture`, `user/preferences/language`
- Use `/` to organize hierarchy (this is the recommended usage), with guardrails:
  - Absolute paths are forbidden (must not start with `/`)
  - Path traversal is forbidden (`..` is not allowed)
  - Avoid `\\` (cross-platform readability; prefer `/`)
- Keep paths _flat_: prefer a small number of topic files rather than a deep directory tree.

### 2. Content Format

- Treat personal memory as a **carry-along stable-facts memo**: enable **0 ripgrep** startup within your scope.
- Store stable facts only: **anchor points (file/symbol) + 1-line meaning + key contracts/priorities (≤3)**.
- Fewer memory files is better: group facts that will be updated together into one file; avoid adding extra “directory-of-directory” layers.
- Do not store task progress or daily state here:
  - Team-visible progress belongs in Taskdoc `progress`
  - Short-term working set belongs in reminders

### 3. Usage Scenarios

- **Task persistence**: Save long-term task progress
- **Context memory**: Save important information from conversation context
- **Preference settings**: Save user preferences and configuration information

> Note: If you find yourself using personal memory to store “current progress of this run”, it likely belongs in Taskdoc `progress` or reminders instead.

## Relationship with Other Tools

- **team_memory**: Team shared memory, visible to all members
- **reminder**: Temporary reminder, session-level
- **change_mind**: Update taskdoc (goals/constraints/progress)

## Limitations and Notes

1. Memory content has size limit (max 1MB per memory)
2. Memory path cannot exceed 255 characters
3. `clear_memory` will delete all memory, **irrecoverable**
