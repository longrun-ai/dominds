# ws_mod: unified text editing workflow (preview-first + single apply)

You have workspace write access, but **all incremental text edits must be preview-first**: generate a reviewable diff/evidence + `hunk_id`, then explicitly apply it to write the file.

## Principles

- Incremental edits: use `preview_*` to produce an applyable hunk; then write via `apply_file_modification`.
- Legacy tools are removed (no compat): `append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace`.
- Constraint: paths under `*.tsk/` are encapsulated Task Docs and are NOT accessible via file tools.
- Parallelism constraint: multiple tool calls in one message run in parallel; **preview → apply must be two messages** (until an orchestrator exists).
- Outputs are YAML + unified diff for quick review (`summary` + `evidence`/`apply_evidence`).
- Normalization: writes assume every line ends with `\n` (including the last line); EOF newlines are normalized and reported via `normalized.*`.
- Exception: `overwrite_entire_file` is a full-file overwrite function tool (writes immediately; not preview/apply). It requires `known_old_total_lines/known_old_total_bytes` as guardrails, and rejects diff/patch-like content by default unless `content_format='diff'|'patch'`. Use it only for small new content (e.g. <100 lines) or explicit resets/generated files; otherwise prefer preview/apply.

## Which `preview_*` to use

- Precise range edits: `preview_file_modification <path> <range> [!hunk]`
- Append to EOF: `preview_file_append <path> [create=true|false] [!hunk]`
- Anchor insertion: `preview_insert_after|preview_insert_before <path> <anchor> [options] [!hunk]`
- Block replace between anchors: `preview_block_replace <path> <start_anchor> <end_anchor> [options]`

## hunk id rules (important)

- `preview_*` generates a TTL-limited `hunk_id` (TTL = 1 hour); apply can only use an existing hunk.
- Expired/unused hunks have **no side effects** and are automatically cleaned up; you only need to care about the last `hunk_id` you intend to apply.
- Some preview tools accept `[!existing-hunk-id]` to revise the same preview; **custom new ids are not allowed**.

## apply semantics (context_match)

- `exact`: applies at the originally previewed content/location.
- `fuzz`: file drift exists but the target is still uniquely matchable and safe to apply.
- `rejected`: not uniquely matchable / unsafe; you must re-preview.

## 2-step template (copy/paste)

1. Preview (returns `hunk_id` + unified diff):

```plain-text
!?@preview_insert_after docs/spec.md "## Configuration" occurrence=1
!?### Defaults
!?- provider: codex
```

2. Apply (must be a separate message):

```plain-text
!?@apply_file_modification !<hunk_id>
```

## Examples

- Append to EOF:

```plain-text
!?@preview_file_append notes/prompt.md
!?## Tools
!?- Use preview_* + apply_file_modification for incremental edits.
```

- Replace a line range (empty body means delete):

```plain-text
!?@preview_file_modification README.md 10~12
!?New line 10
!?New line 11
```

- Block replace between anchors:

```plain-text
!?@preview_block_replace docs/spec.md "## Start" "## End" include_anchors=true
!?NEW BLOCK LINE 1
!?NEW BLOCK LINE 2
```

## Common failures and next steps

- `ANCHOR_AMBIGUOUS`: anchor appears multiple times and occurrence was not specified; set `occurrence` or use a range (`preview_file_modification`).
- `ANCHOR_NOT_FOUND`: anchor not found; locate via `read_file` / `ripgrep_snippets`.
- apply `context_match: rejected`: file drift made the target non-unique; re-preview (narrow range or add more context).
