# ws_mod Text Editing Tools Manual

## Overview

ws_mod is Dominds' text editing toolset, using **prepare-first + single apply** architecture:

- **prepare-first**: All incremental edits are planned first (output reviewable diff + evidence + hunk_id)
- **single apply**: All planned edits are persisted only through `apply_file_modification`
- **Legacy tools removed**: `append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace` are completely removed

## Quick Navigation

| Topic                         | Description                                                      |
| ----------------------------- | ---------------------------------------------------------------- |
| [principles](./principles.md) | Core concepts, workflow, concurrency constraints, hunk lifecycle |
| [tools](./tools.md)           | Complete tool list and interface contracts                       |
| [scenarios](./scenarios.md)   | Common usage scenarios (copy-paste ready)                        |
| [errors](./errors.md)         | Error codes and solutions                                        |

## Status

- Status: Implemented (breaking change: no legacy tool compat layer)
- Main implementation files:
  - Tool implementation: `dominds/main/tools/txt.ts`
  - Toolset metadata: `dominds/main/tools/builtins.ts`, `dominds/main/tools/registry.ts`
