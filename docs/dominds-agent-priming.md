# Dominds Agent Priming: Guide the Agent to Show It to Itself

Chinese version: [中文版](./dominds-agent-priming.zh.md)

## Summary

Dominds has a real, runtime-enforced Tellask mechanism (`!?@...`) and a real, runtime-enforced Fresh Boots Reasoning
(FBR) mechanism (`!?@self`). Even if system prompts explain these mechanisms in detail, most foundation models were not
trained in a world where “asking a teammate to run a shell command” is actually possible, so they often treat such text
as aspirational or hypothetical.

**Agent Priming** is a tiny, highly realistic “first impression” procedure executed at dialog creation time. It runs a
short, real Tellask + real return + real FBR + real synthesis so the model gains _felt-sense_ that:

- teammate Tellasks are real and will be executed
- tool outputs are real and will be returned and persisted
- `!?@self` FBR is real and will report back
- synthesis is expected (extract the best, dedupe, reconcile), not “repeat each draft”

More precisely: it **guides the agent to show it to itself** — letting it personally walk through
(Tellask → return → FBR → synthesis), moving from “I’ve heard this exists” to “I just used it”.

This is structurally related to the psychology notion of a **priming effect**: an early, concrete stimulus can
significantly shape subsequent expectations and behaviors. In Dominds we anchor this “priming” in **verifiable runtime
interactions**, instead of relying on longer, declarative system-prompt text.

As a consequence, we can **dramatically simplify system prompts**: keep only short, accurate statements of the
Tellask/FBR contracts, and rely on a real priming run to establish “this works here”.

Related docs:

- Tellask runtime: `dominds/docs/dialog-system.md`
- Terminology (Mainline/Sideline): `dominds/docs/dominds-terminology.md`
- FBR (`!?@self`): `dominds/docs/fbr.md`
- Work language vs UI language: `dominds/docs/i18n.md`

---

## Goals

- Establish immediate trust that Tellask/return/persistence are real.
- Run a real `!?@self` FBR loop at dialog creation.
- Make synthesis itself part of the “felt” experience (dedupe/reconcile/extract-the-best).
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
- **Tellask**: a structured request (`!?@<memberId> ...`) from a tellasker to a tellaskee.
- **Shell staff**: a teammate designated to run shell commands safely (configured via `shell_specialists`).
- **FBR**: Fresh Boots Reasoning, implemented as `!?@self` (a tool-less sideline dialog). See `dominds/docs/fbr.md`.

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

If a shell staff member exists, the main agent (tellasker) issues **a real Tellask** to the shell staff member
(tellaskee), in the server-wide work language.

The Tellask body should be short and operational:

- run exactly `uname -a`
- return raw output verbatim
- if `uname` fails: include error + one safe alternative command

### 3) Real FBR: reflect on what the environment implies

After obtaining the environment snapshot, the main agent issues a real `!?@self` Tellask to trigger FBR.

The FBR body should include:

- the exact `uname -a` output (explicitly name the command; it may change in the future)
- the tool constraint (FBR has no tools; mainline tool availability is separate)
- the question: “What should I be careful about in this environment? Which CLI tools should I prioritize, and why?”

### 4) Synthesize into an “Agent Priming” note

The main agent then writes a short, user-visible **Agent Priming** note via a **normal generation** in the mainline
dialog. It should be explicitly synthesized (dedupe/reconcile/extract-the-best) rather than repeating each draft.

---

## Persistence, caching, and reuse (in-process only)

### 1) Persist as real dialog records (backend + frontend)

All priming steps must be persisted as standard dialog artifacts (messages + events) and visible in the WebUI.

### 2) Process-wide cache (per agent)

To avoid repeating `uname -a` + FBR + synthesis on every new dialog, the backend process may maintain an in-process cache
(lost on restart) keyed by the mainline agent id.

Reuse policy:

- If a valid cache entry exists, a new dialog may reuse the cached transcript and Agent Priming note.
- Reused entries should still be visible in the new dialog transcript, labeled as “reused from cache”.

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
  - “FBR (`!?@self`)"
  - “Agent Priming”

### Opt-out

Dialog creation should provide an explicit opt-out to skip priming.

---

## Safety notes

- Default to a single, low-risk command (`uname -a`).
- Do not run anything that modifies the filesystem or network as part of priming.
- Treat the priming transcript as user-visible by default; avoid including secrets or personally identifying details.
