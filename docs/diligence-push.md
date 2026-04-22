# Diligence Push — Design Doc

Chinese version: [中文版](./diligence-push.zh.md)

## Summary

Dominds main dialogs are intended for long-run operation. A main dialog "stopping" (becoming idle)
is often not what operators want: they want the agent to keep pushing forward until it either:

- legitimately suspends for a human decision (Q4H), or
- legitimately suspends waiting for Side Dialogs (tellask/backfill).

This document specifies a runtime mechanism ("diligence-push") that, for **main dialogs only**,
prevents the dialog from stopping: whenever the driver would otherwise stop, it auto-sends a short
diligence prompt (rendered as a normal user bubble) and continues generation, except when the dialog
is legitimately suspended (Q4H or pending Side Dialogs).

## Goals

- Prevent main dialogs from stopping except for legitimate suspension states (Q4H / Side Dialogs).
- Keep behavior predictable and bounded (no infinite loops).
- Make the Diligence Push text configurable per rtws (runtime workspace) and language.
- Provide a clear, user-controlled "disable" mechanism.

## Non-goals

- Auto-completing / auto-marking a dialog as done.
- Applying this behavior to Side Dialogs (Side Dialogs remain scoped and should report back to their requester).

## Definitions

- **Main Dialog**: a `MainDialog` (`dlg.id.rootId === dlg.id.selfId`), the primary conversation thread.
- **SideDialog**: a `SideDialog`, created for tellask / scoped work.
- **Q4H**: "Questions for Human", initiated via `askHuman()`, which suspends dialog progression until the human responds.

## Expected "normal" completion path (recommended)

When the agent needs a human decision to conclude (e.g., confirm a choice or decide whether to mark the dialog done), the correct path is:

1. The agent issues a Q4H (`askHuman()`) with the necessary context and explicit decision request.
2. The WebUI surfaces the Q4H clearly.
3. The human decides and either:
   - marks the main dialog "done" manually, or
   - provides the requested info so the dialog can proceed.

This is the "controlled convergence" path. The diligence-push mechanism should **not** override legitimate suspension states.

## Diligence Push behavior ("auto-continue" fallback)

### Trigger conditions (must all hold)

- Dialog is the **Main Dialog** (never for Side Dialogs).
- Dialog is **not suspended**:
  - no pending Q4H, and
  - no pending Side Dialogs (waiting for backfill).
- The driver would otherwise stop the generation loop (i.e., no tool/function outputs require another iteration).

### Exception: provider deadlock recovery

Some provider/API quirk handlers may request a one-time Diligence Push recovery after Dominds stops
same-context retries for a known deadlock pattern. This is not the ordinary "dialog is about to go
idle" path. In that recovery-only case, pending sideDialogs do not veto the single Diligence Push
injection, because the deadlock may happen in a function-result-driven generation round right after
the main dialog has already registered an in-flight tellask/sideDialog. Q4H remains a hard blocker.

### Action

The runtime auto-sends a diligence prompt (rendered as a normal user bubble) and runs another
generation iteration.

### Boundedness

To avoid infinite loops, diligence-push has a per-dialog budget (per-member `diligence-push-max`) that controls
how many auto-continued diligence prompts can be injected for a given dialog before the runtime stops
issuing further automatic Diligence Pushes for that budget.

- Default: **3**
- If `< 1`, diligence-push is effectively disabled for that member
- Configurable per-member via `diligence-push-max` in `.minds/team.yaml`

### Reset on Q4H

When a dialog becomes suspended due to a pending Q4H (Questions for Human), the diligence-push injection
counter is reset. This ensures that after the human answers the Q4H and the dialog is resumed, the
dialog gets a fresh diligence-push budget again.

### Budget exhausted → stop auto-pushing for that budget

When the diligence-push budget is exhausted, the runtime emits an informational UI notice and stops
issuing further automatic Diligence Pushes for that budget. It does not create a Q4H by itself.

### Disable switch

Diligence-push can be disabled per-rtws in either of these ways:

- If the selected diligence file exists but its content is empty/whitespace, diligence-push is disabled (no injection).

Diligence-push can be disabled per-member in either of these ways:

- If `diligence-push-max < 1`, diligence-push is disabled for that member (no injection).

## Diligence prompt resolution

Let `<rtws>` be the current runtime workspace (i.e., `process.cwd()`).

Resolution order:

1. `<rtws>/.minds/diligence.<work-lang-id>.md` (e.g., `diligence.zh.md`)
2. `<rtws>/.minds/diligence.md` (language-agnostic fallback)
3. Built-in fallback text (hardcoded i18n; `zh` is canonical and embedded in source)

If the first existing file in the above order has empty/whitespace content, **disable** diligence-push.

Note: YAML frontmatter in diligence files is **ignored** by the runtime. If present, it is treated as
non-content metadata and stripped from the prompt body.

### Team member cap: `diligence-push-max`

Each team member can optionally cap diligence-push via `.minds/team.yaml`:

```yaml
members:
  alice:
    diligence-push-max: 10
```

Rules:

- If missing, `diligence-push-max` defaults to **3** for that member.
- If `diligence-push-max < 1`, diligence-push is disabled for that member (no injection), even if the diligence file exists.
- Built-in shadow members `fuxi` and `pangu` default to `diligence-push-max: 0` unless explicitly overridden in team.yaml.

## UX notes

- Diligence-push is a runtime-only Diligence Push, but it should be **visible**: the diligence prompt is rendered
  as a normal user message bubble (auto-sent by the runtime) so operators can understand why an
  extra iteration occurred.
- Users should observe that the agent continues with a brief follow-up after tool-only operations.
- When the agent truly needs user intervention, it should use Q4H. Diligence-push should not try to "fake" completion.

## Implementation (backend)

### Where

Implemented in the kernel driver loop (`dominds/main/llm/kernel-driver/drive.ts`) as a small
post-iteration check:

1. If the dialog is suspended, stop (Q4H / sideDialog pending), except for the deadlock-recovery
   special case described above where one recovery-only Diligence Push may ignore pending
   sideDialogs.
2. If there is any tool feedback, continue normally.
3. Otherwise (root only), attempt diligence-push auto-continue:
   - If disabled → stop normally.
   - If budget exhausted → emit an informational UI notice and stop further automatic Diligence
     Pushes for the current budget.
   - Else → auto-send diligence prompt and continue.

### Message type

We inject the diligence prompt as an auto-sent user message:

- `ChatMessage` of type `prompting_msg` with `role: 'user'`

This ensures:

- It is present in the model context
- It is persisted as a human message record
- It renders in the chat timeline as a normal user bubble (like any other user message)

## Observability

Recommended follow-ups (not required for initial implementation):

- Add a structured log line when diligence-push is triggered, including:
  - dialog id
  - language
  - which diligence source was used (lang-specific / generic / built-in / disabled)
- Optional metrics counter for "diligence-push triggered" and "diligence-push disabled by empty file".

## Testing

Regression tests should cover:

- Main dialog: tool-only output → diligence injection → continued response
- Main dialog: empty assistant output → diligence injection → continued response
- SideDialog: no diligence injection
- rtws config:
  - `.minds/diligence.md` is honored when lang-specific file is absent
  - empty diligence file disables diligence-push
