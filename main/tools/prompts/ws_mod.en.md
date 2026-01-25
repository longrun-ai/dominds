# ws_mod: unified text editing workflow (preview-first + single apply)

You have workspace write access, but **all incremental text edits must be preview-first**: generate a reviewable diff/evidence + `hunk_id`, then explicitly apply it to write the file.

## Principles

- Incremental edits: use `preview_*` to produce an applyable hunk; then write via `apply_file_modification`.
- Legacy tools are removed (no compat): `append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace`.
- Constraint: paths under `*.tsk/` are encapsulated Task Docs and are NOT accessible via file tools.
- Parallelism constraint: multiple tool calls in one generation step may run in parallel; **preview → apply must be two steps** (until an orchestrator exists).
- Outputs are YAML + unified diff for quick review (`summary` + `evidence`/`apply_evidence`).
- Normalization: writes assume every line ends with `\n` (including the last line); EOF newlines are normalized and reported via `normalized.*`.
- Exception: `overwrite_entire_file` is a full-file overwrite function tool (writes immediately; not preview/apply). It requires `known_old_total_lines/known_old_total_bytes` as guardrails (prefer reading `guardrail_total_lines/guardrail_total_bytes` from the `read_file` YAML header), and rejects diff/patch-like content by default unless `content_format='diff'|'patch'`. Use it only for small new content (e.g. <100 lines) or explicit resets/generated files; otherwise prefer preview/apply.
  - Copying params: use `read_file`’s `guardrail_total_lines/guardrail_total_bytes` for the guardrails (do not use `display_total_lines`).
- Exception: `create_new_file` only creates a new file (empty content is allowed). It does not do incremental edits and does not use preview/apply; it refuses to overwrite existing files.

## Which `preview_*` to use

- Precise range edits: `preview_file_modification({ path, range, content, existing_hunk_id })`
- Append to EOF: `preview_file_append({ path, content, create, existing_hunk_id })`
- Anchor insertion: `preview_insert_after|preview_insert_before({ path, anchor, content, occurrence, match, existing_hunk_id })`
- Block replace between anchors: `preview_block_replace({ path, start_anchor, end_anchor, content, existing_hunk_id, occurrence, include_anchors, match, require_unique, strict })`
- Create a new file (empty allowed): `create_new_file({ path, content })`

> Note: some providers (e.g. Codex) require “all fields present” in function calls (schema is all-required).  
> Only for those providers: use sentinel values to express “unset / default”; otherwise (most providers) omit optional fields naturally:
>
> - `existing_hunk_id: ""` means “do not overwrite an existing plan” (generate a new hunk).
> - `occurrence: ""` or `0` means “occurrence not specified” (you may be required to set it when candidates are ambiguous).
> - `match: ""` means the default `contains` (note: `match` is a match mode, not a regex/text to match).

## hunk id rules (important)

- `preview_*` generates a TTL-limited `hunk_id` (TTL = 1 hour); apply can only use an existing hunk.
- Expired/unused hunks have **no side effects** and are automatically cleaned up; you only need to care about the last `hunk_id` you intend to apply.
- Some preview tools accept `existing_hunk_id` to revise the same preview; **custom new ids are not allowed**.

## apply semantics (context_match)

- `exact`: applies at the originally previewed content/location.
- `fuzz`: file drift exists but the target is still uniquely matchable and safe to apply.
- `rejected`: not uniquely matchable / unsafe; you must re-preview.

## 2-step template (copy/paste)

1. Preview (returns `hunk_id` + unified diff):

```text
Call the function tool `preview_insert_after` with:
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
Call the function tool `preview_file_append` with:
{ "path": "notes/prompt.md", "content": "## Tools\\n- Use preview_* + apply_file_modification for incremental edits.\\n" }
```

- Replace a line range (`content` may be an empty string to delete):

```text
Call the function tool `preview_file_modification` with:
{ "path": "README.md", "range": "10~12", "content": "New line 10\\nNew line 11\\n" }
```

- Block replace between anchors:

```text
Call the function tool `preview_block_replace` with:
{ "path": "docs/spec.md", "start_anchor": "## Start", "end_anchor": "## End", "content": "NEW BLOCK LINE 1\\nNEW BLOCK LINE 2\\n" }
```

## Common failures and next steps

- `ANCHOR_AMBIGUOUS`: anchor appears multiple times and occurrence was not specified; set `occurrence` or use a range (`preview_file_modification`).
- `ANCHOR_NOT_FOUND`: anchor not found; locate via `read_file` / `ripgrep_snippets`.
- apply `context_match: rejected`: file drift made the target non-unique; re-preview (narrow range or add more context).
