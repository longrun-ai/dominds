# Fresh Boots Reasoning (FBR) — Mechanism Spec

Chinese version: [中文版](./fbr.zh.md)

> This is the **normative FBR spec**. For implementation notes, see: [`fbr-implementation.md`](./fbr-implementation.md).

## 1. What it is

**Fresh Boots Reasoning (FBR)** is a Dominds mechanism for “reasoning again from a clean slate” on a bounded sub-problem,
then reporting back to the tellasker dialog.

In Dominds, FBR is triggered by the dedicated function tool `freshBootsReasoning({ tellaskContent: "...", effort?: N })`.
The mechanism is the runtime-enforced contract applied to the spawned sideline dialog.

## 2. Design principles and tradeoffs

### 2.1 Predictability first: FBR is tool-less

FBR is meant to be “reasoning over text”, not “an agent run that explores the environment”. To keep it safe and
predictable, FBR sideline dialogs must be:

- **tool-less by construction** (technically enforced; not “please don’t use tools”), and
- **body-first** (the tellask body is the authoritative task context).

### 2.2 No silent failure

If FBR is disabled by configuration (e.g. `fbr-effort: 0`), the runtime MUST reject `freshBootsReasoning({ tellaskContent: "..." })` loudly and clearly. A
silent ignore is worse than an error.

### 2.3 Serial multi-pass reasoning, not “multi-agent collaboration”

`fbr-effort` is an FBR intensity setting. Runtime interprets intensity `N` as `N` serial passes inside a **single FBR sideline conversation window**. The tellasker dialog is responsible for distilling the results; passes do not coordinate with each other.

## 3. User syntax

### 3.1 Trigger forms

Use the dedicated FBR form:

- `freshBootsReasoning({ tellaskContent: "...", effort?: N })`

Notes:

- FBR does not use `targetAgentId`, `sessionSlug`, or `mentionList`.
- `tellaskContent` is the authoritative task context for the FBR sideline.
- `effort` is optional and sets per-call FBR intensity; when omitted, runtime uses the current member’s `fbr-effort`.
- Intensity `N` maps to `N` serial FBR passes inside one sideline window.

### 3.2 Scope

This document specifies the FBR mechanism and its `freshBootsReasoning({ tellaskContent: "...", effort?: N })` contract. General teammate Tellasks (`tellaskSessionless({ targetAgentId: "<teammate>", tellaskContent: "..." })`) follow
the taxonomy and capability model in [`dialog-system.md`](./dialog-system.md).

If you want a “fresh” sideline dialog that still has tools, use an explicit teammate identity via the general teammate Tellask flow.

## 4. Runtime contract (normative)

This section uses MUST / MUST NOT / SHOULD / MAY for requirements.

### 4.1 Isolation and context

When driving an FBR sideline dialog created by `freshBootsReasoning({ tellaskContent: "..." })`, runtime MUST enforce:

- **No dependency on tellasker dialog history**
  - the tellaskee MUST NOT assume access to the tellasker dialog’s history
  - the tellaskee MUST treat the tellask body as the primary, authoritative task context
- **Shared FBR iteration context**
  - all rounds launched by a single `freshBootsReasoning` call share the same FBR window assumptions and no-tools policy
  - rounds run in the same sideline context as one continuous thread and stay isolated from the caller dialog history
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
- do not emit any tellasks (including `tellaskBack` or `askHuman`)

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

### 4.3 Tellask restriction: none allowed

FBR sideline dialogs MUST NOT issue any teammate Tellasks (including `tellaskBack({ tellaskContent: "..." })` or `askHuman({ tellaskContent: "..." })`).
If critical context is missing, the FBR sideline should **list the missing items** and why they block reasoning, then return.

### 4.4 Output contract (easy to distill)

An FBR sideline dialog should produce per-round conclusions that are easy to distill. The runtime should aggregate all rounds and post the full set to upstream as one upstream-visible artifact.

1. **Per-round conclusion / findings** (same `freshBootsReasoning` call only)
2. **Conclusion / recommendation**
3. **Reasoning** (grounded in the tellask body)
4. **Assumptions** (explicitly sourced: body vs session history)
5. **Unknowns / missing context**
6. **Next steps for tellasker dialog** (where tools/teammates may exist)

### 4.5 Violations and errors (loud + debuggable)

- Any teammate Tellask attempt or any tool/function call attempt inside FBR MUST be treated as a hard
  violation.
- The runtime MUST return a clear, user-visible error, and MUST log/emit a debuggable reason string (no silent swallow).

## 5. Sequential execution: `fbr-effort`

`fbr-effort` is a per-member integer config (also allowed under `member_defaults` as rtws defaults):

- Type: integer
- Default: `3`
- `0`: disable FBR by default for that member (runtime MUST reject when effective effort is `0`)
- `1..100`: valid intensity range (effective effort comes from explicit `effort` or fallback `fbr-effort`)
- `> 100` / non-integer / negative: validation error (reject; no clamping)

When `fbr-effort = N`:

- runtime expands a single `freshBootsReasoning({ tellaskContent: "..." })` into **N sequential rounds inside one sideline dialog**
- each round receives the same tellask body and FBR constraints; runtime enforces only “different angle and no conclusion repetition”, without prescribing concrete analysis directions
- round 1 carries the full tellask body; later rounds append incremental round directives only and do not repeat the round-1 preface
- each round MUST use an angle explicitly different from all previous rounds
- each round must stay in one subdialog, avoid repeating previous-round conclusions, and use a fresh perspective.
- only the final round is posted back to the caller; when posted, upstream receives the full accumulated round conclusions (not only the last-round text).
- tellasker dialog receives the full consolidated result after all rounds complete

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
  # Run 3 rounds inside one tool-less FBR sideline per `freshBootsReasoning({ tellaskContent: "..." })`.
  fbr-effort: 3

members:
  ux:
    # Run 5 rounds per `freshBootsReasoning({ tellaskContent: "..." })` in the same sideline.
    fbr-effort: 5

    # Make FBR more exploratory without changing tellasker dialog behavior.
    fbr_model_params:
      codex:
        temperature: 0.9
        reasoning_effort: medium
      general:
        max_tokens: 1200
```

## 8. Relationship to general sideline dialogs

- `freshBootsReasoning({ tellaskContent: "..." })` is a special case: tool-less, body-first, tellask-restricted, optionally fanned out in sequence via `fbr-effort`.
- General `tellaskSessionless({ targetAgentId: "<teammate>", tellaskContent: "..." })` sidelines remain fully capable (tools/toolsets as configured).
- If you need “same persona + tools” in a sideline, use an explicit teammate identity (`tellask` / `tellaskSessionless`).

## 9. Acceptance checklist

- `freshBootsReasoning({ tellaskContent: "..." })` triggers tool-less FBR; the LLM request is technically “zero tools”.
- The system prompt body contains no tool instructions; tool-related wording comes only from the separate fixed notice.
- FBR sidelines cannot issue teammate Tellasks (including `tellaskBack`).
- `fbr-effort` defaults to `3`, accepts `0..100`, rejects invalid values, and fails loudly when disabled.
- `fbr_model_params` applies only to FBR and follows the same schema/merge intent as `model_params`.
