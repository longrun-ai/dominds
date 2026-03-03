# personal_memory Personal Memory Tools Manual

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

personal_memory is Dominds' **personal memory toolset** for managing an agent's private memory:

- **Privacy**: Memory is only visible to the current agent, not shared with other members
- **Persistence**: Memory is persisted to disk and retained after conversation restarts
- **Structured**: Supports organizing memory by path for easy categorization and retrieval

Key notes:

- Personal memory is automatically isolated on disk under `.minds/memory/individual/<member-id>/...`.
- Your `path` must NOT include your member id (do not write `<member-id>/...`).
- If you have zero memory files yet, just call `add_personal_memory` — the directory will be created automatically.

Tool list:

- `add_personal_memory` / `replace_personal_memory` / `drop_personal_memory` / `clear_personal_memory`

## Quick Navigation

| Topic                         | Description                                     |
| ----------------------------- | ----------------------------------------------- |
| [principles](./principles.md) | Core concepts, memory lifecycle, best practices |
| [tools](./tools.md)           | Complete tool list and interface contracts      |
| [scenarios](./scenarios.md)   | Common usage scenarios (copy-paste ready)       |
| [errors](./errors.md)         | Error codes and solutions                       |

## Status

- Status: Implemented
- Main implementation files:
  - Tool implementation: `dominds/main/tools/mem.ts`
  - Toolset metadata: `dominds/main/tools/builtins.ts`, `dominds/main/tools/registry.ts`
