# Fresh Boots Reasoning (FBR) — Mechanism Spec

Chinese version: [中文版](./fbr.zh.md)

> This is the **normative FBR spec**. For implementation notes, see: [`fbr-implementation.md`](./fbr-implementation.md).

## 1. What it is

**Fresh Boots Reasoning (FBR)** is a Dominds mechanism for “reasoning again from a clean slate” on a bounded sub-problem,
then reporting back to the mainline dialog.

In Dominds, FBR is triggered by the dedicated function tool `freshBootsReasoning({ tellaskContent: "..." })`.
The mechanism is the runtime-enforced contract applied to the spawned sideline dialog(s).

## 2. Design principles and tradeoffs

### 2.1 Predictability first: FBR is tool-less

FBR is meant to be “reasoning over text”, not “an agent run that explores the environment”. To keep it safe and
predictable, FBR sideline dialogs must be:

- **tool-less by construction** (technically enforced; not “please don’t use tools”), and
- **body-first** (the tellask body is the authoritative task context).

### 2.2 No silent failure

If FBR is disabled by configuration (e.g. `fbr-effort: 0`), the runtime MUST reject `freshBootsReasoning({ tellaskContent: "..." })` loudly and clearly. A
silent ignore is worse than an error.

### 2.3 Many-shot reasoning, not “multi-agent collaboration”

`fbr-effort` is for producing multiple _independent_ reasoning samples in parallel. The mainline dialog is responsible
for synthesis; FBR sidelines do not coordinate with each other.

## 3. User syntax

### 3.1 Trigger forms

Use the dedicated FBR form:

- `freshBootsReasoning({ tellaskContent: "..." })`

Notes:

- FBR does not use `targetAgentId`, `sessionSlug`, or `mentionList`.
- `tellaskContent` is the authoritative task context for the FBR sideline.

### 3.2 Scope

This document specifies the FBR mechanism and its `freshBootsReasoning({ tellaskContent: "..." })` contract. General teammate Tellasks (`tellaskSessionless({ targetAgentId: "<teammate>", tellaskContent: "..." })`) follow
the taxonomy and capability model in [`dialog-system.md`](./dialog-system.md).

If you want a “fresh” sideline dialog that still has tools, use an explicit teammate identity via the general teammate Tellask flow.

## 4. Runtime contract (normative)

This section uses MUST / MUST NOT / SHOULD / MAY for requirements.

### 4.1 Isolation and context

When driving an FBR sideline dialog created by `freshBootsReasoning({ tellaskContent: "..." })`, runtime MUST enforce:

- **No dependency on tellasker dialog history**
  - the tellaskee MUST NOT assume access to the tellasker’s mainline/sideline history
  - the tellaskee MUST treat the tellask body as the primary, authoritative task context
- **No tool-based context fetch**
  - no reading files / running commands / browsing
  - no accessing Memory or rtws (runtime workspace) state

Intuition: “fresh boots” means “fresh relative to the caller thread”, not “ignores baseline system rules”. Runtime may
still inject baseline policy/safety/formatting context, but the tellask body remains the authority.

### 4.2 Tool-less (prompt + technical enforcement)

Tool-less FBR has two layers, both required:

1. **Prompt contract**: the runtime must communicate the tool-less constraint unambiguously.
2. **API/transport contract**: the runtime must make the request technically tool-less.

#### 4.2.1 System prompt requirements (no tool instructions)

The FBR system prompt MUST communicate (wording may vary, meaning must hold):

- this is an FBR sideline dialog; the tellask body is the primary context
- do not assume access to tellasker dialog history
- if critical context is missing, list what is missing and why it blocks reasoning
- `tellaskBack({ tellaskContent: "..." })` is allowed only when you must clarify critical missing context; otherwise do not emit any tellasks

And: the **system prompt body MUST NOT include tool instructions** (no tool lists, allowlists, example commands, “how to
use tools”, etc.).

#### 4.2.2 Appended “no tools” notice (the only allowed tool-related text)

All tool-availability wording MUST be confined to a separately injected “no tools” notice, and that notice MUST be:

- short, fixed, and non-extensible
- explicit: no tools available; do not call tools
- explicit: no access to rtws / files / browser / shell
- free of any tool lists, allowlists, example commands, or execution guidance

If a provider integration normally injects a tool prompt or schema, then for FBR it MUST either:

- omit it entirely, OR
- inject text that is identical to the appended “no tools” notice

Under no circumstances should the FBR sideline dialog see any tool definitions.

#### 4.2.3 The LLM request MUST be “zero tools”

The LLM request for an FBR sideline dialog (`freshBootsReasoning`) MUST have **zero tools available**:

- the request payload must not include tool/function definitions (effective tool list must be empty)
- provider tool-calling / function-calling modes must not be enabled

If the model attempts a tool/function call anyway, runtime MUST hard-reject it (see 4.5).

### 4.3 Tellask restriction: only `tellaskBack({ tellaskContent: "..." })`

FBR sideline dialogs MUST NOT issue teammate Tellasks (including `askHuman({ tellaskContent: "..." })`). The only exception is `tellaskBack({ tellaskContent: "..." })`:

- sideline-only TellaskBack to the upstream tellasker dialog
- allowed only when critical context must be clarified
- intended for clarification, not delegation

### 4.4 Output contract (easy to synthesize)

An FBR sideline dialog should produce a compact artifact that is easy for the tellasker to integrate. Suggested shape:

1. **Conclusion**
2. **Reasoning** (grounded in the tellask body)
3. **Assumptions** (explicitly sourced: body vs session history)
4. **Unknowns / missing context**
5. **Next steps for mainline** (where tools/teammates may exist)

### 4.5 Violations and errors (loud + debuggable)

- Any disallowed tellask (anything other than `tellaskBack({ tellaskContent: "..." })`) or any tool/function call attempt inside FBR MUST be treated as a hard
  violation.
- The runtime MUST return a clear, user-visible error, and MUST log/emit a debuggable reason string (no silent swallow).

## 5. Concurrency: `fbr-effort`

`fbr-effort` is a per-member integer config (also allowed under `member_defaults` as rtws defaults):

- Type: integer
- Default: `3`
- `0`: disable `freshBootsReasoning({ tellaskContent: "..." })` FBR for that member (runtime MUST reject `freshBootsReasoning({ tellaskContent: "..." })` clearly)
- `1..100`: spawn N FBR sideline dialogs per `freshBootsReasoning({ tellaskContent: "..." })`
- `> 100` / non-integer / negative: validation error (reject; no clamping)

When `fbr-effort = N`:

- runtime expands a single `freshBootsReasoning({ tellaskContent: "..." })` into **N parallel tool-less FBR sideline dialogs**
- each sideline receives the same tellask body and the same tool-less constraints
- mainline receives all N responses; **ordering must not be relied on** (completion order is fine)

## 6. FBR-only model overrides: `fbr_model_params`

`fbr_model_params` overrides model params **only when driving FBR sideline dialogs**:

- Schema: identical to `model_params` (documented by `model_param_options` in `dominds/main/llm/defaults.yaml`)
- Scope: `freshBootsReasoning({ tellaskContent: "..." })` only
- Merge: recommended deep-merge on top of the member’s effective `model_params`
- `max_tokens` may be configured as top-level `max_tokens` or `general.max_tokens` (pick one; do not set both)

## 7. Examples

### 7.1 Tellask body should be self-contained

Bad (depends on external context/tools):

```text
freshBootsReasoning({ tellaskContent: "Find the bug and fix it." })
```

Good (puts the actual context into the body):

```text
freshBootsReasoning({ tellaskContent: "You are doing tool-less FBR. Use ONLY the text below.\n\nGoal: identify the most likely root cause and propose 2–3 viable fixes.\n\nObserved:\n- Clicking “Run” sometimes freezes the UI for ~10s.\n\nConstraint:\n- We cannot change the backend protocol.\n\nEvidence:\n<paste relevant logs / code / stack trace here>" })
```

### 7.2 `.minds/team.yaml`

```yaml
member_defaults:
  # Spawn 3 tool-less FBR sideline dialogs per `freshBootsReasoning({ tellaskContent: "..." })` by default.
  fbr-effort: 3

members:
  ux:
    # Spawn 5 independent reasoning samples per `freshBootsReasoning({ tellaskContent: "..." })`.
    fbr-effort: 5

    # Make FBR more exploratory without changing mainline behavior.
    fbr_model_params:
      codex:
        temperature: 0.9
        reasoning_effort: medium
      general:
        max_tokens: 1200
```

## 8. Relationship to general sideline dialogs

- `freshBootsReasoning({ tellaskContent: "..." })` is a special case: tool-less, body-first, tellask-restricted, optionally fanned out via `fbr-effort`.
- General `tellaskSessionless({ targetAgentId: "<teammate>", tellaskContent: "..." })` sidelines remain fully capable (tools/toolsets as configured).
- If you need “same persona + tools” in a sideline, use an explicit teammate identity (`tellask` / `tellaskSessionless`).

## 9. Acceptance checklist

- `freshBootsReasoning({ tellaskContent: "..." })` triggers tool-less FBR; the LLM request is technically “zero tools”.
- The system prompt body contains no tool instructions; tool-related wording comes only from the separate fixed notice.
- FBR sidelines cannot issue teammate Tellasks; only `tellaskBack({ tellaskContent: "..." })` is allowed when necessary.
- `fbr-effort` defaults to `3`, accepts `0..100`, rejects invalid values, and fails loudly when disabled.
- `fbr_model_params` applies only to FBR and follows the same schema/merge intent as `model_params`.
