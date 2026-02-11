# Dominds Agent Priming: Guide the Agent to Show It to Itself

Chinese version: [中文版](./dominds-agent-priming.zh.md)

## Summary

Dominds has a real, runtime-enforced Tellask mechanism (`tellask* function call`) and a real, runtime-enforced Fresh Boots Reasoning
(FBR) mechanism (`freshBootsReasoning`). Even if system prompts explain these mechanisms in detail, most foundation models were not
trained in a world where “asking a teammate to run a shell command” is actually possible, so they often treat such text
as aspirational or hypothetical.

**Agent Priming** is a tiny, highly realistic “first impression” procedure executed at dialog creation time. It runs a
short, real Tellask + real return + real FBR + real distillation so the model gains _felt-sense_ that:

- teammate Tellasks are real and will be executed
- tool outputs are real and will be returned and persisted
- `freshBootsReasoning` FBR is real and will report back
- distillation is expected (extract the best, dedupe, reconcile), not “repeat each draft”

More precisely: it **guides the agent to show it to itself** — letting it personally walk through
(Tellask → return → FBR → distillation), moving from “I’ve heard this exists” to “I just used it”.

This is structurally related to the psychology notion of a **priming effect**: an early, concrete stimulus can
significantly shape subsequent expectations and behaviors. In Dominds we anchor this “priming” in **verifiable runtime
interactions**, instead of relying on longer, declarative system-prompt text.

As a consequence, we can **dramatically simplify system prompts**: keep only short, accurate statements of the
Tellask/FBR contracts, and rely on a real priming run to establish “this works here”.

Related docs:

- Tellask runtime: [`dialog-system.md`](./dialog-system.md)
- Terminology (Mainline/Sideline): [`dominds-terminology.md`](./dominds-terminology.md)
- FBR (`freshBootsReasoning`): [`fbr.md`](./fbr.md)
- Work language vs UI language: [`i18n.md`](./i18n.md)

---

## Goals

- Establish immediate trust that Tellask/return/persistence are real.
- Run a real `freshBootsReasoning` FBR loop at dialog creation.
- Build muscle memory for the timing contract: initiate FBR, wait for feedback, then synthesize/decide.
- Make distillation itself part of the “felt” experience (dedupe/reconcile/extract-the-best).
- Keep the procedure safe, small, and deterministic (default command: `uname -a`).
- Persist and display the interaction so it is credible from multiple angles (backend record + frontend transcript).

## Non-goals

- Running arbitrary user-provided commands as part of dialog creation.
- Collecting sensitive system information (beyond minimal OS/kernel identification).
- Replacing proper documentation: this is an experiential supplement, not the main spec.

---

## Definitions (user-facing)

- **Mainline dialog**: the primary thread where the user and the main agent interact.
- **Sideline dialog**: a temporary work thread created by Tellask / FBR, reporting results back to the mainline.
- **Tellask**: a structured request (`tellask({ targetAgentId: "<memberId>", sessionSlug: "<slug>", tellaskContent: "..." })`) from a tellasker to a tellaskee.
- **Shell specialist**: a teammate designated to run shell commands safely (configured via `shell_specialists`).
- **FBR**: Fresh Boots Reasoning, implemented as `freshBootsReasoning` (a tool-less sideline dialog). See [`fbr.md`](./fbr.md).

---

## Runtime flow (at dialog creation)

Agent Priming runs **before** the first user message is processed, unless the user opts out.

### 1) Choose the shell execution path

1. If the team config includes at least one `shell_specialists` member, pick one deterministically (e.g. the first).
2. Otherwise, let the **Dominds runtime** execute the baseline command directly (not via agent tools).

Baseline command:

- `uname -a`

If `uname -a` fails (e.g. non-POSIX host), the runtime may fall back to a platform-appropriate equivalent, but the
default “muscle memory” path is intentionally `uname -a` because it is common, low-risk, and quick.

### 2) Real teammate Tellask: ask for `uname -a`

If a shell specialist member exists, the main agent (tellasker) issues **a real Tellask** to the shell specialist member
(tellaskee), in the server-wide work language.

The Tellask body should be short and operational:

- run exactly `uname -a`
- return raw output verbatim
- if `uname` fails: include error + one safe alternative command

### 3) Real FBR: reflect on what the environment implies

After obtaining the environment snapshot, the main agent issues a real `freshBootsReasoning` Tellask to trigger FBR.

The FBR body should include:

- the exact `uname -a` output (explicitly name the command; it may change in the future)
- the tool constraint (FBR has no tools; mainline tool availability is separate)
- the question: “What should I be careful about in this environment? Which CLI tools should I prioritize, and why?”

Optional parallel drafts:

- If the team member config enables `fbr_effort` (default `3`), the runtime creates multiple `freshBootsReasoning` FBR sideline
  dialogs concurrently so the agent produces multiple independent “fresh boots” drafts for the mainline dialog to
  distill.
- These drafts have **no stable identity mapping**, and there is no meaningful ordering requirement; the mainline dialog
  should treat them as anonymous drafts rather than fixed personas.
- If `fbr_effort` is `0`, skip FBR.
- If `fbr_effort` is greater than `100`, the runtime errors out and stops priming (invalid config).

Phase boundary (critical):

- `freshBootsReasoning` is the **initiation action**, not completed decision-making.
- Mainline must enter a wait phase until feedback from that FBR run returns.
- If `fbr_effort = N`, mainline must wait for all N drafts before distillation; do not finalize from partial drafts.

### 4) Distill into an “Agent Priming” note

After confirming feedback from that FBR run has been collected, the main agent writes a short, user-visible **Agent Priming** note via a **normal generation** in the mainline
dialog. It should be explicitly distilled (dedupe/reconcile/extract-the-best) rather than repeating each draft.

Implementation constraint (matches runtime behavior):

- Do not introduce a separate system-prompt assembly path for distillation.
- The runtime may use a non-persisted **internal prompt** to anchor “this generation is distillation”.
- The runtime may also include the shell snapshot and FBR drafts as “evidence” inside that internal prompt (for this
  drive only, not persisted), so distillation does not depend on any queue timing/concurrency details.
- During the Agent Priming lifecycle (from prelude start until the priming note is produced), runtime must suppress
  diligence-push injections; restore normal diligence behavior only after priming completes.

Implementation note (internal prompt):

- The runtime may provide the driver with a non-persisted, non-rendered **internal prompt** (used only in the LLM
  context for this drive) to explicitly anchor the generation as “distillation”.
- The internal prompt must not be written into dialog history or persisted storage (to avoid transcript pollution
  across courses).
- The internal prompt is a per-drive task directive; it must not replace the system prompt or introduce a separate
  system-prompt assembly path.

Implementation note (avoid Taskdoc bias):

- Distillation must be Taskdoc-agnostic: the same Agent Priming prefix can be reused across dialogs with different
  Taskdocs.
- Therefore, the runtime may choose to **skip injecting Taskdoc** for the one distillation drive, so Taskdoc progress
  or implementation details do not bias environment conclusions.

---

## Persistence, caching, and reuse (in-process only)

### 1) Persist as real dialog records (backend + frontend)

All priming steps must be persisted as standard dialog artifacts (messages + events) and visible in the WebUI.

### 2) Process-wide cache (per agent)

To avoid repeating `uname -a` + FBR + distillation on every new dialog, the backend process may maintain an in-process cache
(lost on restart) keyed by the mainline agent id.

Reuse policy:

- If a valid cache entry exists, a new dialog may reuse the cached transcript and Agent Priming note.
- Reused entries should still be visible in the new dialog transcript, labeled as “reused from cache”.

### 2.5) Mainline choice must propagate to sideline dialogs

The priming choice selected at mainline dialog creation must propagate to all sideline dialogs under that root dialog.

Propagation semantics:

- Mainline chooses **Skip** (`skip`): all sideline dialogs must also **Skip** (`skip`).
- Mainline chooses **Do Again** (`do`) while cache exists: all sideline dialogs must also run fresh (`do`).
- Mainline chooses **Show it now** (`do`) when cache does not exist, or chooses **Reuse** (`reuse`):
  sideline dialogs use **reuse-or-do** (`reuse`): reuse cache when available for that sideline agent;
  otherwise run a fresh priming.

Notes:

- Different sideline agents may have different cache states; `reuse` is evaluated per sideline agent.
- Priming must not run invisibly in the background; it must be persisted and user-visible as standard dialog artifacts.

### 3) Carry across `clear_mind`

After each `clear_mind` (entering the next course), do not rely on reminders.

Instead, inject a small, stable **course prefix** into model context at the start of each course: a condensed transcript
(shell snapshot + FBR highlights + Priming note).

---

## UX requirements (WebUI)

### Display

- Render Agent Priming as a realistic transcript the user can inspect.
- Prefer a collapsible top section with clear labels:
  - “Teammate Tellask (shell)”
  - “FBR (`freshBootsReasoning`)"
  - “Agent Priming”

### Opt-out

Dialog creation should provide an explicit opt-out to skip priming.

Additional UX constraints:

- If the dialog owner is a hidden shadow member, the default priming preference should be **Skip**.
- Shadow-member priming preferences should be stored separately from visible-member preferences (they should not affect each other).

---

## Safety notes

- Default to a single, low-risk command (`uname -a`).
- Do not run anything that modifies the filesystem or network as part of priming.
- Treat the priming transcript as user-visible by default; avoid including secrets or personally identifying details.
