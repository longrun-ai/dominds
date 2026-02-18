# team_mgmt Tool Reference

## Template (Tools)

### How to Read

- The schema-generated "Tool Contract (Schema)" section is canonical for parameters/returns.

### Per-Tool Fields (order)

1. Purpose
2. Call Signature
3. Parameters (refer to schema)
4. Preconditions
5. Success Signal
6. Failure/Errors
7. Copy-Ready Example
8. Common Misuse

## Read/Locate Tools

- `team_mgmt_read_file`: Read file content from `.minds/`, with YAML header (includes total_lines/size_bytes)
- `team_mgmt_list_dir`: List directory contents under `.minds/`
- `team_mgmt_list_providers`: List built-in/rtws providers, env-var readiness, and model overview (wildcard filters supported)
- `team_mgmt_list_models`: List models by provider/model wildcard; can include `model_param_options`
- `team_mgmt_ripgrep_files`: Search file paths under `.minds/`
- `team_mgmt_ripgrep_snippets`: Search snippets under `.minds/` (with context)
- `team_mgmt_ripgrep_count`: Count matches under `.minds/`
- `team_mgmt_ripgrep_fixed`: Fixed-string search under `.minds/`

## Create Tool

- `team_mgmt_create_new_file`: Create a new file (empty content allowed), no prepare/apply
  - Refuses if file already exists (`FILE_EXISTS`)
  - Auto-creates parent directories if needed

## Incremental Edit Tools

### 1. prepare phase

- `team_mgmt_prepare_file_range_edit`: Preview replace/delete/append by line range
- `team_mgmt_prepare_file_append`: Preview append to EOF (optional `create=true|false`)
- `team_mgmt_prepare_file_insert_after`: Preview insertion by anchor (after)
- `team_mgmt_prepare_file_insert_before`: Preview insertion by anchor (before)
- `team_mgmt_prepare_file_block_replace`: Preview block replacement by start/end anchors
  - Supports: `include_anchors`, `require_unique`, `strict`, `occurrence`

### 2. apply phase

- `team_mgmt_apply_file_modification`: The sole apply entry, uses `hunk_id` to apply changes

## Full File Overwrite Tool

- `team_mgmt_overwrite_entire_file`: Overwrite entire file directly (no prepare/apply)
  - Requires `known_old_total_lines` and `known_old_total_bytes`
  - Suggest getting these values via `team_mgmt_read_file` first

## Validation Tool

- `team_mgmt_validate_team_cfg({})`: Validate `.minds/team.yaml` configuration
  - Must run after modifying `team.yaml`
  - Clear all team.yaml errors in Problems panel before proceeding
  - Also reads declarations from `.minds/mcp.yaml` for toolset binding checks; even when MCP toolsets are not loaded in the current scene (e.g. read-mind flows), it still detects unknown/invalid MCP serverId references in `members.<id>.toolsets`
- `team_mgmt_validate_mcp_cfg({})`: Validate `.minds/mcp.yaml` and MCP-related problems
  - Must run after modifying `mcp.yaml`
  - Clear all MCP-related errors in Problems panel before proceeding

## Tool Selection Guide

| Operation                | Recommended Tool                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Read file                | `team_mgmt_read_file`                                                              |
| List providers           | `team_mgmt_list_providers`                                                         |
| List models              | `team_mgmt_list_models`                                                            |
| Search content           | `team_mgmt_ripgrep_snippets`                                                       |
| Create new file          | `team_mgmt_create_new_file`                                                        |
| Small edits (line range) | `team_mgmt_prepare_file_range_edit` → `team_mgmt_apply_file_modification`          |
| Append to end            | `team_mgmt_prepare_file_append` → `team_mgmt_apply_file_modification`              |
| Anchor insertion         | `team_mgmt_prepare_file_insert_after/before` → `team_mgmt_apply_file_modification` |
| Block replacement        | `team_mgmt_prepare_file_block_replace` → `team_mgmt_apply_file_modification`       |
| Overwrite entire file    | `team_mgmt_overwrite_entire_file`                                                  |
| Validate team config     | `team_mgmt_validate_team_cfg({})`                                                  |
| Validate MCP config      | `team_mgmt_validate_mcp_cfg({})`                                                   |
