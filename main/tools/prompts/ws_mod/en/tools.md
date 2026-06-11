# ws_mod Tool Reference

## Template (Tools)

### How to Read

- Function-tool definitions are the canonical source for parameters and returns; this manual only adds usage guidance.

### Per-Tool Fields (order)

1. Purpose
2. Call Signature
3. Parameters (summarize only when usage guidance is needed)
4. Preconditions
5. Success Signal
6. Failure/Errors
7. Copy-Ready Example
8. Common Misuse

## 1. Supporting Tools (Read/Locate/Review)

- `read_file` (function tool): Read-only view with limit and optional line number decoration (for review and positioning)
- `read_symlink` (function tool): Inspect a symlink target without following it
- `ripgrep_*` (function tool): Locate anchors and candidate snippets (`ripgrep_snippets` is usually most useful)

## 2. Raw Write Tools (Exceptions)

### 2.1 create_new_file

Create a new file, allows empty content.

- **Design intent**: Solve "creating empty/new files should not force incremental editing"; also avoid misusing `overwrite_entire_file` (its semantics is to overwrite existing files)
- **Behavior**: If target already exists, reject (`FILE_EXISTS`/`NOT_A_FILE`); if not exists, create parent directories and write content
- **Normalization**: If `content` is non-empty and missing trailing `\n`, append one and show `normalized_trailing_newline_added=true` in output
- **Output**: Both success and failure are YAML (for scripting and regression)

### 2.2 overwrite_entire_file

Full file overwrite (writes immediately).

- **Usage suggestion**: First use `read_file` to get `total_lines/size_bytes` as input for `known_old_total_lines/known_old_total_bytes`
- **Design intent**: For "new content is small (e.g., <100 lines)" or "clearly a reset/generated artifact" scenarios; for large bodies, prepare a pad first and pass `pad_id/pad_range`
- **Source**: pass small bodies directly with `content`; pass large bodies with `pad_id/pad_range`
- **Guardrail (required)**: Must provide `known_old_total_lines/known_old_total_bytes` (old file snapshot) to execute; reject if reconciliation doesn't match
- `content_format`: Optional text hint; any non-empty label is accepted (for example `yaml`, `toml`, `json`, `markdown`)
- **Guardrail (default reject)**: If content looks like diff/patch and `content_format=diff|patch` is not explicitly declared, default reject; use direct edit tools for actual edits, or declare diff/patch only when writing patch text literally
- **Limitation**: Does not create files; for creating empty/new files use `create_new_file`

### 2.3 create_symlink / rm_symlink

Create or remove a symlink path.

- **Design intent**: Make symlink operations explicit instead of overloading file/directory editing semantics
- **Behavior**: `create_symlink` writes the target string exactly as provided; relative targets are resolved by the filesystem relative to the link parent
- **Removal**: `rm_symlink` removes the link path itself without touching the target, and can remove broken symlinks
- **Output**: Success and failure outputs are YAML with `mode: create_symlink` / `mode: rm_symlink`

## 3. Incremental Edits (direct edit)

- `file_range_edit`: Directly replace/delete/append by precise line range (append via `N~` where `N=(last_line+1)`)
- `file_append`: Directly append to EOF, optionally with `create=true|false`
- `file_insert_after` / `file_insert_before`: Direct insertion by anchor line; if the anchor appears multiple times, specify `occurrence`
- `file_block_replace`: Direct block replacement by start/end anchors (configurable `include_anchors` / `require_unique` / `strict` / `occurrence`, etc.)
  - `include_anchors=true` (default): Keep start/end anchor lines, only replace content between them
  - `include_anchors=false`: Replacement range includes start/end anchor lines
- `prepare_occurrence_replace` / `apply_occurrence_replace`: Two-step literal occurrence replacement in one file, designed for multi-point same-literal replacement. This is the only prepare/apply path in ws_mod; direct file tools are usually clearer for one-off/single-block edits. If only one occurrence is selected, prepare succeeds but returns `notice: NOT_MULTI_OCCURRENCE`.
- `create_new_file` / `overwrite_entire_file` / `file_range_edit` / `file_append` / `file_insert_*` / `file_block_replace` all support `content` and `pad_id/pad_range` sources; use direct `content` for small bodies and pad sources for large bodies
- `pad_load_file_range({ pad_id, path })` can omit `range`, which defaults to the whole file; pass `range` to load only a file slice
- For review output, pass `preview: true, show_diff: true` to the direct tool; otherwise it writes immediately and does not echo body text

## 4. YAML Output Contract

> Goal: Scannable under low attention; stable fields for tooling and regression

### 4.1 Direct Write (Common Fields)

- `status: ok|error`
- `mode: file_range_edit|file_append|file_insert_after|file_insert_before|file_block_replace`
- `path`
- `action: replace|delete|append|insert|block_replace`
- `normalized.*` (EOF newline analysis)
- `summary` (1-2 sentences, scannable)
- Followed by a unified diff only when `show_diff=true`

### 4.2 Direct Write (Key Fields by Tool/Action)

- `file_append`:
  - `file_line_count_before|after`, `appended_line_count`
  - `blankline_style.file_trailing_blank_line_count` / `content_leading_blank_line_count`
  - `evidence_preview.before_tail|append_preview|after_tail`
- `file_insert_*`:
  - `position`, `anchor`, `match`
  - `candidates_count`, `occurrence_resolved`
  - `inserted_at_line`, `inserted_line_count`, `lines.old|new|delta`
  - `blankline_style.*`, `evidence_preview.*`
- `file_block_replace`:
  - `start_anchor` / `end_anchor` / `match`
  - `include_anchors` / `require_unique` / `strict`
  - `candidates_count` / `occurrence_resolved`
  - `block_range`, `replace_slice`, `lines.old|new|delta`
  - `evidence_preview.before_preview|old_preview|new_preview|after_preview`
- `prepare_occurrence_replace` / `apply_occurrence_replace`:
  - `plan_id`, `find`, `occurrences_found`, `selected_occurrences`, `selected_count`
  - `file.old_hash|new_hash`, `file.old_total_lines|new_total_lines`
  - `match_preview` on prepare; `FILE_CHANGED_SINCE_PREPARE` on apply if the file drifted

### 4.5 read_file / overwrite_entire_file (Structured Header)

- `read_file` output starts with YAML header (followed by code block content), which includes:
  - `total_lines` (for reconciliation guardrail: empty file is 0, can be directly used for `overwrite_entire_file.known_old_total_lines`)
- `overwrite_entire_file` success/failure outputs are both YAML (for programmatic handling and retry)

## 5. Relationship with .minds/

`.minds/` is the core of team configuration and rtws (runtime workspace) memory, and should usually be operated through the `team_mgmt` toolset's mirrored tools (e.g., `team_mgmt_file_insert_after`, etc.).
This toolset's direct edit mental model remains consistent, but path and permission semantics are determined by the team_mgmt tool wrapper layer (see team_mgmt documentation).
