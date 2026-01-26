# Context Health Monitor

This document specifies a **context health monitor** feature for Dominds: a small, always-on signal
that helps the agent (and user) avoid degraded performance when the conversation’s prompt/context is
getting too large relative to the model’s context window.

## Current Code Reality (as of now)

Dominds already has:

- **Reminders** on the dialog object (`Dialog.addReminder`, `Dialog.processReminderUpdates`)
- A first-class **ReminderOwner** mechanism (`ReminderOwner.updateReminder` → `drop|keep|update`)
- Model metadata that includes a per-model **context length** (`context_length` in `dominds/main/llm/defaults.yaml`)
- A config surface for **`optimal_max_tokens`** and **`critical_max_tokens`** (optional per-model fields)

Dominds does **not** yet have:

- A normalized, persisted **token usage record** per generation (streaming generators currently do
  not plumb token usage into dialog state).

## Goals

- Collect **token usage stats** from LLM provider wrappers after each generation.
- Compute a simple **context health** signal from provider stats + model metadata.
- When the dialog context is “too large”, add a **reminder** urging the agent to “clear its mind”.
  - Dominds does not auto-compact context.
  - The safe workflow is: distill important information into the Taskdoc and/or reminders, then call
    the function tool `clear_mind({ "reminder_content": "" })` to restart with minimal context.
- Avoid reminder spam via a **reminder owner** mechanism; stop reminding once the dialog is back in a
  healthy range.
- When the dialog is **critical** for too long, enforce stability via a **generation-turn countdown**:
  - Start a **5 generation-turn** countdown while still critical.
  - Decrement once per generation while still critical.
  - When the countdown reaches **0**, Dominds auto-starts a **new round** (equivalent to `clear_mind`)
    and clears Q4H for stability.

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

### Trigger condition (reminder)

Add a context-health reminder when:

- `level !== 'healthy'`

### Clear condition (stop reminding)

Use the reminder owner mechanism to stop the reminder when the **next dialog round** has:

- `promptTokens < effectiveOptimalMaxTokens`

## Reminder Owner Semantics

Context-health reminders should use the existing `ReminderOwner` mechanism.

- Implement a dedicated `ReminderOwner` with `name: 'context_health'`.
- Owned reminders are **system-managed** and should not include generic “delete this reminder”
  instructions; that guidance is reserved for non-owned reminders only.

Rules:

- If a reminder with owner `context_health` is already present for the dialog, do not emit additional
  reminders each turn.
- When the clear condition is met, drop the reminder by returning `treatment: 'drop'` from
  `updateReminder(...)`.

### Persistence caveat (current implementation)

Reminders are persisted to `reminders.json` including `owner` and `meta` (so owned reminders can be
rehydrated after restart). For owned reminders, the persisted `content` is treated as a snapshot and
must be ignored; owned reminder text should be rendered on-demand via the `ReminderOwner`.

Implication for this feature:

- The context health reminder should be an **owned reminder** (e.g. owner name `context_health`)
  whose content is derived from the latest token stats each time reminders are rendered.

## Reminder copy (UX)

When crossing thresholds, reminders should guide the agent toward safe, low-friction recovery.

### Over optimal (yellow)

- Clarify that `clear_mind` does **not** delete the Taskdoc (`*.tsk/`) and does **not** delete existing
  reminders.
- Encourage the agent to safely clear to reduce context size.
- If the agent still worries about losing context: put a large “safety reminder item” into
  `clear_mind({ "reminder_content": "..." })` so the new round carries key details.

### Over critical (red)

- Use urgent wording: if the agent does not `clear_mind` immediately, the dialog is likely to hit
  technical failures (generation errors, stalls, inability to continue).
- Include the critical countdown and the auto-new-round behavior at countdown 0 so the user is
  informed about the forced stability mechanism.

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

## Implementation Outline

1. Refactor LLM provider wrappers to return token stats after each generation (including prompt
   token count when the provider reports it).
2. Thread usage stats into the dialog state (persist alongside dialog turns).
3. Implement the context health monitor to:
   - compute utilization and levels,
   - manage the `context_health` reminder owner lifecycle.
4. Add a minimal UI indicator that consumes the dialog’s context health state.

## Acceptance Criteria

- After every LLM generation, Dominds records token usage stats (or “unavailable”) with the turn.
- Context health thresholds:
  - `optimal_max_tokens` defaults to `100_000` when not configured.
  - `critical_max_tokens` defaults to `floor(modelContextLimitTokens * 0.9)` when not configured.
- When `level !== 'healthy'`, the agent receives a context-health reminder (once per active condition
  via reminder owner), with distinct copy for over-optimal vs over-critical.
- The reminder is automatically cleared once a subsequent round’s prompt tokens are below
  `effectiveOptimalMaxTokens`.
- UI shows context health with green/yellow/red (and “unknown” handling when usage is unavailable).
