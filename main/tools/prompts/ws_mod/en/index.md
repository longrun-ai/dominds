# ws_mod Text Editing Tools Manual

## Template (Index)

### One-line Positioning

- <What this toolset is for, in one sentence>

### Tool List

- <Enumerate core tools or point to the Tools section>

### 30-Second Quickstart

1. <call ...>
2. <observe ...>
3. <next step ...>

### Navigation

- principles / tools / scenarios / errors

### Boundaries vs Other Toolsets

- <When to use this vs a sibling toolset>

ws_mod is Dominds' text editing toolset, using **direct range edit + prepare/apply** architecture:

- **direct range edit**: precise line ranges should use one-step `file_range_edit`
- **prepare/apply**: anchor-based, multi-occurrence, ambiguous, or preview-first edits use `prepare_*`, then persist through `apply_file_modification`
- **Hard ordering rule for the LLM**: Before apply, a prepared hunk exists only in memory; re-reading still returns the old file content. If you want further edits based on that prepared result, apply the current hunk first, then prepare again
- **Legacy tools removed**: `append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace` are completely removed

## Quick Navigation

| Topic                         | Description                                                      |
| ----------------------------- | ---------------------------------------------------------------- |
| [principles](./principles.md) | Core concepts, workflow, concurrency constraints, hunk lifecycle |
| [tools](./tools.md)           | Usage guidance, editing boundaries, and workflow notes           |
| [scenarios](./scenarios.md)   | Common usage scenarios (copy-paste ready)                        |
| [errors](./errors.md)         | Error codes and solutions                                        |

## Status

- Status: Implemented (breaking change: no legacy tool compat layer)
- Main implementation files:
  - Tool implementation: `dominds/main/tools/txt.ts`
  - Toolset metadata: `dominds/main/tools/builtins.ts`, `dominds/main/tools/registry.ts`
