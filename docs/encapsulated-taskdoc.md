# Encapsulated Taskdocs (`*.tsk/`) (Design)

This document specifies a **structured, encapsulated Taskdoc format** for Dominds dialogs.

Instead of a single mutable “Taskdoc” markdown file, each dialog tree’s Taskdoc becomes a **Taskdoc package directory**
with a stable schema and a strict access policy.

## Goals

- **Clarity**: separate “what we want” (goals) from “what we must obey” (constraints) and “where we are” (progress).
- **Durability**: make task state persist across long-running work and across dialog round resets.
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
- **Encapsulation**: treating `.tsk/` as protected internal state, not general workspace files.

## Taskdoc Package Structure

A Taskdoc package is a directory with the suffix `.tsk/` (e.g. `my-task.tsk/`), containing:

- `goals.md` (required)
- `constraints.md` (required)
- `progress.md` (required)
- (optional) additional **app-specific** files (read-only to general file tools)

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
- SHOULD avoid duplicating full conversation history; keep it distilled and actionable.

### Additional files (app-specific)

The runtime MAY store additional files inside the Taskdoc package for internal needs (examples:
`snapshots/`, `attachments-index.md`).

Design constraints:

- These files MUST NOT be treated as normal workspace files.
- They MUST NOT be editable via normal file tools.
- If any are user-visible, they MUST be surfaced via explicit UI affordances rather than raw file reads.

## Effective Taskdoc (for agent context)

Dominds MUST construct an **effective Taskdoc** from the Taskdoc package for use in prompts and UI display.

Normative structure (v1):

1. A stable heading indicating this is the Taskdoc for the dialog tree
2. `## Goals` followed by the content of `goals.md`
3. `## Constraints` followed by the content of `constraints.md`
4. `## Progress` followed by the content of `progress.md`

Notes:

- The effective Taskdoc MUST be deterministic (no hidden reformatting beyond the above framing).
- Empty sections are allowed but the files still exist.

## `change_mind` Semantics (No Round Reset)

The function tool `change_mind` updates **exactly one** section file of the Taskdoc package by **replacing its entire contents**.

Critically:

- `change_mind` **MUST NOT** start a new dialog round.
- If a round reset is desired, call the function tool `clear_mind({ "reminder_content": "<re-entry package>" })` (or other round-control mechanisms) separately.
  - Recommendation: include a short, scannable re-entry package so the agent can resume after the new round.

### Arguments (v2)

`change_mind` takes a required target selector:

- `goals`
- `constraints`
- `progress`

Example:

```text
Call the function tool `change_mind` with:
{ "selector": "constraints", "content": "- MUST not browse the web.\n- MUST keep responses under 10 lines unless asked otherwise.\n" }
```

### Behavioral rules

- The target selector MUST be one of the supported literals; anything else is an error.
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

If a workspace previously used single-file `.md` Taskdocs, they MUST be migrated to `*.tsk/` packages before running new dialogs.

## Security & Integrity Notes

- The `.tsk/` package is **high-integrity state**: it can materially change agent behavior and safety boundaries.
- Encapsulation reduces the chance of stealth edits (e.g., by a tool call embedded in copied text).
- Audit metadata (who/when) is strongly recommended for incident analysis and user trust.

## Open Questions

- Where should the Taskdoc package live by default (under dialog persistence, next to the initiating entrypoint, or a dedicated workspace dir)?
- Should `change_mind` allow explicitly setting an empty section body (for intentional clearing)?
- Do we need a first-class “view task section” command/tool for text-only clients, given file tools cannot read `.tsk/`?
