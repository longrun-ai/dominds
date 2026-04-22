# Agent Priming (Startup Scripts) Design

Chinese version: [中文](./agent-priming.zh.md)

## Goal

Priming is unified as an editable, versionable, replayable Markdown startup-script mechanism.

- Script-as-history: startup scripts are preloaded dialog history.
- Faithful replay: scripts preserve and replay technical details (including tool records and `callId` links).
- Explicit selection: users choose scripts at dialog creation time.
- Visibility control: script-origin bubbles can be shown or hidden in UI.

## Semantic Boundary

`priming` is currently not a full dialog checkpoint. It is a combination of dialog history plus a
reminder snapshot.

- Preserved:
  - transcript / tool / tellask history records
  - current reminder snapshot
- Explicitly dropped:
  - pending sideDialogs
  - questions4human
  - sideDialog registry / sideDialog responses
  - other runtime-only waiting / blocking / orchestration state

This is an intentional semantic downgrade relative to a full runtime snapshot: a new dialog inherits
history and reminders, but it does not inherit in-flight workflow state.

## Storage Layout

All scripts live under `.minds/priming/` in rtws:

- Individual: `.minds/priming/individual/<team-member-id>/<slug>.md`
- Team shared: `.minds/priming/team_shared/<slug>.md`

Constraints:

- `slug` uses `[A-Za-z0-9._-]` path segments and may be nested.
- Path escape is forbidden (absolute path, `..`, NUL, illegal chars).
- Canonical refs:
  - `individual/<team-member-id>/<slug>`
  - `team_shared/<slug>`

## Script Format (Strict)

Each file uses `frontmatter + record blocks`.

### Top-level frontmatter (optional)

```yaml
---
kind: agent_priming_script
version: 3
title: Environment Probe Startup
applicableMemberIds:
  - ux
reminders:
  - content: Record the key result of each environment probe
    meta:
      source: priming
      sticky: true
    echoback: false
---
```

`reminders` is an optional top-level snapshot field and may be edited manually. Each reminder item
supports:

- `content`: required reminder text
- `ownerName`: optional registered ReminderOwner name; replay fails loudly if it is unknown
- `meta`: optional JSON-compatible data
- `echoback`: optional numbering/echo-back flag
- `createdAt`: optional timestamp string
- `priority`: optional `high | medium | low`

### Record blocks (required)

Each section must be `### record <record-type>`.

Strict rules:

- No legacy format: `### user` / `### assistant` is no longer supported.
- `func_call_record`: use triple-backtick `json` with a full JSON object.
- All other record types: use markdown blocks; six backticks (``````markdown) are recommended to avoid collisions with inner triple-backtick content.
- For non-`func_call_record` blocks, block frontmatter stores metadata and the markdown body maps to the record’s main text field (`content` / `response` / `result`).

Example:

````markdown
### record human_text_record

```markdown
---
genseq: 1
msgId: priming-1
grammar: markdown
---

Run an environment probe first.
```
````

### record func_call_record

```json
{
  "type": "func_call_record",
  "genseq": 1,
  "id": "call_probe_1",
  "name": "exec_command",
  "arguments": {
    "cmd": "uname -a"
  }
}
```

### record func_result_record

```markdown
---
genseq: 1
id: call_probe_1
name: exec_command
---

Darwin ...
```

```

## About `~~~markdown`

`~~~markdown` originally helped avoid fence collisions when content already included triple-backtick blocks.

Now the canonical export is six-backtick markdown blocks for non-`func_call_record`, and triple-backtick JSON for `func_call_record`. The parser still accepts `~~~` and varying backtick fence lengths.

## Create Dialog Flow (WebUI)

Priming area in create-dialog modal:

- Dropdown: recent scripts (backend-managed per agent, max 20).
- `<None> startup script`: no priming injection.
- `More…`: live backend disk scan on query; selecting a result writes it back to dropdown and selects it.
- `UI display` checkbox: controls whether priming-origin bubbles are rendered.

Request contract:

- `create_dialog` may include `priming`:
  - `scriptRefs: string[]` (UI currently single-select: 0 or 1 item)
  - `showInUi: boolean`

Runtime behavior:

- On root dialog creation, selected scripts are replayed into `course-1`.
- If top-level frontmatter contains `reminders`, the current reminder snapshot is restored first.
- Replayed events are tagged with `sourceTag: priming_script`.
- Replay is injected into `dialog.msgs` for downstream model context.
- `showInUi=false` only affects rendering; persistence/context remain unchanged.
- `pending/q4h/sideDialog-*` runtime state is not restored.

## Save Startup Script (WebUI)

- Toolbar uses an icon save button.
- Prompt shows concrete path:
  `.minds/priming/individual/<current-agent-id>/<slug>.md`
- Existing target requires explicit overwrite confirmation.

Export rules:

- Export full course record history.
- Export the current reminder snapshot into top-level frontmatter.
- Empty course export is rejected.
- Frontmatter stores source dialog metadata (`rootId/selfId/course/status`).
- `pending/q4h/sideDialog-*` runtime state is not exported; this is an explicit semantic downgrade in
  the current priming design.

## Recent Usage Storage

- Backend per-agent file:
  `<rtws>/.dialogs/recent-priming/<agent-id>.json`
- Max 20 entries (trimmed on write).
- Recent dropdown is fetched from backend each time.
- Usage is recorded only when dialog creation succeeds.
```
