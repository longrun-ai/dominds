# Interruption & Resumption (Dialog Proceeding Control)

Dominds dialogs (“dlgs”) can run for a long time (streaming generation, multi-step work, tool usage). Users also
frequently observe the same dlg from multiple browser tabs. This document defines the **interaction design** for:

- Surfacing whether each dlg is **idle** vs **proceeding**
- Allowing a user to **interrupt** proceeding work (“Stop”)
- Allowing a user (or operator) to **resume** eligible dlgs (“Continue” / “Resume all”)

This is a design doc only (no implementation details).

---

## Goals

- **Immediate control:** If a dlg is proceeding, the user can stop it quickly from the dlg view.
- **Operator safety:** A global “emergency stop” can halt all proceeding dlgs backend-wide.
- **Crash recovery:** After a backend crash/restart, dlgs that were proceeding are surfaced as resumable (when safe).
- **Multi-client consistency:** All connected observers converge on the same state (one tab stopping/resuming is visible to others).
- **Clarity and trust:** The UI makes it obvious _why_ a dlg stopped and _what_ “continue” will do.

## Non-goals (for this doc)

- Cancelling or rolling back real-world side effects (this doc only defines _control_ and _state visibility_).
- Designing a full retry/compensation system for external actions.
- Redesigning the dialog data model or persistence format.

---

## Terms

- **dlg (dialog):** A single conversation/work thread.
- **Proceeding:** The backend is actively driving the dlg (generating output and/or performing steps) without waiting for user input.
- **Idle:** The dlg is not proceeding; it is either waiting for user input or in a stable finished/paused state.
- **Interrupted:** Proceeding stopped before reaching a stable “waiting for user” point.
- **Resumption:** Restarting the backend drive of an interrupted dlg so it can reach a stable outcome (typically producing/finishing the pending assistant turn).

---

## Core UX Surface Areas

### 1) Per-dlg primary control: `Send ↔ Stop`

When the currently viewed dlg is **proceeding**:

- The primary action in the input area changes from **Send** to **Stop**.
- Pressing **Stop** requests interruption of that dlg’s current proceeding.
- After Stop is requested, the UI should reflect **Stopping…** (until the backend reports the dlg is no longer proceeding).

When the dlg is **idle**:

- The primary action is **Send** (normal messaging).

Design intent: “Stop” is the fastest, most discoverable control and must be available without hunting in menus.

### 2) Global operator controls: `Emergency stop` and `Resume all`

The WebUI provides global controls (typically in a header/toolbar) that act across all dlgs:

- Placement: Put **Emergency stop** and **Resume all** in the top header, immediately to the left of the connection status indicator, so they remain visible regardless of which dlg is open.
- **Emergency stop:** Requests interruption of _all_ proceeding dlgs backend-wide.
  - Intended for runaway output, resource protection, or operator intervention.
  - Should be visually distinct from per-dlg Stop (more “danger” affordance).
- **Resume all:** Requests resumption of _all eligible_ dlgs (details below).
  - Intended for recovery after backend crash/restart or a deliberate global stop.

Both controls must show “what they will affect” at a glance (e.g., a count of proceeding / eligible dlgs) and should avoid surprising
the user/operator.

### 3) In-history continuation affordance: `Continue`

At the end of the dialog history, show a **Continue** button when the dlg is eligible for resumption.

- Continue is **dlg-scoped** (only affects the current dlg).
- Continue should be paired with a short reason label, e.g.:
  - “Stopped by you”
  - “Stopped by emergency stop”
  - “Interrupted by server restart”

If the dlg is not eligible, the UI should _not_ show Continue, and may show a brief, non-intrusive explanation (e.g., “Waiting for your input”).

---

## What the Backend Must Communicate (Design Contract)

To support the UX above, the backend must expose for each dlg:

- Whether it is currently **proceeding**
- If not proceeding, whether it is **idle-waiting-user** vs **interrupted** vs **blocked**
- If interrupted, an **interruption reason** suitable for user display

The key design requirement: a client should not need to infer proceeding/idle from timing or UI heuristics. Proceeding state is a first-class concept.

---

## Dialog Run State Model (Conceptual)

Each dlg is always in exactly one of these user-relevant run states:

1. **Idle (waiting for user)**
   - User can Send.
   - Not eligible for resumption (there is nothing in progress to continue).

2. **Proceeding**
   - Primary control becomes Stop.
   - Not eligible for resumption (because it is already running).

3. **Interrupted (resumable)**
   - Proceeding has stopped mid-run.
   - Continue may be offered (if eligible).

4. **Blocked (needs user action)**
   - The dlg is not proceeding, but cannot continue without a specific user action (e.g., answering a pending question).
   - Continue is not offered; instead the UI should guide the required action.

5. **Terminal (finished or unrecoverable)**
   - The dlg reached a stable end state where “continue” is not meaningful (e.g., completed) or requires manual intervention outside the resume mechanism.

This model is intentionally minimal: it matches what the user needs to decide “send / stop / continue / act”.

---

## Interruption Semantics (User Expectations)

### What “Stop” means

- Stop is a **best-effort interruption request**: the dlg should stop proceeding as soon as practical.
- After Stop, the dlg must transition to a non-proceeding state and clearly record _why_ it stopped.
- The UI should treat Stop as a **pause**, not as a destructive cancel (resumption is expected unless ineligible).

### What “Emergency stop” means

- Same semantics as Stop, but applied to all proceeding dlgs.
- Emergency stop should never silently affect idle dlgs beyond UI state labeling.

### What “Continue / Resume” means

- Resume means “attempt to complete the in-progress work that was interrupted” and return the dlg to a stable state.
- Resume should be **idempotent from the user’s perspective**: repeated clicks should not create confusing parallel runs.
- If resumption could repeat external side effects, the UI must not pretend it is risk-free; it should surface uncertainty and prefer requiring explicit user confirmation.

---

## Eligibility for Resumption (Expanded)

A dlg is **eligible for resumption** when all of the following are true:

1. **Not currently proceeding**
   - If it is proceeding, it is already running; Stop is the relevant action.

2. **Has an interrupted in-progress run**
   - The most recent run ended due to interruption rather than cleanly reaching “waiting for user”.
   - Typical interruption reasons that can be eligible:
     - Manual Stop (per-dlg)
     - Emergency stop (global)
     - Backend crash/restart while proceeding
     - Resource protection stop (operator/system)

3. **No required user input is pending**
   - If the dlg is blocked waiting for a user response to a question, it is **not** eligible.
   - The appropriate action is the required user input, not Continue.

4. **Resumption target is well-defined**
   - The system can identify what it is trying to finish (e.g., completing the pending assistant turn or completing the interrupted step).
   - If the system cannot define a safe/clear resumption target, the dlg is not eligible (or Continue must become a guided “resolve first” flow).

5. **Safe to attempt without surprising the user**
   - If there is a reasonable risk that resumption will repeat externally visible side effects, the UI must require an explicit confirmation step (or mark the dlg ineligible until the user resolves the ambiguity).

### Common ineligible cases

- The dlg is **idle waiting for user** (normal state).
- The dlg is **blocked** (requires user action, like answering a pending question).
- The dlg is in a **terminal** state (finished or unrecoverable without manual intervention).
- The dlg state is **unknown/stale** (e.g., disconnected client with no authoritative backend state yet); Continue should not appear until the state is known.

---

## Multi-Client Behavior (Multiple Tabs / Observers)

- Proceeding/idle/interrupted state must be treated as **dlg-global**, not “per tab”.
- If any client stops or resumes a dlg, all other observing clients should update promptly:
  - Send ↔ Stop toggles consistently
  - Continue appears/disappears consistently
  - Reason labels remain consistent

Design intent: users should never see two tabs disagreeing about whether a dlg is running.

---

## UI Feedback and Transparency

To reduce confusion and build trust:

- The dialog history should include lightweight “system markers” when meaningful transitions occur:
  - “Stopped by you” / “Stopped by emergency stop” / “Interrupted by server restart”
  - “Resumed”
- The dialog list/sidebar should optionally show compact badges:
  - “Proceeding”
  - “Interrupted”
  - “Needs input”

These cues make global controls (“resume all”) safer because users can see what’s going on without opening every dlg.
