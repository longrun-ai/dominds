# ws_mod: unified text-editing workflow (prepare-first + single apply)

You have read/write access to the workspace, but **all incremental text edits must be prepared first, then applied**: generate reviewable diff/evidence + `hunk_id`, then confirm the write.

## Principles

- Incremental edits: use `prepare_*` to generate an applyable hunk, then write via `apply_file_modification`.
- Legacy tools are removed (no compatibility layer): `append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace`.
- Constraint: paths under `*.tsk/` are encapsulated Taskdocs; file tools cannot access them.
- Parallelism constraint: multiple tool calls in one generation step may run in parallel; **prepare → apply must be two steps**.
- Output is YAML + unified diff (scan-friendly) with `summary` + `evidence`/`apply_evidence`.
- Normalization: all writes follow “each line ends with `\n` (including the last line)”; missing EOF newline will be added and shown in `normalized.*`.
- Exception: `overwrite_entire_file` overwrites an existing file (writes immediately; does not use prepare/apply). It requires `known_old_total_lines/known_old_total_bytes` guardrails (read `total_lines/size_bytes` from the YAML header of `read_file`). It also rejects diff/patch-like content by default unless `content_format=diff|patch`. Use it only for “small content (<100 lines)” or “intentional reset/generated output”; otherwise prefer prepare/apply.
- Exception: `create_new_file` only creates a new file (empty content allowed). It does not do incremental edits and does not use prepare/apply; it refuses to overwrite existing files.

## Which `prepare_*` to use

- Precise range edits: `prepare_file_range_edit({ path, range, content, existing_hunk_id })`
- Append to EOF: `prepare_file_append({ path, content, create, existing_hunk_id })`
- Anchor insertion: `prepare_file_insert_after|prepare_file_insert_before({ path, anchor, content, occurrence, match, existing_hunk_id })`
- Block replace between anchors: `prepare_file_block_replace({ path, start_anchor, end_anchor, content, existing_hunk_id, occurrence, include_anchors, match, require_unique, strict })`
  - `include_anchors: true` (default): keep the anchor lines; replace only the content between them (start/end lines are preserved).
  - `include_anchors: false`: replacement range includes the anchor lines (start/end lines are deleted and replaced).
- Create a new file (empty allowed): `create_new_file({ path, content })`

> Note: some providers (e.g. Codex) require all function-tool parameters to be present (schema all required).
> If you use such a provider but semantically want “unset / default”, use sentinel values; otherwise most providers can omit optional fields:
>
> - `existing_hunk_id: ""` means generate a new hunk (do not overwrite an existing plan).
> - `occurrence: ""` or `0` means occurrence is not specified.
> - `match: ""` means default `contains` (note: `match` is the match mode, not the text to match).

## hunk id rules (important)

- `prepare_*` generates `hunk_id` (TTL = 1 hour); apply can only use an unexpired hunk.
- Expired/unused hunks have no side effects; they are cleaned up automatically.
- Some prepare tools accept `existing_hunk_id` to overwrite the same prepared hunk; **custom new ids are not supported**.

## Apply semantics (context_match)

- `exact`: file matches the prepared context exactly.
- `fuzz`: file drifted but still safe to apply; the output includes `file_changed_since_preview` and digests for review.
- `rejected`: cannot locate uniquely or unsafe; re-prepare.

## Two-step template

1. Prepare (returns `hunk_id` + unified diff):

```text
Call the function tool `prepare_file_insert_after` with:
{ "path": "docs/spec.md", "anchor": "## Configuration", "content": "### Defaults\\n- provider: codex\\n" }
```

2. Apply (must be a separate step):

```text
Call the function tool `apply_file_modification` with:
{ "hunk_id": "<hunk_id>" }
```

## Examples

- Append to EOF:

```text
Call the function tool `prepare_file_append` with:
{ "path": "notes/prompt.md", "content": "## Tools\\n- Use prepare_* + apply_file_modification for incremental edits.\\n" }
```

- Line range replacement (`content` can be empty to delete the range):

```text
Call the function tool `prepare_file_range_edit` with:
{ "path": "README.md", "range": "10~12", "content": "New line 10\\nNew line 11\\n" }
```

- Block replace:

```text
Call the function tool `prepare_file_block_replace` with:
{ "path": "docs/spec.md", "start_anchor": "## Start", "end_anchor": "## End", "content": "NEW BLOCK LINE 1\\nNEW BLOCK LINE 2\\n" }
```

## Common failures and next steps

- `ANCHOR_AMBIGUOUS`: anchor appears multiple times and occurrence was not specified; set `occurrence` or use a range (`prepare_file_range_edit`).
- `ANCHOR_NOT_FOUND`: anchor not found; locate via `read_file` / `ripgrep_snippets`.
- apply `context_match: rejected`: file drift made the target non-unique/unsafe; re-prepare (narrow range or add more context).
- If apply fails: the output includes the failure reason and key diagnostics; follow it to re-prepare (narrow range, add context, or specify `occurrence` as needed).
