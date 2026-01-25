# Context Health Monitor

This document specifies a **context health monitor** feature for Dominds: a small, always-on signal
that helps the agent (and user) avoid degraded performance when the conversation’s prompt/context is
getting too large relative to the model’s context window.

## Current Code Reality (as of now)

Dominds already has:

- **Reminders** on the dialog object (`Dialog.addReminder`, `Dialog.processReminderUpdates`)
- A first-class **ReminderOwner** mechanism (`ReminderOwner.updateReminder` → `drop|keep|update`)
- Model metadata that includes a per-model **context length** (`context_length` in `dominds/main/llm/defaults.yaml`)

Dominds does **not** yet have:

- A normalized, persisted **token usage record** per generation (streaming generators currently do
  not plumb token usage into dialog state).
- A config surface for **`optimal_max_tokens`** (this doc proposes adding it as an optional field).

## Goals

- Collect **token usage stats** from LLM provider wrappers after each generation.
- Compute a simple **context health** signal (percent-of-limit) from provider stats + model metadata.
- When the dialog context is “too large”, add a **reminder** urging the agent to “clear its mind”
  (Dominds does not auto-compact context: distill important information into the Taskdoc and/or reminders, then call the function tool `clear_mind({ "reminder_content": "" })` to restart with minimal context).
- Avoid reminder spam via a **reminder owner** mechanism; stop reminding once the dialog is back in a
  healthy range.

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
- **`optimal_max_tokens`**: an optional per-model “soft ceiling” for prompt/context size.
  - If explicitly configured, Dominds uses it directly.
  - If not configured, Dominds treats it as **50% of the model hard context limit**
    (`floor(modelContextLimitTokens * 0.5)`).

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

### Where token usage should be sourced in current Dominds

Today’s streaming generators do not surface usage into dialog state:

- `dominds/main/llm/gen/anthropic.ts` receives streaming events where usage exists (see “Usage info
  captured but not currently used”) but does not propagate it.
- `dominds/main/llm/gen/codex.ts` similarly streams without persisting a usage summary.

This feature therefore requires a small API addition between:

- `LlmGenerator.genToReceiver(...)` (generator)
- `LlmStreamReceiver` / `llm/driver.ts` (driver)
- dialog persistence + UI events (state propagation)

### Persistence strategy (based on current storage types)

Current persistence has no “usage per generation” record. The cleanest options are:

- Extend `GenFinishRecord` (or add a new `gen_usage_record`) in
  `dominds/main/shared/types/storage.ts`, then append it from `llm/driver.ts` when the generator
  yields usage.
- Avoid encoding usage into reminder text; reminders are user-facing and shouldn’t carry telemetry.

## Health Computation

Dominds computes two utilization ratios:

- `hardUtil = promptTokens / modelContextLimitTokens`
- `optimalUtil = promptTokens / effectiveOptimalMaxTokens`

Where:

- `effectiveOptimalMaxTokens = optimal_max_tokens ?? floor(modelContextLimitTokens * 0.5)`

### Trigger condition (reminder)

Add a “clear your mind” reminder when **either** is true:

- `hardUtil > 0.50` (prompt exceeds 50% of the model context window)
- `promptTokens > effectiveOptimalMaxTokens` (prompt exceeds the optimal ceiling; defaults to 50% of
  hard max when not configured)

Rationale:

- `optimal_max_tokens` lets a team choose a lower operational ceiling (quality/latency/cost) while
  still respecting the model’s real limits.

### Clear condition (stop reminding)

Use the reminder owner mechanism to stop the reminder when the **next dialog round** has:

- `promptTokens < effectiveOptimalMaxTokens`

This uses the default `effectiveOptimalMaxTokens = 50% of hard max` when `optimal_max_tokens` is not
explicitly configured.

## Reminder Owner Semantics

Context-health reminders should use the existing `ReminderOwner` mechanism.

- Implement a dedicated `ReminderOwner` with `name: 'context_health'`.

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

## UI (Webapp) Expectations

### “Context health” indicator (high priority)

Show a small, always-visible indicator in the dialog UI that includes:

- Prompt tokens for the last turn (or “unknown”)
- Percent of model context limit (`context_length`)

Suggested visual states:

- **Healthy**: prompt tokens ≤ `effectiveOptimalMaxTokens`
- **Caution**: prompt tokens > `effectiveOptimalMaxTokens`

### Extra context stats (low priority)

Potential additional signals to surface later:

- Number of turns/messages in the dialog
- Count/size of large tool outputs included in context
- “Recent tool activity” footprint (e.g., last N tool results included)

## Implementation Outline

1. **Refactor LLM provider wrappers** to return token stats after each generation (including prompt
   token count when the provider reports it).
2. Thread usage stats into the dialog state (persist alongside dialog turns).
3. Implement the **context health monitor** to:
   - compute utilization,
   - manage the `context_health` reminder owner lifecycle.
4. Add a minimal UI indicator that consumes the dialog’s context health state.

## Acceptance Criteria

- After every LLM generation, Dominds records token usage stats (or “unavailable”) with the turn.
- When prompt tokens exceed 50% of the model limit, or exceed `effectiveOptimalMaxTokens`, the agent
  receives a “clear your mind” reminder (once per active condition via reminder owner).
- The reminder is automatically cleared once a subsequent round’s prompt tokens are below
  `effectiveOptimalMaxTokens`.
- UI shows context health as a percentage with “unknown” handling when usage is unavailable.
