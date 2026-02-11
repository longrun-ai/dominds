# Q4H (Questions for Human) — Design Doc

Chinese version: [中文版](./q4h.zh.md)

## Summary

Q4H is Dominds’s mechanism for raising a human decision/clarification request from any dialog by issuing a Tellask to
`askHuman()` (`!?askHuman() ...`). When a dialog enters Q4H, progression is suspended until the human responds.

This document specifies a WebUI enhancement:

1. **External deep links** that jump directly to a Q4H question’s call site (the place in the conversation where
   `!?askHuman()` was issued), and optionally **pre-select** the pending question so the input enters “answer mode”.
2. A consistent **call site action UI**: internal navigation (same tab) vs external navigation (new tab/window).

## Goals

- Let a human open a URL that:
  - navigates to the originating dialog and course,
  - scrolls to (and highlights) the Q4H call site,
  - focuses the input and (when possible) selects the pending question so the next send becomes an answer.
- Provide a compact, discoverable UI affordance for “go to call site” with:
  - **Internal** navigation (same tab), and
  - **External** navigation (new browser tab/window).
- Keep the implementation compatible with existing persisted Q4H state (`q4h.yaml`).

## Non-goals

- A stable, shareable permission model for deep links (auth is handled separately; see `docs/auth.md`).
- Creating a new routing framework; the WebUI remains a simple SPA without client-side routing libraries.
- Reworking Q4H semantics or the suspension/resumption rules (this doc only covers navigation + UX).

## Definitions (user-facing terms)

- **Mainline dialog / sideline dialog**: user-facing terms for the primary thread and temporary work threads.
- **Call site**: the location in the conversation where a Tellask was issued (for Q4H: where `!?askHuman()` appears).
- **Answer mode**: the input is bound to a specific pending Q4H question so `Send` becomes “answer this question”.

## UX / Product Requirements

### A. Internal navigation (same tab)

From the Q4H list (bottom panel) or other call-site affordances:

- Switch the current conversation view to the originating dialog (if different).
- Navigate to the correct course.
- Scroll to the call site and highlight it briefly.
- Focus the input.
- If the Q4H question is still pending, select it so the input is in answer mode.

### B. External navigation (new tab/window)

From a dedicated “external” icon button:

- Open a new browser tab/window using a deep link URL.
- The newly opened WebUI should land at the question call site and be ready for answering.

### C. Bubble header call-site actions

When a message bubble has a meaningful call site reference (e.g. “response ↔ call site” navigation), the UI should:

- Place the actions near the bubble title, aligned to the right.
- Render two icon buttons:
  - **Internal link**: navigate inside the current WebUI tab (switch dialog if needed + scroll).
  - **External link**: open a deep link in a new tab/window.

## Deep Link Contract (WebUI)

### Query parameter schema

The WebUI recognizes `window.location.search` deep link parameters.

Common parameters:

- `dl`: deep link kind (`q4h` | `callsite`)

#### `dl=q4h` (Q4H question deep link)

Required:

- `qid`: Q4H question id (`q4h-...`)

Recommended (optional but improves resilience / reduces dependency on global Q4H state arrival timing):

- `rootId`: root dialog id
- `selfId`: originating dialog id (root or sideline)
- `course`: course number (1-based)
- `msg`: message index (best-effort fallback locator)
- `callId`: tellask callId when the Q4H was created from an `!?askHuman()` tellask block

Behavior:

- The WebUI navigates to the originating dialog + course and scrolls to the call site.
- If the Q4H is still pending, the input selects `qid` (answer mode) and focuses the textarea.
- If the Q4H is not pending (already answered/cleared), the WebUI still scrolls to the call site but does **not**
  enter answer mode (no selection); it may show a toast indicating the question is no longer pending.

#### `dl=callsite` (generic tellask call site deep link)

Required:

- `rootId`
- `selfId`
- `course`
- `callId`

Behavior:

- The WebUI navigates to the dialog + course and scrolls to the calling section with `data-call-id=callId`.
- The input is focused (normal message mode).

#### `dl=genseq` (generation bubble deep link)

Required:

- `rootId`
- `selfId`
- `course`
- `genseq`

Behavior:

- The WebUI navigates to the dialog + course and scrolls to the generation bubble with `data-seq=genseq`.
- The bubble is highlighted briefly for visual confirmation.

### URL examples

```text
/?dl=q4h&qid=q4h-abc123&rootId=R1&selfId=S2&course=3&callId=call-xyz&msg=12

/?dl=callsite&rootId=R1&selfId=R1&course=1&callId=call-xyz
```

Notes:

- If auth via URL is used (`?auth=...`), deep link parameters simply co-exist in the query string.
- If auth is from localStorage, URLs should usually omit `auth` to avoid accidental sharing of secrets.

## Data Model / Persistence

### `q4h.yaml` per dialog

Existing persisted question shape includes:

- `id`, `mentionList`, `tellaskContent`, `askedAt`
- `callSiteRef: { course, messageIndex }`

Enhancement:

- Add optional `callId?: string` to Q4H questions created from an `!?askHuman()` tellask block.
  - This enables precise call-site scrolling via `data-call-id` in the rendered DOM.
  - Questions created by system mechanisms that are not emitted from a tellask block MAY have no `callId`.

Back-compat:

- Old `q4h.yaml` without `callId` remains valid.

## Frontend Implementation Notes

- `dominds-q4h-panel`:
  - Keeps internal navigation (same tab).
  - Adds an external icon action that opens a deep link (`dl=q4h`) in a new tab/window.
- `dominds-app`:
  - Parses deep link parameters once at startup and stores a pending deep link intent.
  - Applies the intent after dialogs and (when needed) Q4H state are available.
  - Uses existing `navigateToQ4HCallSite(...)` for in-app navigation, and extends dialog-container scrolling support.
- `dominds-dialog-container`:
  - Implements event-driven scrolling for:
    - `scroll-to-call-site` (course + messageIndex/callId),
    - `scroll-to-call-id` (course + callId).
  - Provides bubble-title call-site actions with internal/external icon buttons.

## Edge Cases

- Deep link targets a dialog that is not present in the current dialog list (deleted or not loaded):
  - Show a toast; do not crash.
- Deep link targets a question that is no longer pending:
  - Still navigate + scroll; do not select the question for answering.
- Course replay timing:
  - Scrolling may be requested before the call site exists in the DOM; the dialog container should retry briefly.

## Testing Checklist

- Q4H panel:
  - “Go to call site” scrolls and highlights the call site.
  - External action opens a new tab and lands at the same call site.
- Deep link:
  - With pending Q4H: auto-selects the question and focuses input (answer mode).
  - With answered Q4H: scrolls but does not select; input remains usable.
- Teammate response bubbles:
  - Internal icon scrolls to call site in current tab.
  - External icon opens new tab and scrolls to the same call site.
