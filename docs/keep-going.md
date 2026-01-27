# Keep-Going (Diligence Auto-Continue) — Design Doc

## Summary

Dominds root dialogs are intended for long-run operation. A root dialog “stopping” (becoming idle)
is often not what operators want: they want the agent to keep pushing forward until it either:

- legitimately suspends for a human decision (Q4H), or
- legitimately suspends waiting for subdialogs (tellask/backfill).

This document specifies a runtime mechanism (“keep-going”) that, for **root/main dialogs only**,
prevents the dialog from stopping: whenever the driver would otherwise stop, it auto-sends a short
diligence prompt (rendered as a normal user bubble) and continues generation, except when the dialog
is legitimately suspended (Q4H or pending subdialogs).

## Goals

- Prevent root dialogs from stopping except for legitimate suspension states (Q4H / subdialogs).
- Keep behavior predictable and bounded (no infinite loops).
- Make the nudge text configurable per workspace (rtws) and language.
- Provide a clear, user-controlled “disable” mechanism.

## Non-goals

- Auto-completing / auto-marking a dialog as done.
- Applying this behavior to subdialogs (subdialogs remain scoped and should report back to their caller).

## Definitions

- **Root/main dialog**: a `RootDialog` (`dlg.id.rootId === dlg.id.selfId`), the primary conversation thread.
- **Subdialog**: a `SubDialog`, created for tellask / scoped work.
- **Q4H**: “Questions for Human”, initiated via `!?@human`, which suspends dialog progression until the human responds.

## Expected “normal” completion path (recommended)

When the agent needs a human decision to conclude (e.g., confirm a choice or decide whether to mark the dialog done), the correct path is:

1. The agent issues a Q4H (`!?@human`) with the necessary context and explicit decision request.
2. The WebUI surfaces the Q4H clearly.
3. The human decides and either:
   - marks the root dialog “done” manually, or
   - provides the requested info so the dialog can proceed.

This is the “controlled convergence” path. The keep-going mechanism should **not** override legitimate suspension states.

## Keep-going behavior (“auto-continue” fallback)

### Trigger conditions (must all hold)

- Dialog is the **root/main dialog** (never for subdialogs).
- Dialog is **not suspended**:
  - no pending Q4H, and
  - no pending subdialogs (waiting for backfill).
- The driver would otherwise stop the generation loop (i.e., no tool/function outputs require another iteration).

### Action

The runtime auto-sends a diligence prompt (rendered as a normal user bubble) and runs another
generation iteration.

### Boundedness

To avoid infinite loops, keep-going has a per-dialog budget (per-member `diligence-push-max`) that controls
how many auto-continued diligence prompts can be injected for a given dialog before the runtime forces a
Q4H suspension.

- Default: **3**
- If `< 1`, keep-going is effectively disabled for that member
- Configurable per-member via `diligence-push-max` in `.minds/team.yaml`

### Reset on Q4H

When a dialog becomes suspended due to a pending Q4H (Questions for Human), the keep-going injection
counter is reset. This ensures that after the human answers the Q4H and the dialog is resumed, the
dialog gets a fresh keep-going budget again.

### Budget exhausted → force Q4H

When the keep-going budget is exhausted, the runtime creates a Q4H entry that asks the human whether
to continue or stop. This converts “boundedness” into a legitimate suspension point and avoids
infinite auto-continue loops.

### Disable switch

Keep-going can be disabled per-rtws in either of these ways:

- If the selected diligence file exists but its content is empty/whitespace, keep-going is disabled (no injection).

Keep-going can be disabled per-member in either of these ways:

- If `diligence-push-max < 1`, keep-going is disabled for that member (no injection).

## Diligence prompt resolution

Let `<rtws>` be the current runtime workspace (i.e., `process.cwd()`).

Resolution order:

1. `<rtws>/.minds/diligence.<work-lang-id>.md` (e.g., `diligence.zh.md`)
2. `<rtws>/.minds/diligence.md` (language-agnostic fallback)
3. Built-in fallback text (hardcoded i18n; `zh` is canonical and embedded in source)

If the first existing file in the above order has empty/whitespace content, **disable** keep-going.

Note: YAML frontmatter in diligence files is **ignored** by the runtime. If present, it is treated as
non-content metadata and stripped from the prompt body.

### Team member cap: `diligence-push-max`

Each team member can optionally cap keep-going via `.minds/team.yaml`:

```yaml
members:
  alice:
    diligence-push-max: 10
```

Rules:

- If missing, `diligence-push-max` defaults to **3** for that member.
- If `diligence-push-max < 1`, keep-going is disabled for that member (no injection), even if the diligence file exists.
- Built-in shadow members `fuxi` and `pangu` default to `diligence-push-max: 0` unless explicitly overridden in team.yaml.

## UX notes

- Keep-going is a runtime-only nudge, but it should be **visible**: the diligence prompt is rendered
  as a normal user message bubble (auto-sent by the runtime) so operators can understand why an
  extra iteration occurred.
- Users should observe that the agent continues with a brief follow-up after tool-only operations.
- When the agent truly needs user intervention, it should use Q4H. Keep-going should not try to “fake” completion.

## Implementation (backend)

### Where

Implemented in the LLM driver loop (`dominds/main/llm/driver.ts`) as a small post-iteration check:

1. If `suspendForHuman` is true, stop (Q4H / subdialog pending).
2. If there is any tool feedback, continue normally.
3. Otherwise (root only), attempt keep-going auto-continue:
   - If disabled → stop normally.
   - If budget exhausted → create Q4H and stop.
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

- Add a structured log line when keep-going is triggered, including:
  - dialog id
  - language
  - which diligence source was used (lang-specific / generic / built-in / disabled)
- Optional metrics counter for “keep-going triggered” and “keep-going disabled by empty file”.

## Testing

Regression tests should cover:

- Root dialog: tool-only output → diligence injection → continued response
- Root dialog: empty assistant output → diligence injection → continued response
- Subdialog: no diligence injection
- Workspace config:
  - `.minds/diligence.md` is honored when lang-specific file is absent
  - empty diligence file disables keep-going
