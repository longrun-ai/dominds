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

## 1. Background: Why "prepare-first + single apply"

Historically, text editing tools had multiple mental models ("direct write" vs "plan first then apply"), causing:

- Agents in low-attention states tend to "miswrite" or struggle to review (missing diff/evidence)
- Race condition between prepare→apply: tool calls in one message execute in parallel, potentially "prepare based on old file, but another tool already wrote"
- Split apply entrypoints: high learning cost, high regression cost

Therefore unified to:

- **prepare-first**: All incremental edits are planned first (output reviewable diff + evidence + hunk_id)
- **single apply**: All planned edits are persisted only through `apply_file_modification({ "hunk_id": "<hunk_id>" })`
- **Legacy tools removed**: `append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace` are completely removed (no aliases, no compat layer)

## 2. Goals & Non-Goals

### 2.1 Goals

- Unify incremental edits to: `prepare_*` → `apply_file_modification`
- Provide reviewable output: YAML summary + evidence (plan)/apply_evidence (apply) + unified diff
- Clarify concurrency/ordering constraints: avoid mixing prepare & apply in the same message
- Provide stable failure modes and next-step suggestions (especially anchor ambiguity and apply rejection)

### 2.2 Non-Goals

- No complex patch DSL (still based on unified diff)
- No cross-process/restart hunk persistence (current hunk registry is in-memory + TTL=1h)
- No "auto-formatting/auto-blank-line alignment"; only observable (style_warning) and minimal necessary normalization (EOF newline)

## 3. Key Concurrency Constraints & Ordering

### 3.1 Tool Parallel Execution

Multiple function tool calls in one message execute in parallel, unable to see each other's outputs/writes. Therefore:

- **prepare → apply must be two messages** (otherwise apply may not "see" the hunk generated in this round)

### 3.2 Apply Concurrency Safety (current implementation)

- Multiple `apply_file_modification` calls on the same file are serialized in-process (queue by `createdAtMs`, then `hunkId` as tie-breaker)
- Applies on different files can run in parallel, no shared lock

## 4. Hunk Registry & Lifecycle

### 4.1 Lifecycle & Ownership

- Each plan hunk has TTL (outputs `expires_at_ms`)
- Hunk is stored in-process in memory; lost after process restart
- `apply_file_modification` checks:
  - Whether hunk exists and hasn't expired
  - Whether hunk was planned by current member (`WRONG_OWNER` rejection)
  - Whether current member has write permission (`hasWriteAccess`)

### 4.2 "Overwrite Same Plan" Rules (important)

Tools supporting "re-plan with `existing_hunk_id` to overwrite" and their rules:

- `prepare_file_range_edit`: supports `existing_hunk_id`, but that id must exist, belong to current member, and match mode (cannot use another prepare mode's id to overwrite)
- `prepare_file_append` / `prepare_file_insert_after` / `prepare_file_insert_before`: same support for `existing_hunk_id` to overwrite same-mode preview
- `prepare_file_block_replace`: supports `existing_hunk_id` to overwrite same-mode preview (same owner / same kind; cross-mode rejected)
- All plan tools **do not allow custom new ids**: can only generate new plan by "omitting/clearing `existing_hunk_id`"; only pass `existing_hunk_id` when you want to overwrite an existing plan

> Note: some providers (e.g. Codex) require all function tool parameter fields to be "required" (schema all required).
> If you use such a provider but semantically want to express "unspecified/use default", use sentinel values; otherwise (most providers) **omit optional fields naturally**:
>
> - `existing_hunk_id: ""`: do not overwrite old plan (generate new hunk)
> - `occurrence: ""` or `0`: do not specify occurrence
> - `match: ""`: use default `contains` (note: `match` is match mode, not the text/regex to match)
> - `read_file({ range: "", max_lines: 0 })`: respectively "do not specify range / use default 500 lines"
> - `overwrite_entire_file({ content_format: "" })`: means "content format not explicitly declared" (will default reject if body strongly looks like diff/patch)
> - `ripgrep_*({ path: "", case: "", max_files: 0, max_results: 0 })`: respectively "default path '.' / default smart-case / use default limits"

## 5. Normalization Strategy

### 5.1 EOF Newline Normalization (hard rule)

Writing follows "each line ends with `\n` (including last line)":

- If file has no trailing newline, one is added before writing (`normalized_file_eof_newline_added`)
- If content has no trailing newline, one is added before writing (`normalized_content_eof_newline_added`)
- Both plan and apply outputs include `normalized.*` fields for review

### 5.2 Blank Line Style (observable only)

For append/insert, prepare phase outputs `blankline_style` and `style_warning` to alert about "potential double blank lines / stuck-together" risks; currently does not actively modify content blank line style
