# LLM Provider Isolation

## Principle

Dominds treats each LLM provider wrapper as an isolated protocol adapter, not as a flavor of a shared "OpenAI-like" abstraction.

This means:

- `apiType: codex` owns Codex-native request fields, stream events, tool semantics, and defaults.
- `apiType: openai` owns OpenAI Responses request fields, stream events, tool semantics, and defaults.
- `apiType: openai-compatible` owns Chat Completions semantics, including the `model_params.openai-compatible.*` namespace.
- `apiType: anthropic` owns official Anthropic Messages semantics, including object-shaped `model_params.anthropic.thinking`.
- `apiType: anthropic-compatible` owns Anthropic-compatible gateway semantics, including boolean `model_params.anthropic-compatible.thinking` mapped to provider `enabled` / `disabled` request objects.

Some providers expose OpenAI-compatible or Anthropic-compatible endpoints while still requiring an explicit provider quirk profile. Volcano Engine Ark Coding Plan is the canonical example: its OpenAI-compatible integration reuses the Chat Completions transport shape, but `thinking`, `reasoning_content`, tool-call/thinking alternation, `<think>` compatibility, and model capability metadata must stay inside the `volcengine-coding-plan` quirk instead of becoming generic `openai-compatible` semantics. See [`volcengine-coding-plan-openai-compatible.zh.md`](./volcengine-coding-plan-openai-compatible.zh.md) for the design record.

Similar field names across wrappers do not imply compatibility. For example, `reasoning_effort`, `verbosity`, `parallel_tool_calls`, and web search controls may look similar but can still differ in accepted values, payload shape, lifecycle events, validation rules, and runtime meaning.

## Hard Rules

- A wrapper must only read its own provider namespace when building requests.
- A wrapper must only interpret its own provider-native stream events.
- A wrapper must not silently fall back to another provider's params, aliases, or event assumptions.
- Cross-provider convergence is allowed only at the driver/storage/UI boundary, after provider-native events have already been decoded into discriminated unions.

## Why

This isolation keeps provider integrations honest:

- fewer accidental "compatible by coincidence" behaviors
- easier debugging when providers diverge
- less hidden coupling between wrappers
- safer upgrades when official APIs evolve independently

## Current Boundary

The backend currently uses provider-specific web search event variants inside wrappers and projects them into a narrower dialog event shape in `main/llm/kernel-driver/drive.ts`.

That projection layer is intentional: it is the compatibility boundary. Wrapper code on either side should stay provider-native.
