# memory Personal Memory Tools Manual

## Overview

memory is Dominds' **personal memory toolset** for managing an agent's private memory:

- **Privacy**: Memory is only visible to the current agent, not shared with other members
- **Persistence**: Memory is persisted to disk and retained after conversation restarts
- **Structured**: Supports organizing memory by path for easy categorization and retrieval

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
