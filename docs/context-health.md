# Context Health Monitor

Chinese version: [中文版](./context-health.zh.md)

This document specifies a **context health monitor** feature for Dominds: a small, always-on signal
that helps the agent (and user) avoid degraded performance when the dialog’s prompt/context is
getting too large relative to the model’s context window.

## Current Code Reality (as of 2026-01-28)

Dominds already has:

- A **provider usage stats** path (per generation) from the LLM wrappers.
- A computed and persisted **context health snapshot** per generation turn (derived from usage +
  per-model metadata).
- A minimal **UI indicator** surface consuming the dialog’s context health state.

## Goals

- Collect **token usage stats** from LLM provider wrappers after each generation.
- Compute a simple **context health** signal from provider stats + model metadata.
- When the dialog context is “too large”, enforce a **v3 remediation** workflow that is short,
  executable, and regression-testable:
  - In **caution**, record an auto-inserted **role=user prompt** as a normal, persisted user message
    (UI-visible and rendered as a normal user instruction).
  - In **critical**, enforce stability via a **countdown remediation** (max 5 turns):
    - Each turn injects a **recorded role=user prompt** (UI-visible as a user prompt) that instructs
      the agent to curate reminders (`update_reminder`/`add_reminder`) and then `clear_mind`.
    - The prompt includes a countdown signal (how many reminders remain before auto-`clear_mind`).
    - When the countdown reaches 0, Dominds **automatically** executes `clear_mind` (no Q4H; no
      suspension) to keep long-running autonomy stable.

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

- **`caution_remediation_cadence_generations`**: optional per-model cadence for caution remediation guidance.
  - If explicitly configured, Dominds uses it directly.
  - If not configured, Dominds defaults to **10 generations**.

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

## v3 Remediation Semantics (Driver-enforced)

### Continuation package (“接续包”)

The remediation workflow centers around a _continuation package_ (a scannable, actionable bundle of
context that survives a new course).

Recommended structure (multi-line; scale by task size; focus on details not covered in Taskdoc):

- First actionable step
- Key pointers (files/symbols/search terms)
- Run/verify (commands, ports, env vars)
- Easy-to-lose ephemeral details (paths/ids/urls/sample inputs)

### Caution (yellow)

When `level === 'caution'`, the driver auto-inserts a **role=user** guidance prompt into the _next_
LLM generation turn, and **persists it as a normal user message** so the UI renders it as a normal
user instruction.

Current behavior:

- On entering `caution`, Dominds inserts the prompt once (entry injection).
- While still `caution`, Dominds reinserts the prompt on a cadence (default: every **10**
  generations; configurable per model).
- Each inserted prompt requires the agent to **curate reminders** (at least one call):
  - `update_reminder` (preferred) / `add_reminder`
  - Maintain a continuation-package draft inside reminders
  - Then `clear_mind` when it becomes scannable/actionable

### Critical (red)

When `level === 'critical'`, the driver enters a **countdown remediation** (max **5** turns):

- On each turn, the driver records a **role=user prompt** (persisted as a user message) that is
  visible in the UI as a user prompt. This prompt tells the agent to:
  - curate reminders via `update_reminder` / `add_reminder` (best-effort continuation package), and
  - then call `clear_mind` to start a new course.
- The prompt includes a countdown: after **N** turns the system will automatically clear.
- When the countdown reaches 0, the driver **automatically calls** `clear_mind` (with empty args; no
  requirement on `reminder_content`), starting a new course without suspending.

Rationale:

- `caution` already Diligence Pushes best-effort continuation package drafting in reminders.
- In `critical`, we prefer to keep the dialog running long-term without human intervention.

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

Note (zh UI copy):

- `caution` → “吃紧”
- `critical` → “告急”

## Implementation Outline

1. Refactor LLM provider wrappers to return token stats after each generation (including prompt
   token count when the provider reports it).
2. Thread usage stats into the dialog state (persist alongside dialog turns).
3. Implement the context health monitor computation and persist it per generation.
4. Implement v3 remediation (persisted role=user prompt insertion + caution reminder-curation cadence + critical countdown + auto clear_mind).
5. Add minimal regression guards for the v3 behavior (types + gating).

## Acceptance Criteria

- After every LLM generation, Dominds records token usage stats (or “unavailable”) with the turn.
- Context health thresholds:
  - `optimal_max_tokens` defaults to `100_000` when not configured.
  - `critical_max_tokens` defaults to `floor(modelContextLimitTokens * 0.9)` when not configured.
- v3 remediation:
  - `caution`: driver inserts a persisted role=user prompt (UI-visible user instruction).
    On entering `caution` it inserts once; while still `caution` it reinserts on a cadence (default: every
    10 generations; configurable per model). Each time, the agent must call at least one of
    `update_reminder` / `add_reminder` and maintain a continuation-package draft, then `clear_mind` when ready.
  - `critical`: driver runs a countdown remediation (max 5 turns) using **recorded role=user prompts**.
    Each prompt includes a countdown and instructs reminder curation + `clear_mind`. When the countdown
    reaches 0, the driver auto-executes `clear_mind` and starts a new course (no Q4H, no suspension).
- UI shows context health with green/yellow/red (and “unknown” handling when usage is unavailable).
