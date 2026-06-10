# ws_mod Core Principles

## Template (Principles)

### Design Goals

- <Goal 1>
- <Goal 2>

### Contract Principles

- <Input/Output contract rules>

### Safety & Boundaries

- <Access constraints / guardrails>

### Failure & Recovery

- <What to do when a call fails>

### Glossary

- <Toolset-specific terms>

## 1. Background: Why direct range edit + prepare/apply

Historically, text editing tools had multiple mental models ("direct write" vs "plan first then apply"), causing:

- Agents in low-attention states tend to "miswrite" or struggle to review (missing diff/evidence)
- Race condition between prepare→apply: tool calls in one message execute in parallel, potentially "prepare based on old file, but another tool already wrote"
- Split apply entrypoints: high learning cost, high regression cost

The first prepare-first + single apply version improved reviewability, but made precise line-range and large-text edits too slow. The current model is:

- **direct range edit**: precise line ranges use `file_range_edit` directly; it defaults to YAML-only/redacted output
- **direct single-block edit**: EOF appends, anchor insertions, and anchor-delimited block replacements use `file_append`, `file_insert_after` / `file_insert_before`, and `file_block_replace`
- **preview as display option**: set `preview/show_diff` when review output is needed; otherwise direct tools write immediately
- **Legacy tools removed**: `append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace` are completely removed (no aliases, no compat layer)

## 2. Goals & Non-Goals

### 2.1 Goals

- Unify precise line-range edits to: `file_range_edit`
- Unify single-block append/insert/block replacement to direct `file_*` tools
- Provide reviewable output: direct tools default to YAML-only; explicit `preview/show_diff` emits diff
- Clarify concurrency/ordering constraints: same-file writes are serialized in-process
- Provide stable failure modes and next-step suggestions (especially anchor ambiguity)

### 2.2 Non-Goals

- No complex patch DSL (still based on unified diff)
- No "auto-formatting/auto-blank-line alignment"; only observable (style_warning) and minimal necessary normalization (EOF newline)

## 3. Key Concurrency Constraints & Ordering

### 3.1 Tool Parallel Execution

Multiple function tool calls in one message execute in parallel, unable to see each other's outputs/writes. Therefore:

- Use `file_range_edit` for precise line ranges; use the matching direct `file_*` tool for appends, anchor insertions, and block replacements.
- Set `preview/show_diff` when review output is needed.

### 3.2 Write Concurrency Safety (current implementation)

- Multiple direct writes on the same file are serialized in-process
- Writes on different files can run in parallel, no shared lock

> Optional fields can be omitted naturally.
> If you want to express explicit "unspecified/use default", use these sentinel forms:
>
> - `occurrence: ""` or `0`: do not specify occurrence
> - `match: ""`: use default `contains` (note: `match` is match mode, not the text/regex to match)
> - `read_file({ range: "", max_lines: 0 })`: respectively "do not specify range / use default 500 lines"
> - `overwrite_entire_file({ content_format: "" })`: means "content format not explicitly declared" (will default reject if body strongly looks like diff/patch). Any non-empty label such as `yaml` is accepted literally, but only `diff` / `patch` have special semantics.
> - `ripgrep_*({ path: "", case: "", max_files: 0, max_results: 0 })`: respectively "default path '.' / default smart-case / use default limits"

## 5. Normalization Strategy

### 5.1 EOF Newline Normalization (hard rule)

Writing follows "each line ends with `\n` (including last line)":

- If file has no trailing newline, one is added before writing (`normalized_file_eof_newline_added`)
- If content has no trailing newline, one is added before writing (`normalized_content_eof_newline_added`)
- Both plan and apply outputs include `normalized.*` fields for review

### 5.2 Blank Line Style (observable only)

For append/insert, prepare phase outputs `blankline_style` and `style_warning` to alert about "potential double blank lines / stuck-together" risks; currently does not actively modify content blank line style
