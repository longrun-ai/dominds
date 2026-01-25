# team-mgmt: manage `.minds/` (preview-first + single apply)

You have read/write access to `.minds/**`, but this toolset is **strictly scoped** to the `.minds/` subtree (it must not touch any other workspace files).

## Principles

- Incremental edits (preferred): use `team_mgmt_preview_*` to generate reviewable YAML + diff + `hunk_id`, then write via `team_mgmt_apply_file_modification({ "hunk_id": "<hunk_id>" })`.
- Parallelism constraint: multiple tool calls in one generation step may run in parallel; **preview → apply must be two steps**.
- Exception (create): `team_mgmt_create_new_file` only creates a new file (empty content allowed). It does not do incremental edits and does not use preview/apply; it refuses to overwrite existing files.
- Exception (full overwrite): `team_mgmt_overwrite_entire_file` writes immediately (not preview/apply) and requires `known_old_total_lines/known_old_total_bytes` as guardrails; prefer reading `guardrail_total_lines/guardrail_total_bytes` from the `team_mgmt_read_file` YAML header.
- Normalization: writes assume every line ends with `\\n` (including the last line); normalization is reported in output fields (e.g. `normalized_trailing_newline_added` / `normalized.*`).

## guardrail fields in read_file (important)

The `team_mgmt_read_file` YAML header includes:

- `display_total_lines`: display-stable line semantics (empty file is shown as 1 empty line)
- `guardrail_total_lines` / `guardrail_total_bytes`: guardrail semantics (empty file is 0 lines; bytes are stat().size), usable directly for `team_mgmt_overwrite_entire_file.known_old_total_lines/known_old_total_bytes`

## Path rules (important)

- This toolset resolves `path` under `.minds/`: e.g. `team.yaml` resolves to `.minds/team.yaml`.
- Any path that resolves outside `.minds/` is rejected.

## Which tool to use

- Read/locate: `team_mgmt_read_file` / `team_mgmt_list_dir` / `team_mgmt_ripgrep_*`
- Create a new file (empty allowed): `team_mgmt_create_new_file({ path, content })`
- Small edits (line range): `team_mgmt_preview_file_modification({ path, range, content, existing_hunk_id })`
- Append to EOF: `team_mgmt_preview_file_append({ path, content, create, existing_hunk_id })`
- Anchor insertion: `team_mgmt_preview_insert_after|team_mgmt_preview_insert_before({ path, anchor, content, occurrence, match, existing_hunk_id })`
- Block replace between anchors: `team_mgmt_preview_block_replace({ path, start_anchor, end_anchor, content, existing_hunk_id, occurrence, include_anchors, match, require_unique, strict })`
- Apply: `team_mgmt_apply_file_modification({ hunk_id })`
- After editing `.minds/team.yaml`: always run `team_mgmt_validate_team_cfg({})` and clear all Problems panel errors before proceeding.

> Note: some providers (e.g. Codex) require “all fields present” in function calls (schema is all-required).  
> Only for those providers: use sentinels to express “unset/default”; otherwise (most providers) omit optional fields naturally:
>
> - `existing_hunk_id: ""` means “do not overwrite an existing plan” (generate a new hunk).
> - `occurrence: ""` or `0` means “occurrence not specified”.
> - `match: ""` means the default `contains` (note: `match` is a match mode, not a regex/text to match).

## apply semantics (context_match)

- `exact`: applies at the originally previewed content/location.
- `fuzz`: file drift exists but the target is still safely applicable; output includes `file_changed_since_preview` and planned/current digests for review.
- `rejected`: not uniquely matchable / unsafe; you must re-preview.

## 2-step template (copy/paste)

1. Preview:

```text
Call the function tool `team_mgmt_preview_file_modification` with:
{ "path": "team.yaml", "range": "10~12", "content": "..." }
```

2. Apply (must be a separate step):

```text
Call the function tool `team_mgmt_apply_file_modification` with:
{ "hunk_id": "<hunk_id>" }
```

## Create empty file example

```text
Call the function tool `team_mgmt_create_new_file` with:
{ "path": "team/domains/new-domain.md", "content": "" }
```
