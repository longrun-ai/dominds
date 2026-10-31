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
```

- `test`: a small local smoke suite; not full product, browser, packaging, or provider coverage.
- `test:kernel`: discovers TypeScript cases under `kernel-driver/`, excluding its helper. Each runs in an isolated rtws. Failures do not prevent subsequent cases. `kernel-driver:integration` delegates here.
- `test:context`: runs six state/data regressions for generation-boundary eligibility and language fallback, preservation cadence, user interjections, continuation-body fidelity, retry budgets, and exhaustion notices. It does not judge wording.
- `test:configuration`: six isolated regressions for team configuration, capability boundaries, manual payload fidelity, MCP reload and Problems lifecycle. Only external MCP peers are replaced; no live providers or installed components are required.
- `test:manual`: six isolated cases for language normalization, actual mind assets and skill scope/permissions, snippet paths, manual visibility and the original prose budget.
- `test:types`: the full test-directory type check. During remediation it still reports inherited contract drift; that failure is tracked separately and is not a pass.
- `test:inventory`: sources, support files, discovered suites, outside-suite candidates, and candidates without package scripts. These counts are not behavior coverage. Unknown candidates can be live probes or external integrations; inspect prerequisites before executing them.
- `test:runner`: verifies failure continuation, timeouts, evidence retention, cleanup, and discovery.
- `test:semantic`: emits actual natural-language output, context, business value, and review questions. Evidence is **pending subjective review by a test-execution agent**, not automatically passed.
- `test:semantic:context`: emits preservation, interjection, new-course, continuation, and routing guidance. Its budget notices come from real isolated runtime executions with observed state, not a synthetic expected sentence. All cases remain pending subjective review.
- `test:semantic:configuration`: reruns the configuration scenarios with `--semantic` and emits full diagnostics, manual guidance and supplied configuration. It reports pending review, including when its machine assertions pass.
- `test:semantic:manual`: emits actual handbooks, capability-list and refusal guidance, Taskdoc/skills guidance, collaboration result wrappers and the built-in manager prompt. All cases start pending subjective review.

- `test:semantic:kernel`: runs explicit producers for actual provider reminder context, repeated-call guidance and stops, reply-tool errors and expiration, human-answer follow-up queues, reply/footer renderers, context renewal, nested delivery, registered-assignment updates, tight-context result visibility, real tool-loop transitions, queued user interjections, FBR phases/closure and empty-response retry recovery. Their complete output remains pending agent review even when runtime assertions pass.

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
