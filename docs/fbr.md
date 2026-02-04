# Fresh Boots Reasoning (FBR) — Design Doc (Enhanced `@self`)

## Summary

Fresh Boots Reasoning (FBR) is a common Dominds pattern: the agent tellasks itself (`!?@self`) to create a short-lived
sideline dialog that thinks “from scratch” on a bounded sub-problem, then reports back to the caller.

This document specifies **enhancements** to the `@self`-initiated FBR flow:

1. **Tool-less FBR sideline dialogs**: FBR sideline dialogs created by `!?@self` MUST NOT have any tools/toolsets.
   Prompts MUST explicitly state that the tellaskee has **no tools** and can only reason from the tellask body.
2. **Configurable FBR concurrency** via `.minds/team.yaml` `fbr-effort` (default `1`):
   - `0` disables `!?@self` FBR for that teammate
   - `1..100` spawns that many FBR sideline dialogs per `!?@self`
   - `> 100` is a validation error
3. **FBR-only model parameter overrides** via `.minds/team.yaml` `fbr_model_params`, with the same schema as
   `model_params` / `model_param_options` (see `dominds/main/llm/defaults.yaml`).

## Goals

- Make `!?@self` FBR safer and more predictable by removing tool access and requiring explicit context.
- Enable “many-shot” reasoning by spawning multiple FBR sideline dialogs concurrently (`fbr-effort`).
- Allow tuning model parameters specifically for FBR (e.g. higher `temperature`) without affecting the mainline dialog.

## Non-goals

- Defining a brand-new user-facing syntax beyond existing `!?@self` / `!?@self !tellaskSession ...`.
- Adding tools to FBR sideline dialogs (the entire point is that they are tool-less).
- Changing teammate Tellask taxonomy in general (see `dominds/docs/dialog-system.md`); this doc scopes to `@self` only.

## Definitions

- **FBR**: Fresh Boots Reasoning (扪心自问) — reasoning from first principles without relying on prior context.
- **Tellask**: a structured request (`!?@...`) issued by a dialog to another dialog/teammate (including `@self`).
- **tellasker / tellaskee**: requester / responder roles for a Tellask.
- **Mainline dialog / sideline dialog**: user-facing terms for the primary thread and its temporary work threads.
  (Implementation terms like `root/main/subdialog` may appear in code; avoid surfacing them in prompts/examples.)

## Runtime behavior: Tool-less `!?@self` FBR

### Trigger: which Tellasks are “FBR”

The following Tellasks are considered `@self` FBR:

- Default (transient): `!?@self`
- Rare (resumable): `!?@self !tellaskSession <tellaskSession>` (the sideline dialog carries its prior `tellaskSession` history)

This spec applies to both forms: **any `@self` FBR sideline dialog is tool-less**.

### Isolation contract

When the runtime drives an FBR sideline dialog created by `!?@self`, it MUST enforce:

- **No tools**:
  - no function tools
  - no MCP tools
  - no teammate Tellasks (including `!?@human`)
  - no supcalls
- **No caller-thread context dependency**:
  - the tellaskee MUST NOT assume access to the tellasker’s mainline/sideline dialog history
  - the tellaskee MUST treat the tellask body as the primary, authoritative task context
  - if using the resumable `!tellaskSession` form, the tellaskee MAY use its own prior `tellaskSession` history as explicit context
  - the tellaskee MUST NOT use tools to read files, browse, run shell commands, or fetch Memory/workspace state

In practice, treat the tellaskee as “fresh relative to the caller thread”: it does not get the tellasker’s accumulated
dialog history. It may still receive baseline, unconditionally injected context (persona/system policy, safety rules,
formatting norms, read-only Memory excerpts, etc.), and the resumable `!tellaskSession` form includes its own prior
session history.

### Prompting contract (system + tool prompts)

The runtime MUST make the tool-less constraint unambiguous in prompts.

### API / transport contract (tool disablement)

The tool-less requirement is not just “prompt text”. The runtime MUST enforce it technically:

- The LLM request for an `@self` FBR sideline dialog MUST be issued with **zero tools available**:
  - do not include any tool/function definitions in the request payload (the effective tool list MUST be empty)
  - do not enable any “tool calling” mode / tool choice / function calling feature supported by the provider
- The runtime MUST reject any attempt by the model to emit a tool call in FBR, even if the provider SDK would otherwise
  accept it.

#### System prompt requirements (minimum)

The FBR sideline dialog’s system prompt MUST clearly state:

- You have **no tools** and cannot call tools.
- You have **no direct workspace / files / browser / shell** access (tool calling is disabled).
- The tellask body is the **primary task context**; do not assume any caller-thread history is available.
- If this is a resumable `!tellaskSession` FBR, you may use your own prior `tellaskSession` history as explicit context.
- If the tellask body is missing critical context, respond by listing what is missing and why it blocks reasoning.

#### Tool prompt requirements (when applicable)

If the provider integration normally injects a tool prompt (or tool schema), then for `@self` FBR it MUST either:

- omit the tool prompt entirely, OR
- inject a tool prompt that explicitly states “no tools are available; tool calling is disabled”

There MUST NOT be any tool definitions visible to the FBR sideline dialog.

### Output contract

The FBR sideline dialog should produce a compact reasoning artifact that is easy for the tellasker to integrate.
Recommended structure (not rigidly required):

1. **Answer / conclusion**
2. **Reasoning** (grounded in the tellask body; plus `tellaskSession` history if using the resumable form)
3. **Assumptions** (explicitly derived from the tellask body, unless clearly sourced from `tellaskSession` history)
4. **Unknowns / missing context** (if any)
5. **Next steps** (for the tellasker to take in the mainline dialog, where tools may exist)

### Enforcement & error handling

- If the FBR sideline dialog attempts to emit a tool call, the runtime MUST treat it as a hard error for that sideline
  run and return a clear error back to the tellasker (do not silently ignore).
- The error should be loud and debuggable (e.g., an explicit “tool_call_not_allowed_in_fbr” reason string in logs/events).

## Configuration: `.minds/team.yaml` additions

Both additions are **per-teammate** and MAY also be placed under `member_defaults` to set workspace-wide defaults.

### `fbr-effort` (default: `1`)

`fbr-effort` controls how many tool-less FBR sideline dialogs the runtime spawns for each `!?@self` Tellask.

Rules:

- Type: integer
- Default: `1`
- `0`: disable `!?@self` FBR for that teammate
- `1..100`: spawn that many FBR sideline dialogs concurrently per `!?@self`
- `> 100`: validation error (reject team config; do not clamp)
- `< 0` or non-integer: validation error

**Behavior when disabled (`fbr-effort: 0`)**:

- The runtime MUST reject `!?@self` Tellasks for that teammate with a clear, user-visible error (so failures are not silent).

### Concurrency semantics (`fbr-effort > 1`)

When `fbr-effort` is `N`:

- The runtime expands a single `!?@self` Tellask into **N parallel tool-less FBR sideline dialogs**.
- Each sideline dialog receives the same tellask body (and the same tool-less system/tool prompts).
- The runtime returns all N responses to the tellasker. **Do not rely on any particular ordering**:
  - Responses may be injected/arrive in completion order (which is often effectively “mixed”).
- For the resumable `!?@self !tellaskSession <tellaskSession>` form with `N > 1`, the runtime MUST derive **distinct**
  session keys so each parallel sideline dialog has independent history (recommended scheme: `<tellaskSession>.fbr<i>`).

The intent is to allow the tellasker (mainline) to synthesize multiple independent reasoning traces into a better decision.

### `fbr_model_params` (optional)

`fbr_model_params` provides model parameter overrides used **only when driving `@self` FBR sideline dialogs**.

- Schema: identical to `model_params` (and documented via `model_param_options` in `dominds/main/llm/defaults.yaml`)
- Scope: applies only to `!?@self` FBR sideline dialogs
- The teammate’s normal `model_params` continue to apply to non-FBR runs

**Merge rule (recommended)**:

- Compute the teammate’s effective `model_params` as usual (defaults + teammate overrides).
- For `@self` FBR only, deep-merge `fbr_model_params` on top (so it can override just a few fields like `temperature`).
- Provider-agnostic `max_tokens` may be configured either as `max_tokens` (top-level) or `general.max_tokens` (mirrors
  `model_param_options` grouping). Do not set both.

## Examples

### Tool-less FBR: tellask body must include full context

Bad (relies on external context and tools):

```text
!?@self
Figure out what the bug is and fix it.
```

Good (self-contained context):

```text
!?@self
You are doing FBR with no tools. Use ONLY the text below.

Goal: explain the likely root cause and propose 2–3 fixes.

Observed behavior:
- Clicking “Run” sometimes freezes the UI for ~10s.

Constraints:
- We cannot change the backend protocol.

Relevant snippet:
<paste the relevant log lines / code / stack trace here>
```

### `.minds/team.yaml` configuration

```yaml
member_defaults:
  # Spawn exactly one tool-less FBR sideline dialog per `!?@self` by default.
  fbr-effort: 1

members:
  ux:
    # Spawn 5 independent FBR sideline dialogs per `!?@self`.
    fbr-effort: 5

    # Make FBR “more exploratory” without affecting mainline behavior.
    fbr_model_params:
      codex:
        temperature: 0.9
        reasoning_effort: medium
      general:
        max_tokens: 1200
```

## Compatibility notes

- This spec intentionally makes `!?@self` behave differently from general transient sideline dialogs:
  normal `!?@<teammate>` sideline dialogs remain fully capable (they can have tools/toolsets) as specified in
  `dominds/docs/dialog-system.md`.
- If you need a tool-capable “fresh subdialog” for the same persona, use an explicit teammate identity that is granted
  the needed toolsets, rather than `@self`.

## Acceptance criteria (implementation checklist)

- `!?@self` creates tool-less sideline dialog(s) with explicit prompt text stating “no tools; body-only context”.
- `fbr-effort` defaults to `1`, accepts `0..100`, rejects `>100` and non-integers.
- `fbr-effort: 0` causes `!?@self` to fail loudly with a clear error.
- `fbr_model_params` is applied only to `@self` FBR sideline dialogs and follows the same schema as `model_params`.
