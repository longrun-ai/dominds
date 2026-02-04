# Showing-by-Doing (做给祂看): Make Tellask Real

Chinese version: [中文版](./showing-by-doing.zh.md)

## Summary

Dominds has a real, runtime-enforced Tellask mechanism (`!?@...`) and a real, runtime-enforced Fresh Boots Reasoning
(FBR) mechanism (`!?@self`). Even if system prompts explain these mechanisms in detail, most foundation models were not
trained in a world where “asking a teammate to run a shell command” is actually possible, so they often treat such text
as aspirational or hypothetical.

**Showing-by-Doing (做给祂看)** is a tiny, highly realistic “first impression” procedure executed at dialog creation
time. It runs a short, real Tellask + real FBR round-trip so the model gains _felt-sense_ that:

- teammate Tellasks are real and will be executed
- tool outputs are real and will be returned
- FBR is real and will produce a report back to the caller

This makes subsequent use of Tellasks and `!?@self` FBR more reliable across the entire dialog lifecycle.

As a consequence, we can **dramatically simplify system prompts**: keep only short, accurate statements of the Tellask/FBR
contracts, and rely on Showing-by-Doing to establish “this is real and works here”.

Related docs:

- Tellask runtime: `dominds/docs/dialog-system.md`
- Terminology (Mainline/Sideline): `dominds/docs/dominds-terminology.md`
- FBR (`!?@self`): `dominds/docs/fbr.md`
- Work language vs UI language: `dominds/docs/i18n.md`

---

## Goals

- Establish immediate trust that **Tellask is not “just prompt text”**: it is an executable, backend-driven mechanism.
- Establish immediate trust that **FBR is not “just reasoning”**: it is a concrete sideline dialog that reports back.
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
- **Shell specialist**: a teammate designated to run shell commands safely (configured via `shell_specialists`).
- **FBR**: Fresh Boots Reasoning, implemented as `!?@self` (a tool-less sideline dialog). See `dominds/docs/fbr.md`.

---

## Runtime flow (at dialog creation)

Showing-by-Doing runs **before** the first user message is processed (a “prelude”), unless the user opts out.

### 1) Choose the shell execution path

1. If the team config includes at least one `shell_specialists` member, pick one deterministically (e.g. the first).
2. Otherwise, let the **Dominds runtime** execute the baseline command directly (not via agent tools).

Note: team config validation normally requires `shell_specialists` to be non-empty if any teammate has shell tools, and
also requires that only listed shell specialists have shell tools. In other words, “no `shell_specialists` configured”
usually means “shell tools are disabled for all user-facing teammates”.

Baseline command:

- `uname -a`

If `uname -a` fails (e.g. non-POSIX host), the runtime should fall back to a platform-appropriate equivalent, but the
default “muscle memory” path is intentionally `uname -a` because it is common, low-risk, and quick.

### 2) Real teammate Tellask: ask for `uname -a`

If a shell specialist exists, the main agent (tellasker) issues **a real Tellask** to the shell specialist (tellaskee),
in the server-wide **work language** (see `dominds/docs/i18n.md`).

The Tellask body should be short and operational:

- ask the shell specialist to run `uname -a`
- ask them to return the raw output verbatim
- ask them to include an error + alternative command if `uname` is not available

The result must be recorded as a normal, debuggable transcript that clearly shows:

- the Tellask headline + body
- the shell specialist’s command execution
- the returned output

Minimal configuration example:

```yaml
# .minds/team.yaml
shell_specialists:
  - cmdr
```

### 3) Real FBR: reflect on what the environment implies

After obtaining the environment snapshot (from the shell specialist or direct tool run), the main agent issues a real
`!?@self` Tellask to trigger **FBR**.

The FBR Tellask body should include:

- the exact `uname -a` output
- the main agent’s tool availability assumptions (e.g. “in mainline I may have `fs`/`os`/`mem`; in FBR you have no tools”)
- the question: “What should I be careful about in this environment? Which CLI tools should I prioritize, and why?”

The FBR response should return a compact report that the main agent can reuse, typically:

- environment notes (OS family, kernel, container/VM hints if any)
- do/don’t list (pitfalls)
- a short “preferred commands” shortlist (e.g. `rg`, `sed`, `jq`, `tar`, `ps`, `lsof`, depending on host)

### 4) Summarize into an “Environment Quickstart” note

The main agent then writes a short, user-visible summary to the mainline dialog so the knowledge is explicit and
searchable in the transcript.

---

## Fallback behavior

Showing-by-Doing should degrade gracefully:

- **No `shell_specialists` configured**: the Dominds runtime runs `uname -a` directly, then do FBR.
- **Shell specialist fails or times out**: the Dominds runtime runs `uname -a` directly and continue, marking the
  specialist attempt as failed in the transcript.
- **`uname` not available / command fails**: run FBR with “environment unknown”; the report should explicitly list what
  is missing and suggest what to gather later.

---

## Persistence, caching, and reuse

### 1) Persist as real dialog records (backend + frontend)

All Showing-by-Doing steps must be persisted as standard dialog artifacts (messages + events) so they remain credible:

- they survive restarts (subject to normal dialog persistence rules)
- they are debuggable in logs/storage
- they are rendered in the WebUI transcript (ideally as a collapsible “Prelude” section)

### 2) Process-wide cache (per teammate)

To avoid repeating `uname -a` + FBR on every new dialog, the backend process may maintain a **server-scoped cache** keyed
by (at minimum):

- tellasker teammate id (the agent whose dialogs are being created)
- an environment fingerprint derived from the `uname -a` output (exact string or hashed)

Cache payload (recommended):

- the full Showing-by-Doing transcript (Tellask + output + FBR + summary)
- a short “Environment Quickstart” distilled form (for compact context injection)
- timestamps + a version tag for future schema changes

Reuse policy:

- If a valid cache entry exists, a new dialog may **reuse** the cached transcript instead of re-running.
- Reused entries should still be visible in the new dialog’s transcript, clearly labeled as “Reused from cache”.

Invalidation (recommended):

- invalidate when the environment fingerprint changes
- allow a manual “Refresh environment snapshot” action for debugging

### 3) Carry across `clear_mind`

After each `clear_mind` (entering the next “journey stage”), do **not** rely on reminders for this.

Instead, inject a small, stable **course prefix** into the model context at the start of each new course (i.e. the first
few messages in the historical dialog section). This prefix should be a condensed transcript distilled from the original
Showing-by-Doing run (shell snapshot + FBR highlights + quickstart), so the agent keeps its “felt-sense” of Tellask/FBR
and environment constraints without re-running the prelude.

---

## UX requirements (WebUI)

### Display

- Render Showing-by-Doing as a realistic transcript the user can inspect.
- Prefer a collapsible “Prelude” section at the top of the dialog, with clear labels:
  - “Teammate Tellask (shell)”
  - “FBR (`!?@self`)”
  - “Environment Quickstart”

### Opt-out

The dialog creation UI should include an explicit opt-out, e.g.:

- Checkbox: “Skip Showing-by-Doing (do not run environment prelude)”

If opted out, no prelude actions are executed and no prelude transcript is generated.

---

## Safety notes

- Default to a single, low-risk command (`uname -a`).
- Do not run anything that modifies the filesystem or network as part of this prelude.
- Treat the prelude transcript as user-visible by default; avoid including secrets or personally identifying details.
