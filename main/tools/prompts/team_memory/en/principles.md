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

The team_memory toolset uses a **path key-value storage** model, similar to memory but with shared properties:

- **Path**: Unique identifier for the memory, similar to a file system path
- **Content**: Actual content of the memory, can be arbitrary text
- **Visibility**: All team members can read and modify

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

### 3. Usage Scenarios

- **Team conventions**: Coding standards, commit message format, review process
- **Project knowledge**: Architecture decisions, technology choices, API documentation
- **Shared context**: Current task status, blocking issues, dependencies

## Relationship with Other Tools

- **memory**: Personal memory, only current agent visible
- **reminder**: Temporary reminder, session-level
- **change_mind**: Update taskdoc (goals/constraints/progress)

## Limitations and Notes

1. Path guardrails: absolute paths are forbidden; `..` is forbidden.
2. Content guardrail: `content` must be a non-empty string.
3. `clear_team_memory` will delete all shared memory, **irrecoverable**.
4. Shared memory should be maintained by governance roles; keep it small and stable.
