# memory Principles and Core Concepts

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
- Avoid special characters: Do not include `/`, `\`, `*`, etc. in paths
- Use hierarchical structure: Organize memory by topic, e.g., `project/todo`, `project/done`

### 2. Content Format

- Keep content concise: Each memory should cover only one topic
- Use structured format: Can use Markdown format to organize content
- Regular cleanup: Periodically check and delete outdated memories

### 3. Usage Scenarios

- **Task persistence**: Save long-term task progress
- **Context memory**: Save important information from conversation context
- **Preference settings**: Save user preferences and configuration information

## Relationship with Other Tools

- **team_memory**: Team shared memory, visible to all members
- **reminder**: Temporary reminder, session-level
- **change_mind**: Update taskdoc (goals/constraints/progress)

## Limitations and Notes

1. Memory content has size limit (max 1MB per memory)
2. Memory path cannot exceed 255 characters
3. `clear_memory` will delete all memory, **irrecoverable**
