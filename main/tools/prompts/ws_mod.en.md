# ws_mod: unified text-editing workflow (direct range edit + prepare/apply)

You have read/write access to the rtws (runtime workspace). Prefer direct one-step `file_range_edit` for precise line-range edits. Use `prepare_*` + `apply_file_modification` when the target is anchor-based, occurrence-based, ambiguous, or when you explicitly need a hunk preview before writing.

## Principles

- Precise line ranges: use `file_range_edit({ path, range, content })` or `file_range_edit({ path, range, pad_id, pad_range })` to write directly. It defaults to redacted YAML output and does not echo body text. Set `preview: true` or `show_diff: true` only when review output is needed.
- Ambiguous targets / batch occurrence edits: use `prepare_*` to generate an applyable hunk, then write via `apply_file_modification`.
- Hard ordering rule for the LLM: `prepare_*` only creates an in-memory preview and does not write the file; before `apply_file_modification`, re-reading still returns the old content. If you want further edits based on the prepared result, you must apply the current hunk first, then read/prepare the next change. `file_range_edit` writes directly and is not part of this prepare ordering rule.
- Legacy tools are removed (no compatibility layer): `append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace`.
- Constraint: paths under `*.tsk/` are encapsulated Taskdocs; file tools cannot access them.
- Parallelism constraint: multiple function tool calls in one generation step may run in parallel; **prepare → apply must be two steps**. Same-file write tools are serialized internally, but avoid making multiple direct edits that semantically depend on unread results from each other.
- Output is usually YAML-first. Direct range edits default to no body echo; prepare/apply output is scan-friendly with `summary` + `evidence`/`apply_evidence` + unified diff. Pad-sourced writes are redacted by default to avoid echoing large pad bodies.
- Normalization: all writes follow “each line ends with `\n` (including the last line)”; missing EOF newline will be added and shown in `normalized.*`.
- Exception: `overwrite_entire_file` overwrites an existing file (writes immediately; does not use prepare/apply). It requires `known_old_total_lines/known_old_total_bytes` guardrails (read `total_lines/size_bytes` from the YAML header of `read_file`). `content_format` accepts any non-empty text label (for example `yaml`), but diff/patch-like content is still rejected by default unless `content_format=diff|patch`. Use it only for “small content (<100 lines)” or “intentional reset/generated output”; for large precise range edits, prefer pad + `file_range_edit`.
- Exception: `create_new_file` only creates a new file (empty content allowed). It does not do incremental edits and does not use prepare/apply; it refuses to overwrite existing files.
- Binary image tools: use `read_picture({ path })` to inspect PNG/JPEG/WebP/GIF images as real image context; use `write_picture({ path, data_base64, mime_type, overwrite })` to write a base64 image. These are binary image operations and do not use prepare/apply.

## Scratch Pad (large-text temporary buffer)

Scratch Pad is a ws_mod-specific large-text editing buffer for reducing repeated re-emission of the same large text across multiple editing turns. Pads appear as prominent special reminders near the end of context, but the role=user projection only shows `pad_id`, line/byte counts, and hash. It does not show body text or executable tool-call text.

- Ordinary reminder semantics stay unchanged: do not use `add_reminder` / `update_reminder` / `delete_reminder` to create, edit, or delete pads; use `pad_*` tools.
- No read/observation tools are provided: there is no `pad_read`, `pad_preview`, `pad_locate`, `pad_diff`, `pad_stat`, or `pad_list`. The current pads are the ones projected as reminders.
- Basic tools available: `pad_write`, `pad_load_file_range`, `pad_edit`, `pad_insert`, `pad_delete_range`, `pad_copy`, `pad_move`, `pad_prepare_file_range_edit`, `pad_delete`.
- `pad_write` / `pad_edit` can accept large text; that body still enters persistent history as function-call arguments. The goal is not to eliminate this one-time cost perfectly, but to use pad handles afterward instead of repeatedly emitting the same large text.
- Tool results do not echo pad body text; they return line count, byte count, hash, and a summary. Prefer `pad_copy` / `pad_move` when transferring large text between pads. To write pad content into a file line range, prefer `file_range_edit({ path, range, pad_id, pad_range })`; use `pad_prepare_file_range_edit` only when you explicitly need a hunk preview first, then `apply_file_modification`.
- Pad delete/update channels are exposed by the role=assistant reminder maintenance reference; do not look for executable deletion instructions in the role=user pad projection.
- Pads are temporary workbench state, not long-term memory. After applying or abandoning a pad, delete it promptly with `pad_delete({ pad_id })`.

## Which edit path to use

- Precise range edits: `file_range_edit({ path, range, content })`
- Large precise range edits: prepare a pad with `pad_write` or `pad_load_file_range`, then call `file_range_edit({ path, range, pad_id, pad_range })`
- Precise range edits that must be reviewed first: `file_range_edit({ path, range, content, preview: true, show_diff: true })`
- Multi-occurrence / anchor-based / ambiguous edits: use the matching `prepare_*`, then `apply_file_modification`
- Append to known EOF: `file_range_edit({ path, range: "<last_line+1>~", content })`
- Append with create or hunk preview: `prepare_file_append({ path, content, create, existing_hunk_id })`
- Anchor insertion: `prepare_file_insert_after|prepare_file_insert_before({ path, anchor, content, occurrence, match, existing_hunk_id })`
- Block replace between anchors: `prepare_file_block_replace({ path, start_anchor, end_anchor, content, existing_hunk_id, occurrence, include_anchors, match, require_unique, strict })`
  - `include_anchors: true` (default): keep the anchor lines; replace only the content between them (start/end lines are preserved).
  - `include_anchors: false`: replacement range includes the anchor lines (start/end lines are deleted and replaced).
- Create a new file (empty allowed): `create_new_file({ path, content })`

> Optional fields can be omitted.
> If you want to pass explicit “unset / default” values, the following sentinel forms are supported:
>
> - `existing_hunk_id: ""` means generate a new hunk (do not overwrite an existing plan).
> - `occurrence: ""` or `0` means occurrence is not specified.
> - `match: ""` means default `contains` (note: `match` is the match mode, not the text to match).

## hunk id rules (important)

- `prepare_*` generates `hunk_id` (TTL = 1 hour); apply can only use an unexpired hunk.
- Expired/unused hunks have no side effects; they are cleaned up automatically.
- Some prepare tools accept `existing_hunk_id` to overwrite the same prepared hunk; **custom new ids are not supported**.
- If you only want to revise the same not-yet-persisted preview, overwrite that hunk with the same prepare tool plus `existing_hunk_id`; if you want the next edit based on this change, apply the current hunk first, then prepare again.

## Apply semantics (context_match)

- `exact`: file matches the prepared context exactly.
- `fuzz`: file drifted but still safe to apply; the output includes `file_changed_since_preview` and digests for review.
- `rejected`: cannot locate uniquely or unsafe; re-prepare.

## Direct range edit template

```text
Call the function tool `file_range_edit` with:
{ "path": "README.md", "range": "10~12", "content": "New line 10\\nNew line 11\\n" }
```

Using a pad as the source:

```text
Call the function tool `file_range_edit` with:
{ "path": "README.md", "range": "10~12", "pad_id": "rewrite_intro", "pad_range": "~" }
```

## prepare/apply template

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

Before this step, the prepared diff is not persisted yet; a `read_file` at that point still returns the old content.

## Examples

- Append to EOF with hunk preview or create:

```text
Call the function tool `prepare_file_append` with:
{ "path": "notes/prompt.md", "content": "## Tools\\n- Use file_range_edit for precise ranges; prepare/apply for uncertain targets.\\n" }
```

- Line range replacement (`content` can be empty to delete the range):

```text
Call the function tool `file_range_edit` with:
{ "path": "README.md", "range": "10~12", "content": "New line 10\\nNew line 11\\n" }
```

- Block replace:

```text
Call the function tool `prepare_file_block_replace` with:
{ "path": "docs/spec.md", "start_anchor": "## Start", "end_anchor": "## End", "content": "NEW BLOCK LINE 1\\nNEW BLOCK LINE 2\\n" }
```

## Common failures and next steps

- `ANCHOR_AMBIGUOUS`: anchor appears multiple times and occurrence was not specified; set `occurrence` or use a range (`file_range_edit`).
- `ANCHOR_NOT_FOUND`: anchor not found; locate via `read_file` / `ripgrep_snippets`; if you can confirm line numbers, use `file_range_edit`.
- apply `context_match: rejected`: file drift made the target non-unique/unsafe; re-prepare (narrow range or add more context).
- If apply fails: the output includes the failure reason and key diagnostics; follow it to re-prepare (narrow range, add context, or specify `occurrence` as needed).
