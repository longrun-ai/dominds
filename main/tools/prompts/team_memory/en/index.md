# team_memory Team Shared Memory Tools Manual

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

team_memory is Dominds' **team shared memory toolset** for managing memories shared among team members:

- **Sharing**: Memory is visible to all team members
- **Persistence**: Memory is persisted to disk and retained after conversation restarts
- **Collaboration**: Supports information sharing among team members

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

## Difference from memory

| Feature    | memory                           | team_memory                         |
| ---------- | -------------------------------- | ----------------------------------- |
| Visibility | Current agent only               | All team members                    |
| Use Cases  | Personal preferences, temp notes | Team conventions, knowledge sharing |
