# personal_memory Principles and Core Concepts

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

The `personal_memory` toolset uses a **path key-value storage** model:

- **Path**: Unique identifier for the memory, similar to a file system path, e.g., `project/todo` or `user/preferences/theme`
- **Content**: Actual content of the memory, can be arbitrary text

**Isolation & first-time setup:**

- Personal memory is private to the current agent.
- On disk, it is automatically isolated under `.minds/memory/individual/<member-id>/...`.
- Your `path` must NOT include your member id (do not write `<member-id>/...`).
- If you have zero memory files yet, just call `add_personal_memory` — the directory will be created automatically.

## Tool Overview

| Tool                    | Function                                              |
| ----------------------- | ----------------------------------------------------- |
| add_personal_memory     | Create new personal memory (when path does not exist) |
| replace_personal_memory | Update existing personal memory (when path exists)    |
| drop_personal_memory    | Delete personal memory                                |
| clear_personal_memory   | Clear all personal memory (irrecoverable)             |

## Memory Lifecycle

1. **Create (add)**: Use `add_personal_memory` to create new memory
2. **Read**: Agent can read existing memory during response generation
3. **Update (replace)**: Use `replace_personal_memory` to update memory content
4. **Delete (drop)**: Use `drop_personal_memory` to delete specific memory

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
- `personal_memory` should primarily hold knowledge that has **not** been promoted to team-defined role assets yet, but is still worth carrying forward for your own future work: your entry maps, search keywords, debugging methods, and long-lived working preferences.
- Do not store task progress or daily state here:
  - Team-visible progress belongs in Taskdoc `progress`
  - Short-term working set belongs in reminders

### 3. Recommended Boundaries

- **Role-level long-lived definition assets**: `persona / knowhow / pitfalls`
- **A member’s own reusable long-lived experience and working index**: `personal_memory`
- **Current task progress, temporary bridge notes, short-term TODOs**: Taskdoc `progress` / reminders
- **Team-shared long-lived conventions / invariants / consensus rules**: `team_memory`

> Note: If you find yourself using personal memory to store “current progress of this run”, it likely belongs in Taskdoc `progress` or reminders instead.
>
> Likewise, if what you want to write is a role’s long-lived responsibility boundary, working method, or durable positive/negative example, it should usually live in that role’s `persona / knowhow / pitfalls`, not in `personal_memory`.

## Relationship with Other Tools

- **team_memory**: Team shared memory, visible to all members
- **reminder**: Temporary reminder, session-level
- **change_mind**: Update taskdoc (goals/constraints/progress)

## Limitations and Notes

1. Memory content has size limit (max 1MB per memory)
2. Memory path cannot exceed 255 characters
3. `clear_personal_memory` will delete all memory, **irrecoverable**
