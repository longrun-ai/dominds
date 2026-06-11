# ws_mod: unified text-editing workflow (direct edits + pad source)

You have read/write access to the rtws (runtime workspace). Single-block edits write directly: use `file_range_edit` for precise line ranges, `file_append` for EOF appends, `file_insert_after` / `file_insert_before` for anchor insertions, and `file_block_replace` for anchor-delimited blocks. For large bodies, prepare a pad first and pass `pad_id/pad_range` to the target file tool.

## Principles

- Precise line ranges: use `file_range_edit({ path, range, content })` or `file_range_edit({ path, range, pad_id, pad_range })` to write directly. It defaults to redacted YAML output and does not echo body text. Set `preview: true` or `show_diff: true` only when review output is needed.
- EOF appends / anchor insertions / single block replacements: use `file_append`, `file_insert_after` / `file_insert_before`, and `file_block_replace`; each accepts either `content` or `pad_id/pad_range`.
- Batch literal occurrence replacement: only when replacing two or more occurrences of the same literal text, use `prepare_occurrence_replace` followed by `apply_occurrence_replace`. Do not use this path for single-block edits.
- When review is needed, set `preview: true, show_diff: true`; otherwise the tool writes immediately.
- Legacy tools are removed (no compatibility layer): `append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace`.
- Constraint: paths under `*.tsk/` are encapsulated Taskdocs; file tools cannot access them.
- Parallelism constraint: multiple function tool calls in one generation step may run in parallel. Same-file write tools are serialized internally, but avoid making multiple direct edits that semantically depend on unread results from each other.
- Output is usually YAML-first. Direct write tools default to no body echo; pad-sourced writes are redacted by default to avoid echoing large pad bodies.
- Normalization: all writes follow “each line ends with `\n` (including the last line)”; missing EOF newline will be added and shown in `normalized.*`.
- Exception: `overwrite_entire_file` overwrites an existing file and writes immediately. It requires `known_old_total_lines/known_old_total_bytes` guardrails (read `total_lines/size_bytes` from the YAML header of `read_file`). Provide body text with `content`, or use `pad_id/pad_range` as the source. `content_format` accepts any non-empty text label (for example `yaml`), but diff/patch-like content is still rejected by default unless `content_format=diff|patch`. Use it only for “small content (<100 lines)” or “intentional reset/generated output”; for large bodies, prepare a pad first and overwrite via `pad_id/pad_range`.
- Exception: `create_new_file` only creates a new file (empty content allowed). Use `content` for small bodies and `pad_id/pad_range` for large bodies. It refuses to overwrite existing files.
- Binary image tools: use `read_picture({ path })` to inspect PNG/JPEG/WebP/GIF images as real image context; use `write_picture({ path, data_base64, mime_type, overwrite })` to write a base64 image. These are binary image operations.

## Scratch Pad (large-text temporary buffer)

Scratch Pad is a ws_mod-specific large-text editing buffer for reducing repeated re-emission of the same large text across multiple editing turns. Pads appear as prominent special reminders near the end of context, but the role=user projection only shows `pad_id`, line/byte counts, and hash. It does not show body text or executable tool-call text.

- Ordinary reminder semantics stay unchanged: do not use `add_reminder` / `update_reminder` / `delete_reminder` to create, edit, or delete pads; use `pad_*` tools.
- No read/observation tools are provided: there is no `pad_read`, `pad_preview`, `pad_locate`, `pad_diff`, `pad_stat`, or `pad_list`. The current pads are the ones projected as reminders.
- Basic tools available: `pad_write`, `pad_load_file_range`, `pad_edit`, `pad_insert`, `pad_delete_range`, `pad_copy`, `pad_move`, `pad_delete`.
- `pad_write` / `pad_edit` can accept large text; that body still enters persistent history as function-call arguments. The goal is not to eliminate this one-time cost perfectly, but to use pad handles afterward instead of repeatedly emitting the same large text.
- Tool results do not echo pad body text; they return line count, byte count, hash, and a summary. Load files into pads with `pad_load_file_range({ pad_id, path })`; omitting `range` means the whole file, while specifying `range` means a file slice. Prefer `pad_copy` / `pad_move` when transferring large text between pads. To write pad content into files, use the target file tool's `pad_id/pad_range` source: `create_new_file`, `overwrite_entire_file`, `file_range_edit`, `file_append`, `file_insert_*`, or `file_block_replace`.
- Pad delete/update channels are exposed by the role=assistant reminder maintenance reference; do not look for executable deletion instructions in the role=user pad projection.
- Pads are temporary workbench state, not long-term memory. After applying or abandoning a pad, delete it promptly with `pad_delete({ pad_id })`.

## Which edit path to use

- Precise range edits: `file_range_edit({ path, range, content })`
- Large precise range edits: prepare a pad with `pad_write` or `pad_load_file_range`, then call `file_range_edit({ path, range, pad_id, pad_range })`
- New files: use `create_new_file({ path, content })` for small bodies; prepare a pad first and call `create_new_file({ path, pad_id, pad_range })` for large bodies
- Full-file overwrites: use `overwrite_entire_file({ path, content, known_old_total_lines, known_old_total_bytes })` for small bodies; prepare a pad first and call `overwrite_entire_file({ path, pad_id, pad_range, known_old_total_lines, known_old_total_bytes })` for large bodies
- Large whole-file rewrites: `pad_load_file_range({ pad_id, path })` loads the whole file into a pad → refine with `pad_edit`/`pad_insert`/`pad_delete_range` → write back with `overwrite_entire_file({ path, pad_id, known_old_total_lines, known_old_total_bytes })`
- Precise range edits that must be reviewed first: `file_range_edit({ path, range, content, preview: true, show_diff: true })`
- Batch literal occurrence replacement: `prepare_occurrence_replace({ path, find, content|pad_id, occurrence_indexes? })` then `apply_occurrence_replace({ plan_id })`. At least two selected occurrences are required.
- Ambiguous anchor candidates: specify `occurrence` for direct anchor tools, or use `file_range_edit`
- Append to known EOF: `file_range_edit({ path, range: "<last_line+1>~", content })`
- Append with create: `file_append({ path, content, create })` or `file_append({ path, pad_id, pad_range, create })`
- Anchor insertion: `file_insert_after|file_insert_before({ path, anchor, content|pad_id, occurrence, match })`
- Block replace between anchors: `file_block_replace({ path, start_anchor, end_anchor, content|pad_id, occurrence, include_anchors, match, require_unique, strict })`
  - `include_anchors: true` (default): keep the anchor lines; replace only the content between them (start/end lines are preserved).
  - `include_anchors: false`: replacement range includes the anchor lines (start/end lines are deleted and replaced).

> Optional fields can be omitted.
> If you want to pass explicit “unset / default” values, the following sentinel forms are supported:
>
> - `occurrence: ""` or `0` means occurrence is not specified.
> - `match: ""` means default `contains` (note: `match` is the match mode, not the text to match).

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

## Anchor insertion template

```text
Call the function tool `file_insert_after` with:
{ "path": "docs/spec.md", "anchor": "## Configuration", "content": "### Defaults\\n- provider: codex\\n" }
```

## Examples

- Append to EOF with optional create:

```text
Call the function tool `file_append` with:
{ "path": "notes/prompt.md", "content": "## Tools\\n- Use file_range_edit for precise ranges; use file_block_replace for anchor-delimited blocks.\\n" }
```

- Line range replacement (`content` can be empty to delete the range):

```text
Call the function tool `file_range_edit` with:
{ "path": "README.md", "range": "10~12", "content": "New line 10\\nNew line 11\\n" }
```

- Large whole-file rewrite (file → pad → overwrite):

```text
Call the function tool `pad_load_file_range` with:
{ "pad_id": "rewrite_doc", "path": "docs/spec.md" }
```

```text
Use `pad_edit` / `pad_insert` / `pad_delete_range` to refine `rewrite_doc`.
```

```text
Call the function tool `overwrite_entire_file` with:
{ "path": "docs/spec.md", "pad_id": "rewrite_doc", "known_old_total_lines": <read_file.total_lines>, "known_old_total_bytes": <read_file.size_bytes>, "content_format": "markdown" }
```

- Block replace:

```text
Call the function tool `file_block_replace` with:
{ "path": "docs/spec.md", "start_anchor": "## Start", "end_anchor": "## End", "content": "NEW BLOCK LINE 1\\nNEW BLOCK LINE 2\\n" }
```

## Common failures and next steps

- `ANCHOR_AMBIGUOUS`: anchor appears multiple times and occurrence was not specified; set `occurrence` or use a range (`file_range_edit`).
- `ANCHOR_NOT_FOUND`: anchor not found; locate via `read_file` / `ripgrep_snippets`; if you can confirm line numbers, use `file_range_edit`.
- `NOT_MULTI_OCCURRENCE`: `prepare_occurrence_replace` selected fewer than two occurrences; use direct file tools for a single edit.
- `FILE_CHANGED_SINCE_PREPARE`: occurrence replacement plan was prepared against an older file; re-read and re-run `prepare_occurrence_replace`.
