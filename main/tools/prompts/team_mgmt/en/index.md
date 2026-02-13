# team_mgmt Tools Manual

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

team_mgmt is Dominds' toolset for managing `.minds/` (team configuration and rtws memory), using **prepare-first + single apply** architecture:

- **Incremental edits (preferred)**: Use `team_mgmt_prepare_*` to generate reviewable YAML + diff + `hunk_id`, then write via `team_mgmt_apply_file_modification`
- **Only operates in `.minds/`**: This toolset only operates within the `.minds/` subtree and should not touch other rtws files

## Quick Navigation

| Topic                         | Description                                                    |
| ----------------------------- | -------------------------------------------------------------- |
| [principles](./principles.md) | Core principles, path rules, read_file output, apply semantics |
| [tools](./tools.md)           | Complete tool list and interface contracts                     |
| [scenarios](./scenarios.md)   | Common usage scenarios and templates (copy-paste ready)        |
| [errors](./errors.md)         | Error handling guide                                           |

## Relationship with ws_mod

This toolset has the same mental model as `ws_mod` (text editing tools), but:

- Path resolves under `.minds/` (e.g., `team.yaml` → `.minds/team.yaml`)
- Tool names have `team_mgmt_` prefix
- Permission semantics are determined by the team_mgmt wrapper layer
