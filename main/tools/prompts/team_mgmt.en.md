# team_mgmt: manage `.minds/` (direct edit)

You have read/write access to `.minds/**`, but this toolset **only operates within the `.minds/` subtree** (it should not touch other rtws (runtime workspace) files).

## Principles

- Incremental edits: single-block edits write directly. Use `team_mgmt_file_range_edit` for line ranges, `team_mgmt_file_append` for EOF appends, `team_mgmt_file_insert_after` / `team_mgmt_file_insert_before` for anchor insertions, and `team_mgmt_file_block_replace` for anchor-delimited blocks. For multi-point same-literal replacement, prefer `team_mgmt_prepare_occurrence_replace` followed by `team_mgmt_apply_occurrence_replace`; if only one occurrence is selected, prepare succeeds but returns `notice: NOT_MULTI_OCCURRENCE`. These edit tools accept inline `content` or a ws_mod `pad_id/pad_range` source.
- If you carry team-management responsibility, read the relevant `man({ "toolsetId": "team_mgmt" })` chapters before performing concrete team-management actions, and maintain `.minds/**` team mind assets by the handbook-standard workflow.
- Parallelism constraint: multiple function tool calls in one generation step may run in parallel. Same-file writes are serialized internally, but avoid making same-turn edits depend on unread results from each other.
- Exception (create): `team_mgmt_create_new_file` only creates a new file from `content` or `pad_id/pad_range` (empty content allowed); it refuses to overwrite existing files.
- Exception (overwrite): `team_mgmt_overwrite_entire_file` writes `content` or `pad_id/pad_range` immediately. It requires `known_old_total_lines/known_old_total_bytes` guardrails; use `team_mgmt_read_file` to read `total_lines/size_bytes` from the YAML header.
- Normalization: each line ends with `\\n` (including the last line); the tool may add a trailing newline and report it in `normalized.*`.

## read_file output fields (important)

The YAML header from `team_mgmt_read_file` includes:

- `total_lines`: total line count (empty file is 0); can be used for `team_mgmt_overwrite_entire_file.known_old_total_lines`
- `size_bytes`: byte size (stat().size); can be used for `team_mgmt_overwrite_entire_file.known_old_total_bytes`

## Path rules (important)

- This toolset resolves `path` under `.minds/` (e.g. `team.yaml` resolves to `.minds/team.yaml`).
- Any path that resolves outside `.minds/` after normalization is rejected.

## Which tool to use

- Read/locate: `team_mgmt_read_file` / `team_mgmt_list_dir` / `team_mgmt_ripgrep_*`
- Create a new file (empty allowed): `team_mgmt_create_new_file({ path, content })` or `team_mgmt_create_new_file({ path, pad_id, pad_range })`
- Small edits (line range): `team_mgmt_file_range_edit({ path, range, content })` or `team_mgmt_file_range_edit({ path, range, pad_id, pad_range })`
- Append to EOF: `team_mgmt_file_append({ path, content, create })`
- Anchor insertion: `team_mgmt_file_insert_after|team_mgmt_file_insert_before({ path, anchor, content, occurrence, match })`
- Block replace between anchors: `team_mgmt_file_block_replace({ path, start_anchor, end_anchor, content, occurrence, include_anchors, match, require_unique, strict })`
- Batch literal occurrence replacement: `team_mgmt_prepare_occurrence_replace({ path, find, content|pad_id, occurrence_indexes? })` then `team_mgmt_apply_occurrence_replace({ plan_id })`; it is designed for multi-point same-literal replacement, and single-occurrence plans succeed but return `notice: NOT_MULTI_OCCURRENCE`.
- After editing `.minds/team.yaml`: always run `team_mgmt_validate_team_cfg({})`; if the output shows "Resolved But Not Yet Cleared", finish with `team_mgmt_clear_problems({ source: "team", path: "team.yaml" })`.
- After editing `.minds/mcp.yaml`: always run `team_mgmt_validate_mcp_cfg({})`; if the output shows "Resolved But Not Yet Cleared", finish with `team_mgmt_clear_problems({ source: "mcp", path: "mcp.yaml" })`.

> Optional fields can be omitted.
> If you want to pass explicit “unset / default” values, the following sentinel forms are supported:
>
> - `occurrence: ""` or `0` means occurrence is not specified.
> - `match: ""` means default `contains` (note: `match` is the match mode).

## Direct line-range edit template

```text
Call the function tool `team_mgmt_file_range_edit` with:
{ "path": "team.yaml", "range": "10~12", "content": "..." }
```

## Create an empty file example

```text
Call the function tool `team_mgmt_create_new_file` with:
{ "path": "team/domains/new-domain.md", "content": "" }
```
