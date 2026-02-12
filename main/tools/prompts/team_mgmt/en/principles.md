# team_mgmt Core Principles

## Principles

- **Incremental edits (preferred)**: Use `team_mgmt_prepare_*` to generate reviewable YAML + diff + `hunk_id`, then write via `team_mgmt_apply_file_modification({ "hunk_id": "<hunk_id>" })`
- **Parallelism constraint**: Multiple function tool calls in one generation step may run in parallel; **prepare → apply must be two steps**
- **Exception (create)**: `team_mgmt_create_new_file` only creates a new file (empty content allowed). It does not do incremental edits and does not use prepare/apply; it refuses to overwrite existing files
- **Exception (overwrite)**: `team_mgmt_overwrite_entire_file` writes immediately (no prepare/apply). It requires `known_old_total_lines/known_old_total_bytes` guardrails; use `team_mgmt_read_file` to read `total_lines/size_bytes` from the YAML header
- **Normalization**: each line ends with `\n` (including the last line); the tool may add a trailing newline and report it in `normalized.*`

## Path Rules (important)

- This toolset resolves `path` under `.minds/` (e.g., `team.yaml` resolves to `.minds/team.yaml`)
- Any path that resolves outside `.minds/` after normalization is rejected

## read_file Output Fields (important)

The YAML header from `team_mgmt_read_file` includes:

- `total_lines`: total line count (empty file is 0); can be used for `team_mgmt_overwrite_entire_file.known_old_total_lines`
- `size_bytes`: byte size (stat().size); can be used for `team_mgmt_overwrite_entire_file.known_old_total_bytes`

## Apply Semantics (context_match)

- `exact`: file matches the prepare context exactly
- `fuzz`: file drifted but still safe to apply; the output includes `file_changed_since_preview` and digests for review
- `rejected`: cannot locate uniquely or unsafe; re-prepare

## Sentinel Value Usage

> Note: some providers (e.g. Codex) require all function-tool parameter fields to be present (schema all required).
> If you use such a provider but semantically want "unset / default", use sentinel values; otherwise most providers can omit optional fields:

- `existing_hunk_id: ""` means generate a new hunk
- `occurrence: ""` or `0` means occurrence is not specified
- `match: ""` means default `contains` (note: `match` is the match mode)

## Comparison with ws_mod

| Aspect             | ws_mod                      | team_mgmt                       |
| ------------------ | --------------------------- | ------------------------------- |
| Scope              | Any file in rtws            | Only `.minds/`                  |
| Tool prefix        | None                        | `team_mgmt_`                    |
| Path resolution    | Relative/absolute path      | Auto prepends `.minds/`         |
| Permission control | Depends on rtws permissions | Determined by team_mgmt wrapper |
