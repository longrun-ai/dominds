# Dominds tests

Tests protect business outcomes: execution and collaboration, recovery, human intent, capability boundaries, and inspectable state. See the [test design and remediation plan](../docs/testing-strategy.md).

## Executable entry points

From the repository root:

```bash
pnpm test
pnpm run test:kernel
pnpm run test:context
pnpm run test:configuration
pnpm run test:manual
pnpm run test:types
pnpm run test:inventory
pnpm run test:runner
pnpm run test:semantic
pnpm run test:semantic:context
pnpm run test:semantic:configuration
pnpm run test:semantic:manual
pnpm run test:semantic:kernel
pnpm run test:filesystem
pnpm run test:semantic:filesystem
pnpm run test:persistence
pnpm run test:semantic:persistence
pnpm run test:recovery
pnpm run test:semantic:recovery
pnpm run test:bootstrap
pnpm run test:semantic:bootstrap
```

- `test`: a small local smoke suite; not full product, browser, packaging, or provider coverage.
- `test:kernel`: discovers TypeScript cases under `kernel-driver/`, excluding its helper. Each runs in an isolated rtws. Failures do not prevent subsequent cases. `kernel-driver:integration` delegates here.
- `test:context`: runs eight local cases for generation-boundary eligibility/language fallback, public preservation/countdown decisions, supplied continuation-body fidelity, retry preparation, real budget consumption/manual continuation, exhaustion notices and global event forwarding. Policy/forwarding components do not establish actual WebSocket user delivery or side-dialog creation; actual critical-turn and queued-message driving is exercised by `test:kernel`.
- `test:configuration`: seven isolated regressions for team configuration, extension rules against actual file access, capability boundaries, manual payload fidelity, MCP reload and Problems lifecycle. Only external MCP peers are replaced; no live providers or installed components are required.
- `test:manual`: six isolated cases for language normalization, actual mind assets and skill scope/permissions, snippet paths, manual visibility and the original prose budget.
- `test:types`: the full test-directory type check. During remediation it still reports inherited contract drift; that failure is tracked separately and is not a pass.
- `test:inventory`: sources, support files, discovered suites, outside-suite candidates, and candidates without package scripts. These counts are not behavior coverage. Unknown candidates can be live probes or external integrations; inspect prerequisites before executing them.
- `test:runner`: verifies failure continuation, timeouts, evidence retention, cleanup, and discovery.
- `test:semantic`: emits actual natural-language output, context, business value, and review questions. Evidence is **pending subjective review by a test-execution agent**, not automatically passed.
- `test:semantic:context`: three producers emit thirty preservation, interjection, new-course, continuation/routing and actual budget-notice cases. The notices include zero initial allowance in both languages and two consumed nudges through streaming/batch execution. Every actual output remains pending subjective review after generation.
- `test:semantic:configuration`: reruns the configuration scenarios with `--semantic` and emits full diagnostics, manual guidance and supplied configuration. It reports pending review, including when its machine assertions pass.
- `test:semantic:manual`: emits actual handbooks, capability-list and refusal guidance, Taskdoc/skills guidance, collaboration result wrappers and the built-in manager prompt. All cases start pending subjective review.

- `test:semantic:kernel`: runs explicit producers for actual provider reminder context, repeated-call guidance and stops, reply-tool errors and expiration, human-answer follow-up queues, reply/footer renderers, context renewal, nested delivery, registered-assignment updates, tight-context result visibility, real tool-loop transitions, queued user interjections, FBR phases/closure and empty-response retry recovery, synchronous ask-back result pointers, reply-delivery rejections and local human interjection/tool-follow-up guidance. Their complete output remains pending agent review even when runtime assertions pass.

- `test:filesystem`: public path/extension decision APIs and direct tools against real files, symlinks and dialog pad objects; includes preview non-effects, pad lifecycle/scope, occurrence-plan ownership and drift guards, scoped team edits, exact editing results and output budgets. These cases use the host filesystem and do not establish a full sandbox, other-platform behavior or provider compliance.
- `test:semantic:filesystem`: emits actual creation/overwrite refusal and recovery, link operations, edit plans, pad projection/cleanup, proposed edits and clipped tool output. Generation success leaves every semantic case pending subjective review.

- `test:persistence`: nineteen isolated cases for actual final disk snapshots, thinking/reasoning stream and replay, requester JSONL stacks, canonical/cross-course results, unpaired-history preservation, status moves, quarantine/failure recovery, reminder owner recovery in an independent process, active-course reminder writes, fork anchors and priming data. Other component cases do not claim full driver restart, live providers or actual Windows behavior; I/O fault injection is explicit.
- `test:semantic:persistence`: emits actual ambiguous-stack-update, occupied-status-destination, incomplete cross-course carryover and quarantine diagnostics after preserving the corresponding state. Every output starts pending subjective review.

- `test:recovery`: six isolated cases include actual owned-process SIGKILL at an observed durable root/side generation boundary, a new recovery process and an independent parent disk verifier. Run-control snapshot healing and startup recovery use fresh fixtures so one cannot pre-heal the other. It also checks finalized/transient retry-resume eligibility, stale cues, live reply repair, execution-lock serialization, persisted human-wait gating and five seeded reply states. Explicit resume remains required where appropriate. Component fixtures do not establish real human-answer UI; seeded reply states do not establish abrupt kill, and no case proves power-loss/fsync or live-provider compliance.
- `test:semantic:recovery`: four producers emit nine actual reply acknowledgements and corrupt-question diagnostics with their observed delivery/state context. Generation leaves subjective acceptance pending.

- `test:bootstrap`: seven local cases for actual CLI processes, workspace argument parsing, caller argv identity, forwarding proxy configuration through the Node API boundary, team-validation exit codes, dotenv data/precedence/errors and environment-tool mutations/refusals. It uses isolated workspaces and synthetic environment values; does not prove actual proxy routing, MCP server availability, shell/OS persistence or automatic reload after changing environment variables.
- `test:semantic:bootstrap`: three producers emit nine actual manual/help, team-validation and environment-tool outputs. Complete texts and their scenarios require subjective review; exit-code success and evidence generation do not judge their meaning.

The [assertion audit ledger](./audit.json) records which candidate tests have actually been reviewed, their business value, lane and evidence. Inventory exposes unaudited candidates and stale ledger paths. Neither suite membership nor a prior ledger entry decides the meaning of freshly generated output.

Place new shared helper modules in `tests/helpers/`; the remaining files in the discovered kernel directory are executable cases, not helper-only modules that can exit without assertions.

Suites execute sequentially with a 60-second limit per case. Logs and `summary.json` live in the printed evidence directory. Failed and timed-out cases retain temporary state; successful behavior cases clean it. Configuration evidence generation also preserves successful material, continues after individual process failures, and reports process completion separately from pending semantic acceptance. Failures and timeouts make the suite return nonzero. Increasing a timeout is not a fix for a failed business assertion.

## Individual cases and rtws isolation

```bash
pnpm -C tests run
pnpm -C tests run auth
pnpm -C tests run llm-generation-metadata
pnpm -C tests run webapp-create-dialog-flow-ime
pnpm -C tests run rtws -- kernel-driver/runtime-reminder-context.ts
```

The rtws CLI copies `tests/script-rtws` into an independent temporary directory. Failed isolated CLI runs retain their workspace automatically. Set `DOMINDS_TEST_RTWS_KEEP_TMP=1` to also retain successful single-case evidence. `--shared-rtws` is for debugging and must not run concurrently.

Scripts resolve repository-internal contracts through `tests/tsconfig.json`. Direct `tsx` invocation from the root needs `--tsconfig tests/tsconfig.json`. Relative imports resolve from the source file; the runtime's rtws is fixed at startup, so changing `process.cwd()` afterward does not relocate an initialized runtime.

## Acceptance rules, including future tests

Literal matching is never a semantic oracle. Do not use keywords, regexes, fixed sentences, snapshots, or source snippets to judge the meaning of prompts, manuals, guidance, or explanations. Delete low-value checks; valuable semantic requirements emit full actual output and context for subjective agent review. Keep the verdict, reasons, and evidence. Unreviewed output stays pending. Exact assertions are for real machine contracts, identifiers, state, counts, and effects, not disguised natural-language judgments.

Review added and changed assertions before accepting tests and again before committing. A semantic literal-match assertion blocks acceptance. Do not replace that review with a keyword-based detector. The inherited tests still require the staged audit described in the remediation plan; rediscovery does not certify their design.

Keep accepted semantic review records under `tests/semantic/reviews/`, including per-case rationale, scope, and evidence/source provenance. Generated text can be recreated from the reviewed revision; hashes only identify that material. These records are review evidence, never golden snapshots or an oracle for accepting future wording. A fresh generation starts pending review even when an older record passed.

## Separate verification scopes

Local deterministic behavior, distribution contracts, necessary structure checks, external component integration, browser interaction, live providers, and platform-specific verification have different prerequisites. Missing prerequisites and unexecuted scenarios must not count as passes. Source-string checks and UI helper tests do not establish end-to-end behavior. Live probes make real API calls and are not automatically selected by smoke or kernel suites.
