# team_memory Principles and Core Concepts

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

The team_memory toolset uses a **path key-value storage** model, similar to personal_memory but with shared properties:

- **Path**: Unique identifier for the memory, similar to a file system path
- **Content**: Actual content of the memory, can be arbitrary text
- **Visibility**: Content is shared with the team; whether it is writable depends on whether the current agent has team_memory write authority

**Three-way boundary split:**

- `team_memory`: team-shared long-lived conventions / invariants / consensus rules
- `personal_memory`: one member’s own reusable long-lived experience and working index
- `persona / knowhow / pitfalls`: team-defined role-level long-lived prompt assets

## Tool Overview

| Tool                | Function                                            |
| ------------------- | --------------------------------------------------- |
| add_team_memory     | Create new shared memory (when path does not exist) |
| replace_team_memory | Update existing shared memory (when path exists)    |
| drop_team_memory    | Delete shared memory                                |
| clear_team_memory   | Clear all shared memory (irrecoverable)             |

## Memory Lifecycle

1. **Create (add)**: Use `add_team_memory` to create new shared memory
2. **Read**: All team members can read shared memory
3. **Update (replace)**: Use `replace_team_memory` to update memory content
4. **Delete (drop)**: Use `drop_team_memory` to delete specific memory

## Best Practices

### 1. Path Naming Conventions

- Use descriptive paths: `team/project-goals`, `team/conventions/coding-style`
- Avoid personal identifiers: `team/todo` instead of `team/todo-alice`
- Use hierarchical structure: Organize memory by topic

### 2. Content Format

- Keep content concise: Each memory should cover only one topic
- Use structured format: Can use Markdown format to organize content
- Include update time: Record last update time for tracking
- Store only stable team-level knowledge: shared conventions, architectural invariants, long-lived maintenance indexes, or judgment rules that multiple members should reuse
- Do not turn `team_memory` into one member’s personal experience warehouse; that belongs in `personal_memory`
- Do not put execution-time information here when the team needs it synchronized quasi-real-time, such as current effective state, key decisions, next steps, or still-active blockers; that belongs in Taskdoc `progress`, the quasi-real-time task bulletin board

### 3. Usage Scenarios

- **Team conventions**: Coding standards, commit message format, review process
- **Project knowledge**: Architecture decisions, technology choices, long-lived API or entry-point indexes
- **Shared invariants**: Terminology, collaboration rules, and boundary conditions every member should follow

## Relationship with Other Tools

- **personal_memory**: Personal memory, only current agent visible
- **reminder**: Temporary reminder, session-level
- **do_mind / mind_more / change_mind / never_mind**: Create, append to, replace, or delete Taskdoc sections

> Note: `team_memory` carries long-lived team consensus; Taskdoc `progress` carries quasi-real-time team-wide task announcements during execution. Do not mix them.

## Limitations and Notes

1. Path guardrails: absolute paths are forbidden; `..` is forbidden.
2. Content guardrail: `content` must be a non-empty string.
3. `clear_team_memory` will delete all shared memory, **irrecoverable**.
4. Shared memory should be maintained by governance roles; keep it small and stable.
