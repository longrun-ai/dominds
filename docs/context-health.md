# Context Health Monitor

This document specifies a **context health monitor** feature for Dominds: a small, always-on signal
that helps the agent (and user) avoid degraded performance when the conversation’s prompt/context is
getting too large relative to the model’s context window.

## Current Code Reality (as of 2026-01-26)

Dominds already has:

- A **provider usage stats** path (per generation) from the LLM wrappers.
- A computed and persisted **context health snapshot** per generation turn (derived from usage +
  per-model metadata).
- A minimal **UI indicator** surface consuming the dialog’s context health state.

## Goals

- Collect **token usage stats** from LLM provider wrappers after each generation.
- Compute a simple **context health** signal from provider stats + model metadata.
- When the dialog context is “too large”, enforce a **v2 remediation** workflow that is short,
  executable, and regression-testable:
  - Use **non-persisted role=user guidance injection** on the next LLM generation turn (do not write
    the injected guidance into dialog history/events).
  - In **critical**, enforce stability via a **forced-clear loop** (max 3 attempts) that discards
    assistant output unless the model calls `clear_mind` with a non-empty re-entry package.
  - After 3 failed forced attempts, escalate to **Q4H(kind=context_health_critical)** and suspend the
    dialog; WebUI disables send for that kind.

## Non-goals

- Estimating tokens when the provider does not report them (prefer “unknown” over guesses).
- Introducing external/local tokenizers for token counting (e.g., tiktoken-like estimators). Context
  health must rely on LLM provider API usage stats only.
- Building a full “token accounting” system for cost reporting (this is a health signal, not billing).
- Perfect cross-provider comparability (providers report usage differently; normalize only what’s
  safe and explicit).

## Definitions

- **Model context window**: the maximum number of tokens that can fit in the model’s prompt/context
  (as configured in provider model metadata).
- **Prompt tokens**: tokens in the input prompt sent to the model for a generation.
- **Completion tokens**: tokens produced by the model for that generation.
- **Total tokens**: prompt + completion (if the provider reports it).

### Thresholds

- **`optimal_max_tokens`**: an optional per-model “soft ceiling” for prompt/context size.
  - If explicitly configured, Dominds uses it directly.
  - If not configured, Dominds defaults to **100,000** tokens.
- **`critical_max_tokens`**: an optional per-model “critical ceiling” for prompt/context size.
  - If explicitly configured, Dominds uses it directly.
  - If not configured, Dominds defaults to **90% of the model hard context limit**
    (`floor(modelContextLimitTokens * 0.9)`).

Notes:

- For **context health**, the most useful measure is typically **prompt tokens** (how big the input
  is), not completion size.

## Data Requirements (Provider → Dominds)

Provider wrappers must return usage stats **for every successful generation**:

- `promptTokens`: number
- `completionTokens`: number
- `totalTokens`: number (optional if provider does not supply; otherwise `prompt + completion`)
- `modelContextLimitTokens`: number (from model metadata/config; not inferred)

If a provider cannot supply usage:

- Return a variant indicating **usage is unavailable** (do not return zeros).
- The UI should show “unknown” context health for that turn.
- Dominds must not attempt to “fill in” missing counts with an external tokenizer.

### Where model limits come from in current Dominds

Model metadata lives in `dominds/main/llm/defaults.yaml` (and can be overridden via `.minds/llm.yaml`)
and is loaded by `LlmConfig` (`dominds/main/llm/client.ts`).

For context health, the limit should be sourced from:

1. `context_length` if present
2. Otherwise `input_length` (as a conservative fallback for prompt-size monitoring)

## Health Computation

Dominds computes ratios:

- `hardUtil = promptTokens / modelContextLimitTokens`
- `optimalUtil = promptTokens / effectiveOptimalMaxTokens`

Where:

- `effectiveOptimalMaxTokens = optimal_max_tokens ?? 100_000`
- `effectiveCriticalMaxTokens = critical_max_tokens ?? floor(modelContextLimitTokens * 0.9)`

### Levels

Levels are derived from the two thresholds:

- **Healthy (green)**: `promptTokens <= effectiveOptimalMaxTokens`
- **Caution (yellow)**: `promptTokens > effectiveOptimalMaxTokens`
- **Critical (red)**: `promptTokens > effectiveCriticalMaxTokens`

## v2 Remediation Semantics (Driver-enforced)

### Re-entry package (“重入包”)

The remediation workflow centers around a _re-entry package_ (a scannable, actionable bundle of
context that survives a new round).

Recommended structure (multi-line; scale by task size):

- Goal/scope
- Current progress
- Key decisions/constraints
- Changes (files/modules)
- Next steps (actionable)
- Open questions/risks

### Caution (yellow)

When `level === 'caution'`, the driver injects a **role=user** guidance message into the _next_ LLM
generation turn (not persisted) that forces a **binary choice** using the same re-entry package:

- `clear_mind({ "reminder_content": "<re-entry package>" })` (preferred)
- `add_reminder({ "content": "<re-entry package>", "position": 0 })`

If the agent does not `clear_mind` and the dialog remains in `caution`, the driver re-injects the
guidance every **10 generation turns** until cleared.

### Critical (red)

When `level === 'critical'`, the driver enters a **forced-clear loop** (max **3** attempts) on the
next generation turn:

- The injected guidance is **clear-only**: the model must call `clear_mind` with a **non-empty**
  `reminder_content` containing a re-entry package.
- If the model output does not include such a `clear_mind` call, the driver **discards the assistant
  output** (log only; do not persist into dialog history/events) and retries.
- After 3 failed attempts, the driver triggers **Q4H** with `kind=context_health_critical`, and the
  dialog becomes **suspended** (driver stops attempting generations).

## UI (Webapp) Expectations

### “Context health” indicator (high priority)

Show a small, always-visible indicator in the dialog UI that includes:

- Prompt tokens for the last turn (or “unknown”)
- Percent of model context limit (`context_length`)

Suggested visual states:

- **Healthy** (green)
- **Caution** (yellow)
- **Critical** (red)
- **Unknown** (gray)

### Q4H(kind=context_health_critical) send gating

When a dialog is suspended for `kind=context_health_critical`, WebUI must disable sending for that
kind (do not allow “answering” it as a normal Q4H).

## Implementation Outline

1. Refactor LLM provider wrappers to return token stats after each generation (including prompt
   token count when the provider reports it).
2. Thread usage stats into the dialog state (persist alongside dialog turns).
3. Implement the context health monitor computation and persist it per generation.
4. Implement v2 remediation (role=user guidance injection + critical forced-clear loop + Q4H(kind)).
5. Add minimal regression guards for the v2 behavior (types + gating).

## Acceptance Criteria

- After every LLM generation, Dominds records token usage stats (or “unavailable”) with the turn.
- Context health thresholds:
  - `optimal_max_tokens` defaults to `100_000` when not configured.
  - `critical_max_tokens` defaults to `floor(modelContextLimitTokens * 0.9)` when not configured.
- v2 remediation:
  - `caution`: driver injects role=user guidance for the next generation turn only (non-persisted),
    offering exactly two choices (clear_mind vs add_reminder) with the same re-entry package content.
    If not cleared, re-inject every 10 generation turns while still caution.
  - `critical`: driver enforces a forced-clear loop (max 3 attempts). If no valid clear_mind call is
    present, discard output (log only; no persistence). After 3 failures, fire
    Q4H(kind=context_health_critical) and suspend the dialog; WebUI disables send for that kind.
- UI shows context health with green/yellow/red (and “unknown” handling when usage is unavailable).
