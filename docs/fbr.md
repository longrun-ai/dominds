# Fresh Boots Reasoning (FBR) — Mechanism Spec

Chinese version: [中文版](./fbr.zh.md)

> This is the **normative FBR spec**. For implementation notes, see: [`fbr-implementation.md`](./fbr-implementation.md).

## 1. What it is

**Fresh Boots Reasoning (FBR)** is a Dominds mechanism for “reasoning again from a clean slate” on a bounded sub-problem,
then reporting back to the tellasker.

In Dominds, FBR is triggered by the dedicated function tool `freshBootsReasoning({ tellaskContent: "...", effort?: N })`.
The mechanism is the runtime-enforced contract applied to the spawned Side Dialog.

## 2. Design principles and tradeoffs

### 2.1 Predictability first: FBR cannot use ordinary tools until final closure

FBR is meant to be “reasoning over text”, not “an agent run that explores the environment”. To keep it safe and
predictable, FBR Side Dialogs must be:

- **isolated from ordinary tools during divergence/convergence** (no tellask / file / shell / browser / rtws access; provider requests may use `tool_choice: "none"` or equivalent), and
- **closure-only in the final stage** (exactly two conclusion functions, no other tools), and
- **body-first** (the tellask body is the authoritative task context).

### 2.2 No silent failure

If FBR is disabled by configuration (e.g. `fbr-effort: 0`), the runtime MUST reject `freshBootsReasoning({ tellaskContent: "..." })` loudly and clearly. A
silent ignore is worse than an error.

### 2.3 Serial multi-pass reasoning, not “multi-agent collaboration”

`fbr-effort` is an FBR intensity setting. Runtime interprets intensity `N` as `N` divergence rounds, then `N` convergence rounds, inside a **single FBR Side Dialog conversation window**. The FBR Side Dialog itself must finish denoising and closure before reporting to tellasker.

## 3. User syntax

### 3.1 Trigger forms

Use the dedicated FBR form:

- `freshBootsReasoning({ tellaskContent: "...", effort?: N })`

Notes:

- FBR does not use `targetAgentId`, `sessionSlug`, or `mentionList`.
- `tellaskContent` is the authoritative task context for the FBR Side Dialog.
- `effort` is optional and sets per-call FBR intensity; when omitted, runtime uses the current member’s `fbr-effort`.
- Intensity `N` maps to `N` divergence rounds, `N` convergence rounds and at most `N` finalization attempts, subject to context-pressure early closure.

### 3.2 Scope

This document specifies the FBR mechanism and its `freshBootsReasoning({ tellaskContent: "...", effort?: N })` contract. General teammate Tellasks (`tellaskSessionless({ targetAgentId: "<teammate>", tellaskContent: "..." })`) follow
the taxonomy and capability model in [`dialog-system.md`](./dialog-system.md).

If you want a “fresh” Side Dialog that still has tools, use an explicit teammate identity via the general teammate Tellask flow.

## 4. Runtime contract (normative)

This section uses MUST / MUST NOT / SHOULD / MAY for requirements.

### 4.1 Isolation and context

When driving an FBR Side Dialog created by `freshBootsReasoning({ tellaskContent: "..." })`, runtime MUST enforce:

- **No dependency on tellasker-side history**
  - the tellaskee MUST NOT assume access to the tellasker-side dialog history
  - the tellaskee MUST treat the tellask body as the primary, authoritative task context
- **Shared FBR iteration context**
  - all rounds launched by a single `freshBootsReasoning` call share the same FBR window assumptions and no-tools policy
  - rounds run in the same Side Dialog context as one continuous thread and stay isolated from the tellasker-side dialog history
- **No tool-based context fetch**
  - no reading files / running commands / browsing
  - no accessing Memory or rtws (runtime workspace) state

Intuition: “fresh boots” means “fresh relative to the tellasker-side thread”, not “ignores baseline system rules”. Runtime supplies the dedicated FBR policy and the FBR dialog’s own history. It does not inject shared Taskdoc, member memories, ordinary reminders, or ordinary reply-tool guidance; callers must put required task facts in the supplied body.

### 4.2 Tool isolation (prompt + technical enforcement)

Tool-less FBR has two layers, both required:

1. **Prompt contract**: the runtime must communicate the current phase constraints unambiguously.
2. **API/transport contract**: divergence/convergence must expose no callable Dominds tools; final closure may expose exactly two conclusion functions and nothing else.

#### 4.2.1 System prompt requirements

The system prompt must explain the FBR role, the authority of the supplied body, the current phase, and how to report missing evidence. It must respect the actual phase capabilities: no functions during divergence/convergence, and only the two conclusion functions during finalization. It must not require ordinary reply, Taskdoc, memory, filesystem, shell, or teammate tools.

#### 4.2.2 Dedicated capability notice

A separate short notice states the current phase capability boundary. Divergence/convergence have no tools. Finalization exposes exactly the two conclusion functions. Both phases forbid ordinary tool calls and access to rtws/files/browser/shell. Provider-visible definitions must match that boundary.

#### 4.2.3 Divergence/convergence requests expose no callable tools

For divergence/convergence, the LLM request for an FBR Side Dialog (`freshBootsReasoning`) MUST have no callable Dominds tools available:

- the request payload must not include tool/function definitions (effective tool list must be empty)
- provider tool-calling / function-calling modes should use `none` or the closest provider-equivalent disabled mode

In the final closure phase, runtime MAY expose exactly these two functions and no others:

- `presentLowNoiseHighlyInformativeConclusion({ content })`
- `presentUnreasonableSituation({ content })`

If the model attempts any other tool/function call, runtime MUST hard-reject it (see 4.5).

### 4.3 Tellask restriction: none allowed

FBR Side Dialogs MUST NOT issue any tellask call (including `tellaskBack({ tellaskContent: "..." })`, `tellask({ ... })`, `tellaskSessionless({ ... })`, or `askHuman({ tellaskContent: "..." })`).
If critical context is missing, the FBR Side Dialog should **list the missing items** and why they block reasoning, then return.

### 4.4 Output contract (easy to distill)

An FBR Side Dialog should denoise internally and post only one tellasker-visible final artifact.

1. **Divergence**: stay open to wild or minority ideas without forcing early consensus.
2. **Convergence**: discard unsupported wild ideas as noise and keep only stable cross-round consensus.
3. **Final closure**: end by calling exactly one of the two conclusion functions above.
4. **Tellasker delivery**: the tellasker receives only the final low-noise conclusion, or the final “unreasonable situation” conclusion.

### 4.5 Violations and errors (loud + debuggable)

- Ordinary tools and teammate Tellasks must be rejected without execution. During finalization only the two conclusion functions are permitted.
- The runtime MUST return a clear, user-visible error, and MUST log/emit a debuggable reason string (no silent swallow).

## 5. Sequential execution: `fbr-effort`

`fbr-effort` is a per-member integer config (also allowed under `member_defaults` as rtws defaults):

- Type: integer
- Default: `3`
- `0`: disable FBR by default for that member (runtime MUST reject when effective effort is `0`)
- `1..100`: valid intensity range (effective effort comes from explicit `effort` or fallback `fbr-effort`)
- `> 100` / non-integer / negative: validation error (reject; no clamping)

When `fbr-effort = N`:

- normal execution expands one `freshBootsReasoning({ tellaskContent: "..." })` into **N divergence rounds + N convergence rounds + up to N finalization retries** inside one Side Dialog
- divergence rounds must explore distinct angles and stay open to ideas that may later be discarded
- convergence rounds must denoise autonomously and preserve only stable consensus
- normally, conclusion functions are exposed after divergence and convergence; measured caution can skip remaining reasoning rounds and enter finalization early
- finalization has at most `N` attempts, including early finalization under caution; if no acceptable conclusion is submitted, runtime closes with a notice that no formal conclusion was accepted
- critical context stops further model requests and returns an explicit context-limit notice; pressure and missing tool closure do not establish task complexity or reasoning quality
- tellasker receives one final conclusion or runtime closure notice, rather than a dump of private rounds

## 6. FBR-only model overrides: `fbr_model_params`

`fbr_model_params` overrides model params **only when driving FBR Side Dialogs**:

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
  # Run 3 rounds inside one tool-less FBR Side Dialog per `freshBootsReasoning({ tellaskContent: "..." })`.
  fbr-effort: 3

members:
  ux:
    # Run 5 rounds per `freshBootsReasoning({ tellaskContent: "..." })` in the same Side Dialog.
    fbr-effort: 5

    # Make FBR more exploratory without changing tellasker behavior.
    fbr_model_params:
      codex:
        temperature: 0.9
        reasoning_effort: medium
      general:
        max_tokens: 1200
```

## 8. Relationship to general Side Dialogs

- `freshBootsReasoning({ tellaskContent: "..." })` is a special case: tool-less, body-first, tellask-restricted, optionally fanned out in sequence via `fbr-effort`.
- General `tellaskSessionless({ targetAgentId: "<teammate>", tellaskContent: "..." })` Side Dialogs remain fully capable (tools/toolsets as configured).
- If you need “same persona + tools” in a Side Dialog, use an explicit teammate identity (`tellask` / `tellaskSessionless`).

## 9. Acceptance checklist

- `freshBootsReasoning({ tellaskContent: "..." })` triggers FBR; divergence/convergence expose no callable tools, and final closure requires one of the two conclusion tools.
- System guidance and the dedicated notice match the current phase capabilities; ordinary tool instructions are excluded.
- FBR Side Dialogs cannot issue teammate Tellasks (including `tellaskBack`).
- `fbr-effort` defaults to `3`, accepts `0..100`, rejects invalid values, and fails loudly when disabled.
- `fbr_model_params` applies only to FBR and follows the same schema/merge intent as `model_params`.
