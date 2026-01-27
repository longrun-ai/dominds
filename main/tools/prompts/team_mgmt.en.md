# team-mgmt: manage `.minds/` (prepare-first + single apply)

You have read/write access to `.minds/**`, but this toolset **only operates within the `.minds/` subtree** (it should not touch other workspace files).

## Principles

- Incremental edits (preferred): use `team_mgmt_prepare_*` to generate reviewable YAML + diff + `hunk_id`, then write via `team_mgmt_apply_file_modification({ "hunk_id": "<hunk_id>" })`.
- Parallelism constraint: multiple tool calls in one generation step may run in parallel; **prepare → apply must be two steps**.
- Exception (create): `team_mgmt_create_new_file` only creates a new file (empty content allowed). It does not do incremental edits and does not use prepare/apply; it refuses to overwrite existing files.
- Exception (overwrite): `team_mgmt_overwrite_entire_file` writes immediately (no prepare/apply). It requires `known_old_total_lines/known_old_total_bytes` guardrails; use `team_mgmt_read_file` to read `total_lines/size_bytes` from the YAML header.
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
- Create a new file (empty allowed): `team_mgmt_create_new_file({ path, content })`
- Small edits (line range): `team_mgmt_prepare_file_range_edit({ path, range, content, existing_hunk_id })`
- Append to EOF: `team_mgmt_prepare_file_append({ path, content, create, existing_hunk_id })`
- Anchor insertion: `team_mgmt_prepare_file_insert_after|team_mgmt_prepare_file_insert_before({ path, anchor, content, occurrence, match, existing_hunk_id })`
- Block replace between anchors: `team_mgmt_prepare_file_block_replace({ path, start_anchor, end_anchor, content, existing_hunk_id, occurrence, include_anchors, match, require_unique, strict })`
- Apply: `team_mgmt_apply_file_modification({ hunk_id })`
- After editing `.minds/team.yaml`: always run `team_mgmt_validate_team_cfg({})` and clear all Problems panel errors before proceeding.

> Note: some providers (e.g. Codex) require all function-tool parameter fields to be present (schema all required).
> If you use such a provider but semantically want “unset / default”, use sentinel values; otherwise most providers can omit optional fields:
>
> - `existing_hunk_id: ""` means generate a new hunk.
> - `occurrence: ""` or `0` means occurrence is not specified.
> - `match: ""` means default `contains` (note: `match` is the match mode).

## Apply semantics (context_match)

- `exact`: file matches the prepare context exactly.
- `fuzz`: file drifted but still safe to apply; the output includes `file_changed_since_preview` and digests for review.
- `rejected`: cannot locate uniquely or unsafe; re-prepare.

## Two-step template

1. Prepare:

```text
Call the function tool `team_mgmt_prepare_file_range_edit` with:
{ "path": "team.yaml", "range": "10~12", "content": "..." }
```

2. Apply (must be a separate step):

```text
Call the function tool `team_mgmt_apply_file_modification` with:
{ "hunk_id": "<hunk_id>" }
```

## Create an empty file example

```text
Call the function tool `team_mgmt_create_new_file` with:
{ "path": "team/domains/new-domain.md", "content": "" }
```
