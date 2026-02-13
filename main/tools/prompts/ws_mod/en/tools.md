# ws_mod Tool Reference

## Template (Tools)

### How to Read

- The schema-generated "Tool Contract (Schema)" section is canonical for parameters/returns.

### Per-Tool Fields (order)

1. Purpose
2. Call Signature
3. Parameters (refer to schema)
4. Preconditions
5. Success Signal
6. Failure/Errors
7. Copy-Ready Example
8. Common Misuse

## 1. Supporting Tools (Read/Locate/Review)

- `read_file` (function tool): Read-only view with limit and optional line number decoration (for review and positioning)
- `ripgrep_*` (function tool): Locate anchors and candidate snippets (`ripgrep_snippets` is usually most useful)

## 2. Raw Write Tools (Exceptions)

### 2.1 create_new_file

Create a new file (no prepare/apply), allows empty content.

- **Design intent**: Solve "creating empty/new files should not force incremental editing"; also avoid misusing `overwrite_entire_file` (its semantics is to overwrite existing files)
- **Behavior**: If target already exists, reject (`FILE_EXISTS`/`NOT_A_FILE`); if not exists, create parent directories and write content
- **Normalization**: If `content` is non-empty and missing trailing `\n`, append one and show `normalized_trailing_newline_added=true` in output
- **Output**: Both success and failure are YAML (for scripting and regression)

### 2.2 overwrite_entire_file

Full file overwrite (**no prepare/apply**).

- **Usage suggestion**: First use `read_file` to get `total_lines/size_bytes` as input for `known_old_total_lines/known_old_total_bytes`
- **Design intent**: For "new content is small (e.g., <100 lines)" or "clearly a reset/generated artifact" scenarios; prefer prepare/apply for other cases
- **Guardrail (required)**: Must provide `known_old_total_lines/known_old_total_bytes` (old file snapshot) to execute; reject if reconciliation doesn't match
- **Guardrail (default reject)**: If content looks like diff/patch and `content_format=diff|patch` is not explicitly declared, default reject and guide to use prepare/apply (avoid mistakenly writing patch text into file)
- **Limitation**: Does not create files; for creating empty/new files use `create_new_file`; for creating new file with non-empty initial content use `prepare_file_append create=true` → `apply_file_modification`

## 3. Incremental Edits (prepare-first)

- `prepare_file_range_edit`: Preview replace/delete/append by line range (append via `N~` where `N=(last_line+1)`)
- `prepare_file_append`: Preview append to EOF (optional `create=true|false`)
- `prepare_file_insert_after` / `prepare_file_insert_before`: Preview insertion by anchor line (prepare phase strictly handles ambiguity; if anchor appears multiple times, must specify `occurrence`)
- `prepare_file_block_replace`: Preview block replacement by start/end anchors (configurable `include_anchors` / `require_unique` / `strict` / `occurrence`, etc.)
  - `include_anchors=true` (default): Keep start/end anchor lines, only replace content between them
  - `include_anchors=false`: Replacement range includes start/end anchor lines (will delete anchor lines and replace with new content)
- `apply_file_modification`: The sole apply, can apply hunks from any `prepare_*` above (range/append/insert/block_replace)

## 4. YAML Output Contract

> Goal: Scannable under low attention; stable fields for tooling and regression

### 4.1 Plan (Common Fields)

- `status: ok|error`
- `mode: prepare_file_range_edit|prepare_file_append|prepare_file_insert_after|prepare_file_insert_before|prepare_file_block_replace`
- `path`
- `hunk_id`, `expires_at_ms`
- `action: replace|delete|append|insert|block_replace`
- `normalized.*` (EOF newline analysis)
- `summary` (1-2 sentences, scannable)
- Followed by YAML, a ` ```diff ` unified diff (for review)

### 4.2 Plan (Key Fields by Tool/Action)

- `prepare_file_range_edit`:
  - `range.input` / `range.resolved.start|end`
  - `lines.old|new|delta`
  - `evidence.before|range|after`
- `prepare_file_append`:
  - `file_line_count_before|after`, `appended_line_count`
  - `blankline_style.file_trailing_blank_line_count` / `content_leading_blank_line_count`
  - `evidence_preview.before_tail|append_preview|after_tail`
- `prepare_file_insert_*`:
  - `position`, `anchor`, `match`
  - `candidates_count`, `occurrence_resolved`
  - `inserted_at_line`, `inserted_line_count`, `lines.old|new|delta`
  - `blankline_style.*`, `evidence_preview.*`
- `prepare_file_block_replace`:
  - `start_anchor` / `end_anchor` / `match`
  - `include_anchors` / `require_unique` / `strict`
  - `candidates_count` / `occurrence_resolved`
  - `block_range`, `replace_slice`, `lines.old|new|delta`
  - `evidence_preview.before_preview|old_preview|new_preview|after_preview`

### 4.3 Apply (Common Fields)

- `status`
- `mode: apply_file_modification`
- `path`, `hunk_id`
- `action`
- `context_match: exact|fuzz|rejected`
- `apply_evidence` (required)
- `summary` - Followed by YAML, unified diff (recalculated based on "current file + parsed target position" at apply time; if `context_match=exact`, matches plan diff)

### 4.4 Apply (Key Fields by Action)

- `append`: `append_range.start|end` + tail previews
- `insert`: `position` / `anchor` / `inserted_at_line` / `inserted_line_count`
- `replace|delete` (range): `applied_range.start|end` + `lines.*`
- `block_replace`: `block_range` / `replace_slice` / `lines.*`

### 4.5 read_file / overwrite_entire_file (Structured Header)

- `read_file` output starts with YAML header (followed by code block content), which includes:
  - `total_lines` (for reconciliation guardrail: empty file is 0, can be directly used for `overwrite_entire_file.known_old_total_lines`)
- `overwrite_entire_file` success/failure outputs are both YAML (for programmatic handling and retry)

## 5. Relationship with .minds/

`.minds/` is the core of team configuration and rtws (runtime workspace) memory, and should usually be operated through the `team_mgmt` toolset's mirrored tools (e.g., `team_mgmt_prepare_file_insert_after`, etc.).
This toolset's "prepare-first + single apply" mental model remains consistent, but path and permission semantics are determined by the team_mgmt tool wrapper layer (see team_mgmt documentation).
