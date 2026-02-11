# FBR Implementation Details (Implemented)

Chinese version: [中文版](./fbr-implementation.zh.md)

This doc records the implemented structure and constraints. The normative spec is `fbr.md`.

## Implementation principles

- FBR and non-FBR use the same context assembly pipeline; differences must be explicit policy fields only.
- The FBR system prompt body must contain no tool instructions; tool availability is expressed only by a separate notice.
- Tool/tellask restrictions are enforced technically at runtime, not by prompt wording alone.

## Code structure

### 1) Unified drive policy (`main/llm/driver.ts`)

Before each generation, runtime builds a `DrivePolicy` that centralizes:

- `effectiveSystemPrompt`
- `effectiveAgentTools`
- `prependedContextMessages`
- `tellaskPolicy`
- `allowFunctionCalls`

For FBR policy, runtime:

- uses `buildFbrSystemPrompt(...)` (no tool instructions)
- injects a separate `buildNoToolsNotice(...)`
- forces `effectiveAgentTools = []`
- forces `tellaskPolicy = deny_all`
- forces `allowFunctionCalls = false`
- applies `fbr_model_params` override when configured

### 2) Unified context assembly (`main/llm/driver.ts`)

`buildDriveContextMessages(...)` assembles context for both FBR and non-FBR. FBR does not use ad-hoc `unshift/push` special-cases in the main flow; it only differs via policy-provided `prependedContextMessages`.

### 3) Unified violation gate (`main/llm/driver.ts`)

Both streaming and non-streaming paths call `resolveDrivePolicyViolationKind(...)` to detect:

- disallowed tellask-special function calls (FBR technical mode disallows all function calls)
- disallowed tool/function calls (FBR disallows all)

On violation, runtime emits `formatDomindsNoteFbrToollessViolation(...)` consistently.

### 4) FBR isolation invariant gate (`main/llm/driver.ts`)

Before generation, runtime runs `validateDrivePolicyInvariants(...)` and fail-fast checks:

- system prompt must exactly equal `buildFbrSystemPrompt(...)`
- `effectiveAgentTools` must be empty
- `allowFunctionCalls` must be `false`
- `tellaskPolicy` must be `deny_all`
- `prependedContextMessages` must contain exactly one `buildNoToolsNotice(...)`

If any check fails, runtime throws `FBR policy isolation violation`, preventing global tool-manual/tool-prompt paths from leaking into FBR.

### 5) Single-source no-tools notice (`main/minds/system-prompt-parts.ts`)

`buildNoToolsNotice(...)` is the only tool-availability wording source, fixed to:

- no tools available / do not call tools
- no access to rtws / files / browser / shell

## Related modules

- `main/llm/driver.ts`: policy, context assembly, violation enforcement
- `main/minds/system-prompt-parts.ts`: no-tools notice generator
- `main/agent-priming.ts`: FBR prompt text cleanup (no tool-list guidance inside FBR prompts)

## Acceptance checklist

- FBR system prompt has no tool instructions.
- Tool-related wording appears only in the separate `buildNoToolsNotice(...)`.
- FBR/non-FBR context assembly flow is structurally identical; only policy fields differ.
- Any FBR tool/function call or tellask-special function call is hard-rejected with explicit feedback.
