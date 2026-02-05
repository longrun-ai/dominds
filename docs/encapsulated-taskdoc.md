# Encapsulated Taskdocs (`*.tsk/`) (Design)

Chinese version: [中文版](./encapsulated-taskdoc.zh.md)

This document specifies a **structured, encapsulated Taskdoc format** for Dominds dialogs.

Instead of a single mutable “Taskdoc” markdown file, each dialog tree’s Taskdoc becomes a **Taskdoc package directory**
with a stable schema and a strict access policy.

## Goals

- **Clarity**: separate “what we want” (goals) from “what we must obey” (constraints) and “where we are” (progress).
- **Coordination**: make the Taskdoc the task’s **live coordination bulletin board** across mainlines/agents (keep `progress.md`/`constraints.md` current; don’t bury key decisions in chat).
- **Durability**: make task state persist across long-running work and across dialog course resets.
- **Auditability**: make task changes explicit and attributable to a single, intentional action.
- **Safety**: prevent accidental or tool-driven reads/writes that bypass intended UX and control points.
- **Shareability**: ensure the Taskdoc is visible/consistent across the entire dialog tree (root + subdialogs).

## Non-goals

- Replacing reminders, Q4H, or agent memory (these remain separate mechanisms).
- Designing a general-purpose project management format (tickets, epics, multi-task boards).
- Supporting arbitrary binary assets inside Taskdoc packages (out of scope for v1).

## Terminology

- **Dialog tree**: a root dialog plus any subdialogs/teammates spawned under it.
- **Taskdoc package**: a directory ending in `.tsk/` that stores the Taskdoc as multiple files.
- **Taskdoc (effective)**: the logical Taskdoc content presented to the agent, derived from the Taskdoc package.
- **Encapsulation**: treating `.tsk/` as protected internal state, not general rtws (runtime workspace) files.

## Taskdoc Package Structure

A Taskdoc package is a directory with the suffix `.tsk/` (e.g. `my-task.tsk/`), containing:

- `goals.md` (required)
- `constraints.md` (required)
- `progress.md` (required)
- (optional) injected “bear in mind” section directory `bearinmind/` (see below)
- (optional) additional **app-specific** files and directories (read-only to general file tools)

### File meanings

#### `goals.md`

The intent and success criteria.

- SHOULD be phrased as outcomes.
- SHOULD be stable over time; use `progress.md` for daily churn.

#### `constraints.md`

Hard requirements and prohibitions.

- MUST include any relevant policy rules, safety rules, formatting requirements, scope limits, and invariants.
- SHOULD be written as crisp, testable statements (prefer “MUST/SHOULD/MUST NOT”).

#### `progress.md`

Current status, decisions made, and what remains.

- SHOULD be safe to update frequently.
- MAY include checklists, short logs, and decision notes.
- SHOULD avoid duplicating full dialog history; keep it distilled and actionable.

### Optional injected directory: `bearinmind/` (design)

Dominds MAY support a special subdirectory `bearinmind/` inside the Taskdoc package.

Design goals:

- Provide a small, stable place for “always remember / must not forget” content that is distinct from `constraints.md`.
- Keep prompt size predictable and avoid runtime-configurable injection.

#### Allowed files (fixed whitelist; max 6)

If `bearinmind/` exists, it MAY contain up to **6** files with fixed names:

- `contracts.md`
- `acceptance.md`
- `grants.md`
- `runbook.md`
- `decisions.md`
- `risks.md`

Hard rules:

- Files with these names MUST NOT appear outside `bearinmind/`.
- Conversely, `goals.md`, `constraints.md`, `progress.md` MUST NOT appear under any subdirectory.
- No other files under `bearinmind/` are allowed.

Future expansion is allowed only via a product/design change (extending the whitelist); it MUST NOT be runtime-configurable.

### Additional files (app-specific)

The runtime MAY store additional files inside the Taskdoc package for internal needs (examples:
`snapshots/`, `attachments-index.md`).

Design constraints:

- These files MUST NOT be treated as normal rtws files.
- They MUST NOT be editable via normal file tools.
- If any are user-visible, they MUST be surfaced via explicit UI affordances rather than raw file reads.

## Effective Taskdoc (for agent context)

Dominds MUST construct an **effective Taskdoc** from the Taskdoc package for use in prompts and UI display.

Normative structure (v1):

1. A stable heading indicating this is the Taskdoc for the dialog tree
2. `## Goals` followed by the content of `goals.md`
3. `## Constraints` followed by the content of `constraints.md`
4. `## Progress` followed by the content of `progress.md`

### Prompt injection rules (design)

The effective Taskdoc is what the system prompt injects into the agent context.

Injection MUST be deterministic and bounded:

- Always inject the top-level three sections (`goals.md`, `constraints.md`, `progress.md`).
- Optionally inject a `## Bear In Mind` block **only** from the fixed-whitelist `bearinmind/` directory.
- No other subdirectories or files are injected as body content (an index of extra sections may be shown for discoverability; the content must be read via `recall_taskdoc`).

If present, the injected `## Bear In Mind` block MUST appear **between** `## Constraints` and `## Progress`.

If present, the injected `bearinmind/` sections MUST appear in this fixed order:

1. `contracts.md`
2. `acceptance.md`
3. `grants.md`
4. `runbook.md`
5. `decisions.md`
6. `risks.md`

### Canonical system/tool copy (MUST)

The system prompt and any tool documentation shown to agents MUST make the following explicit:

1. `.tsk/` encapsulation restrictions
2. prompt injection rules (what is automatically injected into context)

Below is the canonical copy. If you need to rephrase it for UI layout, you MUST preserve the semantics.

#### Canonical copy (zh; semantic baseline)

**Taskdoc 封装与访问限制**

- 任何 `.tsk/` 目录及其子路径（`**/*.tsk/**`）都是封装状态：禁止使用任何通用文件工具读取/写入/列目录（例如 `read_file` / `write_file` / `list_dir` 等）。
- 更新 Taskdoc 只能使用函数工具 `change_mind`（按章节整段替换；顶层用 `selector`，额外章节用 `category + selector`）。
- 读取“不会自动注入上下文”的额外章节，只能使用函数工具 `recall_taskdoc({ category, selector })`。

**Taskdoc 自动注入规则（系统提示）**

- 系统提示会把“有效 Taskdoc”自动注入到模型上下文中。
- 一定会注入顶层三段：`goals.md`、`constraints.md`、`progress.md`（按此顺序）。
- 可选注入 `bearinmind/`（仅固定白名单，最多 6 个文件）：`contracts.md`、`acceptance.md`、`grants.md`、`runbook.md`、`decisions.md`、`risks.md`。
- 若存在 `bearinmind/` 注入块，它会以 `## Bear In Mind` 出现在 `## Constraints` 与 `## Progress` 之间，并按以上固定顺序拼接。
- 除此之外，`.tsk/` 内任何其他目录/文件都不会被自动注入正文（系统只会注入一个“额外章节索引”用于提示；需要时用 `recall_taskdoc` 显式读取）。

#### Reference copy (en; must match zh)

**Taskdoc encapsulation & access restrictions**

- Any `.tsk/` directory and its subpaths (`**/*.tsk/**`) are encapsulated state: general file tools MUST NOT read/write/list them (e.g. `read_file` / `write_file` / `list_dir`).
- Taskdoc updates MUST go through the function tool `change_mind` (whole-section replace; use top-level `selector`, or `category + selector` for extra sections).
- To read extra sections that are NOT auto-injected, use the function tool `recall_taskdoc({ category, selector })`.

**Taskdoc auto-injection rules (system prompt)**

- The system prompt auto-injects the “effective Taskdoc” into the model context.
- It always injects the three top-level sections in order: `goals.md`, `constraints.md`, `progress.md`.
- It may also inject `bearinmind/` (fixed whitelist only; max 6 files): `contracts.md`, `acceptance.md`, `grants.md`, `runbook.md`, `decisions.md`, `risks.md`.
- If present, the injected block appears as `## Bear In Mind` between `## Constraints` and `## Progress`, and the files are concatenated in the fixed order above.
- No other directories/files inside `.tsk/` are auto-injected as body content (only an “extra sections index” may be injected for discoverability; use `recall_taskdoc` when needed).

Notes:

- The effective Taskdoc MUST be deterministic (no hidden reformatting beyond the above framing).
- Empty sections are allowed but the files still exist.

## `change_mind` Semantics (No Course Reset)

The function tool `change_mind` updates **exactly one** section file of the Taskdoc package by **replacing its entire contents**.

Critically:

- `change_mind` **MUST NOT** start a new dialog course.
- If a course reset is desired, call the function tool `clear_mind({ "reminder_content": "<continuation package>" })` (or other course-control mechanisms) separately.
  - Recommendation: include a short, scannable continuation package so the agent can resume after the new course.

### Arguments (current)

`change_mind` updates **exactly one** Taskdoc section by **replacing its entire contents**.

It takes:

- `selector` (required)
- `content` (required)
- `category` (optional)

When `category` is missing/empty, `selector` targets the **top-level** section files:

- `goals`
- `constraints`
- `progress`

When `category` is provided, `selector` targets a file under `<category>/` inside the Taskdoc package.

Reserved selectors and their allowed locations:

- Top-level only (no category): `goals`, `constraints`, `progress`
- `category="bearinmind"` only: `contracts`, `acceptance`, `grants`, `runbook`, `decisions`, `risks`

Other categories:

- `category` MUST be a safe identifier (e.g. `ux`, `ux.checklists`)
- `selector` MUST be a safe identifier
- Target file path is `<category>/<selector>.md`

Hard prohibitions:

- `goals|constraints|progress` MUST NOT be written under any category directory.
- `contracts|acceptance|grants|runbook|decisions|risks` MUST NOT be written outside `category="bearinmind"`.
- No other category is auto-injected into the system prompt (only an index may be shown).

### `recall_taskdoc` (read-only; for non-auto-injected sections)

Because general file tools cannot read anything under `*.tsk/`, Dominds provides a dedicated read tool:

```
recall_taskdoc({ category, selector })
```

Behavior:

- Reads `bearinmind/<whitelisted>.md` or `<category>/<selector>.md`.
- The top-level three sections (`goals` / `constraints` / `progress`) are already auto-injected, so `recall_taskdoc` does not read them.

Example (bearinmind):

```text
Call the function tool `change_mind` with:
{ "selector": "grants", "category": "bearinmind", "content": "- Allowed: ...\n- Disallowed: ...\n" }
```

Example (extra category):

```text
Call the function tool `recall_taskdoc` with:
{ "category": "ux", "selector": "checklist" }
```

Example:

```text
Call the function tool `change_mind` with:
{ "selector": "constraints", "content": "- MUST not browse the web.\n- MUST keep responses under 10 lines unless asked otherwise.\n" }
```

### Behavioral rules

- The `(category, selector)` pair MUST be valid per the reserved selector rules above; anything else is an error.
- The body is treated as opaque markdown text; no partial patching/diff semantics are implied.
- A successful `change_mind` updates the Taskdoc package immediately and becomes visible to:
  - the current dialog
  - all subdialogs/teammates in the dialog tree
  - any observing WebUI clients

### Failure cases (non-exhaustive)

`change_mind` MUST be rejected if:

- The selector is missing or invalid.
- The body is missing (empty body is allowed only if explicitly supported; v1 SHOULD reject empty body to prevent mistakes).
- The call attempts to target files outside the defined set.

## File Tool Encapsulation Policy (`**/*.tsk/`)

All general filesystem tools (read/write/list/move/delete) MUST treat any path under `**/*.tsk/` as **forbidden**.

- Reads MUST be rejected (even if the file exists).
- Writes MUST be rejected (including create/overwrite/append).
- Directory listings MUST NOT reveal contents of `.tsk/` (at most, they may reveal the directory name exists).

Rationale:

- Prevents accidental edits via generic file operations.
- Forces Taskdoc mutations through explicit, semantically meaningful actions (`change_mind`).
- Avoids prompt/control-flow footguns where an agent “helpfully” rewrites task constraints without clear intent.

The system prompt (and any tool documentation shown to agents) MUST explicitly state this restriction.

## UX Expectations (Design-Level)

- The WebUI SHOULD render the Taskdoc as three panes/tabs (Goals / Constraints / Progress) and optionally a combined view.
- The WebUI SHOULD make edits explicit: when a user changes one section, it must be clear which section is being replaced.
- The WebUI SHOULD show a short “last updated” indicator per section (time + actor) to support auditability.

## Compatibility Considerations

Dominds SHOULD standardize on `*.tsk/` Taskdoc packages as the **only** supported Taskdoc storage format.

If an rtws previously used single-file `.md` Taskdocs, they MUST be migrated to `*.tsk/` packages before running new dialogs.

## Security & Integrity Notes

- The `.tsk/` package is **high-integrity state**: it can materially change agent behavior and safety boundaries.
- Encapsulation reduces the chance of stealth edits (e.g., by a function tool call snippet embedded in copied text).
- Audit metadata (who/when) is strongly recommended for incident analysis and user trust.

## Open Questions

- Where should the Taskdoc package live by default (under dialog persistence, next to the initiating entrypoint, or a dedicated rtws dir)?
- Should `change_mind` allow explicitly setting an empty section body (for intentional clearing)?
