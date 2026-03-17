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
- **Shell guardrail**: toolset `os` includes `shell_cmd` / `stop_daemon` / `get_daemon_output`; any member with these shell tools must be listed in top-level `shell_specialists`
- **Member assets recommended**: strongly recommend `persona/knowledge/lessons` files for every `members.<id>` to define ownership, boundaries, and reusable lessons
- **Default responder recommendation**: `default_responder` is not technically required, but should be set explicitly to avoid implicit fallback drift

## Quick Navigation

| Topic                         | Description                                                    |
| ----------------------------- | -------------------------------------------------------------- |
| [principles](./principles.md) | Core principles, path rules, read_file output, apply semantics |
| [tools](./tools.md)           | Complete tool list and interface contracts                     |
| [scenarios](./scenarios.md)   | Common usage scenarios and templates (copy-paste ready)        |
| [errors](./errors.md)         | Error handling guide                                           |

## Relationship with ws_mod

## MCP Toolset Manual i18n Mechanism

Dominds supports mounting toolset manuals via the `manual.contentFile` field in MCP server configuration, with multi-language support (zh/en).

### Path Convention

| Language               | File Path                                   |
| ---------------------- | ------------------------------------------- |
| zh (semantic baseline) | `.minds/mcp/manuals/<serverId>/index.md`    |
| en                     | `.minds/mcp/manuals/<serverId>/index.en.md` |

### mcp.yaml Configuration Example

```yaml
servers:
  my-server:
    transport: stdio
    command: ...
    manual:
      contentFile: .minds/mcp/manuals/my-server
```

- `manual.contentFile` is mutually exclusive with `manual.content` / `manual.sections`; `contentFile` takes priority
- Path is rtws-relative (starts with `.` → resolved relative to runtime workspace root)
- Early-fail validation on load: if the path is invalid or not found, the server config is marked as invalid

### Rendering Behavior

- `render.ts` `loadTopicDoc()` determines resolution strategy by path prefix:
  - **rtws-relative path** (starts with `.`): resolved relative to `process.cwd()`
  - **Package-internal path** (other): resolved relative to `__dirname`
- Runtime language is determined by the dialog's `getLastUserLanguageCode()`; zh is the semantic baseline

### auto-draft Behavior

- auto-draft is unaffected by `contentFile`; tool names in tool calling output follow actual runtime registration

This toolset has the same mental model as `ws_mod` (text editing tools), but:

- Path resolves under `.minds/` (e.g., `team.yaml` → `.minds/team.yaml`)
- Tool names have `team_mgmt_` prefix
- Permission semantics are determined by the team_mgmt wrapper layer
