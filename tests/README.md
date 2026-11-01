# Dominds tests

Tests protect business outcomes: execution and collaboration, recovery, human intent, capability boundaries, and inspectable state. See the [test design and remediation plan](../docs/testing-strategy.md).

## Executable entry points

From the repository root:

```bash
pnpm test
pnpm run test:kernel
pnpm run test:context
pnpm run test:configuration
pnpm run test:apps:configuration
pnpm run test:manual
pnpm run test:types
pnpm run test:inventory
pnpm run test:runner
pnpm run test:semantic
pnpm run test:semantic:context
pnpm run test:semantic:configuration
pnpm run test:semantic:apps:configuration
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
pnpm run test:packaging
pnpm run test:semantic:packaging
pnpm run test:retry
pnpm run test:semantic:retry
pnpm run test:projection
pnpm run test:semantic:projection
pnpm run test:compatible
pnpm run test:semantic:compatible
pnpm run test:reminders
pnpm run test:semantic:reminders
pnpm run test:daemon
pnpm run test:semantic:daemon
pnpm run test:presentation
pnpm run test:semantic:presentation
pnpm run test:components
pnpm run test:semantic:components
pnpm run test:shell
pnpm run test:semantic:shell
pnpm run test:taskdoc
pnpm run test:semantic:taskdoc
pnpm run test:provider-local
pnpm run test:semantic:provider-local
pnpm run test:server-local
pnpm run test:semantic:server-local
pnpm run test:provider-live
```

- `test`: a small local smoke suite; not full product, browser, packaging, or provider coverage.
- `test:kernel`: discovers TypeScript cases under `kernel-driver/`, excluding its helper, and the registered-session dedupe case under `tellask/`. The latter verifies same-generation worker reuse, completed result delivery, preserved history and replacement under a durable dead marker; it does not exercise the WebSocket cancellation pipeline. Each runs in an isolated rtws. Failures do not prevent subsequent cases. `kernel-driver:integration` delegates here.
- `test:context`: runs eight local cases for generation-boundary eligibility/language fallback, public preservation/countdown decisions, supplied continuation-body fidelity, retry preparation, real budget consumption/manual continuation, exhaustion notices and global event forwarding. Policy/forwarding components do not establish actual WebSocket user delivery or side-dialog creation; actual critical-turn and queued-message driving is exercised by `test:kernel`.
- `test:configuration`: seventeen isolated regressions for team configuration, extension rules against actual file access, capability boundaries, manual payload fidelity, MCP reload and Problems lifecycle. Only external MCP peers are replaced; no live providers or installed components are required.
- `test:apps:configuration`: eleven explicit compatibility cases for real local package resolution/install/enable/disable, dependency effective flags and recovery, occupied/duplicate frontend ports, conditional disk writes, Problems lifecycle and teammate override precedence through a cyclic package graph, plus CLI discovery/refusal, read-only doctor field mismatches/self-target and real member-template installation. Local bins, disk, TCP listeners and resolution stay real; no registry request, host startup or browser interaction is claimed.
- `test:semantic:apps:configuration`: eight producers emit actual command receipts and resolution/Problems diagnostics for separate subjective review. The [App configuration review](./semantic/reviews/2026-10-31-app-resolution.json) preserves its complete output and evidence scope; the [CLI/doctor review](./semantic/reviews/2026-10-31-app-doctor.json) adds eight actual command/diagnosis materials from a separately locked producer epoch. Every fresh run starts pending.
- `test:manual`: eight isolated cases for language normalization, actual mind assets and skill scope/permissions, snippet paths, manual visibility and the original prose budget.
- `test:types`: checks the full test directory against the current public contracts. Report actual diagnostics as failures; do not weaken types or exclude cases to obtain a green result.
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

- `test:packaging`: five sequential cases. Two pack the real root/kernel/shell/auth packages and consume them from independent temporary installations. Native CJS/ESM and TypeScript have no workspace aliases; the CJS/ESM entry probes have no `NODE_PATH`, loader options or executable search path. Public/private import effects, CLI startup, actual certificate/key compatibility and packed WebUI HTTP resource bytes are machine outcomes. Machine completion packets after every native action prevent an unresolved async main from exiting zero and being counted as a pass. Missing-package controls verify that runtime/type consumers cannot silently use checkout sources. Run `pnpm run build` first; pinned pnpm, POSIX `tar` and the existing installed dependency set are required. Third-party dependencies are supplied by explicit links; workspace packages always come from their tarballs. This is not a registry install, actual publish/browser authentication, browser interaction or model-quality test. Three further cases protect a source-only public type consumer, actual manifest parsing, archive drift and release control/cache recovery. Release cases execute the declared root scripts and four actual prepublish recipes in owned Git workspaces; npm/pnpm peers are controlled and executable search is closed, while Git, tar and cache writes remain real. Those cases require POSIX shell, Git and gzip too. The [initial assertion review](./audits/2026-10-31-packaging.json) maps the nine retired scans/metadata recipes; the [public-contract review](./semantic/reviews/2026-10-31-public-contracts.json) records the subsequent boundary cases and product fixes.

- `test:semantic:packaging`: three explicit producers emit 32 manifest refusals, four actual archive-drift diagnostics and sixteen controlled release/guard refusals. Semantic generation retains successful artifacts and starts pending; process success is never a subjective verdict. Public title/fallback export shape checks do not judge their natural-language content.

- `test:retry`: three isolated cases. The policy case retains 21 original classification/quirk components; two runtime cases preserve the remaining 21 original values with real Dialogs, events, timers and disk generation lifetimes. Known upstream messages are supplied classification data, while emitted guidance has no literal semantic oracle. Scheduled deadlines and real request times verify actual backoff, including the three-second empty-response delay; the normal 60-second case limit is retained. The actual driver sends two persisted Kimi review inputs before the third refusal finalizes a stopped state; separate callback components check reservation rather than claim actual follow-up execution. No SDK network/live-provider coverage is claimed.
- `test:semantic:retry`: three explicit producers emit 14 actual policy decisions, twenty retry/stop/driver outputs and four full empty-burst cases. Generation starts pending; the [batch review](./semantic/reviews/2026-10-31-provider-retry.json) retains the original 42-value map, rejected initial outputs, final subjective verdicts and actual execution scope.

- `test:projection`: seven isolated cases for Responses, Chat Completions-compatible and Anthropic sync/async history construction, image selection and result budgets. History cases preserve supplied data, reasoning, raw malformed arguments and reverse-arriving parallel results; incomplete pairs are rejected without mutating their input. Image cases read distinct real GIF artifacts and compare native payloads, with a missing/restored artifact control and a model-disabled/enabled control. The budget cases exercise current local declared-byteLength policy with small GIFs, not actual 60MiB transport. The truncation case checks configured/default result limits, unchanged source data and real ripgrep YAML metadata through an actual Dialog and file.
- `test:semantic:projection`: seven producers emit twelve actual pairing refusals, six Anthropic history projections, nine image projections and seven truncation outputs (34 total). Generation starts pending. The [history review](./semantic/reviews/2026-10-31-provider-projection.json) and [image/truncation review](./semantic/reviews/2026-10-31-provider-media.json) retain full inputs/text, independent judgments, original values and execution scope. Projection alone does not contact a provider, execute tools, repair history or establish callback/UI routing or visual understanding; only the explicit ripgrep case executes that local tool.

- `test:compatible`: two isolated cases retain the original eight Kimi and eighteen compatible/Volc values. Kimi uses cloned built-in configuration and the real SDK against a local HTTP peer to check headers, options, full normalized schema, source immutability, usage and supplied response data. Deliberately incomplete batch response JSON crosses the same actual SDK boundary; invalid configuration proves zero received requests. Stream components check callback order, supplied chunks/reasoning metadata and invalid-call channels. Debug-capture cases use actual owned files and preserve classification and source cause through a regular-file capture failure. The existing 60-second case bound stays in place.
- `test:semantic:compatible`: two producers emit twelve actual configuration refusals, parser/invalid-call details and capture diagnostics. Generation starts pending; the [batch review](./semantic/reviews/2026-10-31-compatible-provider-contracts.json) retains full output/context, independent verdicts, original values and execution scope. Component stream parsing does not establish actual SDK streaming; local peers do not establish live vendors, tool execution or backend durability.

- `test:reminders`: fourteen isolated behavior cases check actual visible ordering, Main/Side goal boundaries, real body/renderMode preservation, missing IDs and protected manual mutations, sequential stable-ID deletions, actual post-resolution changes and owner failures. State checks include public reminder data/versions and disk. An actual public deletion is interleaved after real resolution; this is a controlled in-process race, not a concurrent drive. Equivalent owner metadata object keys leave public version/renderRevision stable; changed array order and content are positive controls. Actual owner failure propagates its injected cause and emits one stream-error event without publishing a successful reminder snapshot. Unchanged reconciliation may still persist and publish normal snapshots.
- `test:semantic:reminders`: fourteen explicit producers can emit 125 actual cases: 44 public formatter cases, ten actual goals, eight rendering/receipt/refusal cases, nineteen mutation/owner cases twenty bilingual shared-routing/migration and owner-refusal cases, and twenty-four continuation/pending-state cases. The pure formatter producer is support. Meaning is reviewed separately; [initial core evidence](./semantic/reviews/2026-10-31-reminder-core.json) and the [expanded batch review](./semantic/reviews/2026-10-31-reminder-mutation-guards.json) retain full actual output/context, subjective verdicts, assertion review and failure provenance. Fresh generation is pending, never accepted by a previous verdict, hash or ledger. Supplied state/altInstruction does not establish actual pressure, human queues, registered daemon capabilities or maintenance execution. No browser or restart is claimed.

The two shared-reminder cases additionally check task/agent visibility, parsed physical JSON namespaces, exact current recipient IDs/counts, complete runtime-guide envelopes and matching persisted pending prompts/queued-prompt triggers. Actual equivalent owner key order preserves the entire observed queue/pending/nextStep/root-flag state; real owner changes notify the expected peers. Task-to-private migration preserves complete plain reminder data, removes the shared file and visibility, and queues withdrawal only to active original-scope peers. The same real owner-maintained item is refused by the manual migration tool without state changes; shared guidance limits migration suggestions to unrestricted manually maintained items. The fixture explicitly acknowledges observed messages with production clear APIs before the next phase; that acknowledgment establishes neither backend/LLM consumption nor restart delivery. The [shared-routing review](./semantic/reviews/2026-10-31-shared-reminder-routing.json) records the twenty newly generated Chinese/English cases from their two explicit CLI entries, the initially rejected owner-migration guidance and its correction, separately from earlier reviewed core/guard material. Each fresh full-lane generation still needs its own subjective review.

The three continuation/pending-reminder cases check real default-task/private tagging and body/metadata storage from explicitly supplied health snapshots, maximum child-history activity ordering, valid-file preservation on duplicate-session refusal, and zero-state version/data stability. Actual public human-question state can block a zero-tellask dialog while another root retains pending work. The [lifecycle review](./semantic/reviews/2026-10-31-pending-reminder-lifecycle.json) preserves the initial four rejected zero-state messages and the twenty-four new Chinese/English outputs for independent review. State-window guidance covers the current dialog call records and honors valid human/dependency waits. Supplied health/historical/Q4H data do not establish actual pressure classification, a human exchange, provider execution or a process restart.

- `test:daemon`: nine isolated cases with real local child processes, native dialogs/shared files and actual runner IPC. They check timeout-to-background creation, running deletion protection, one-shot owner exit events, saved terminal snapshot retention/manual deletion, stable public versions without output, new-output changes, agent visibility, identity-mismatch refusal with no mis-kill, repaired-identity read/stop controls and matched legacy-wrapper cleanup. Stream selection uses distinct supplied payloads; an owned transparent IPC peer records actual wait requests/replies while forwarding them to the real runner. The child starts explicitly controlled continuous output after request observation; observation does not mean the runner installed its waiter. Requested new stdout returns `output`, unchanged stderr and stderr with unrelated continuing stdout return `timeout`. Machine status/data decides those effects; prose meaning is reviewed separately. Tests synchronize on actual state/file acknowledgments and retain failure workspaces.
- `test:semantic:daemon`: nine explicit producers emit twenty-four Chinese/English actual receipts, renderer/event/snapshot texts, argument refusals and wait notices. The [daemon review](./semantic/reviews/2026-10-31-daemon-lifecycle.json) retains complete actual output/context, individual subjective decisions and original-value/assertion review. Every fresh generation is pending. The standalone start-receipt wording test is retired into actual startup/render/guard behavior and its emitted receipt. The runner exits with its child: these cases checkpoint actual output before observing exit, preserve that record across a failed output read and refused manual edit, and retain last-known data rather than promising unseen final bytes or an unobserved exit code. In-memory registry reset/new dialogs do not prove independent-process restart. Legacy wrapper cleanup is actual termination/drop, not recovered monitoring. Only the execution platform is exercised; Windows process-tree, browser, live-provider and backend delivery remain separate scopes.

- `test:presentation`: six local cases for timestamp ordering/invalid-data fallback, identity and prominent-generation metadata, bounded diagnostic tracing IDs, run-control kinds/counts, four IME-key classification states and teammate/preset fallback selection. Metadata extension identity is loaded from real isolated YAML with unique-provider checks, rather than an unknown-type cast or an unchecked default fallback. Descriptions/default labels are supplied configuration data; exact forwarding is a data contract. These pure selectors/projections do not prove DOM controls, actual IME events, creation requests, permissions or a live provider.
- `test:semantic:presentation`: two support producers emit eighteen actual presentations: four model compact-label/tooltips and fourteen Chinese/English context titles with known/unknown, present/missing/zero usage and supplied health/threshold facts. The [presentation review](./semantic/reviews/2026-10-31-state-presentation.json) preserves actual full text, inputs and subjective judgments. Neither punctuation equality nor keywords judge meaning. The retired UI wording tests and their old aliases now lead to pending evidence; they are not automatic passing cases. Actual configured values, reported model identity and documented defaults must remain distinguishable. Input percentages/levels are not measured or calculated by these cases.

- `test:components`: two explicit compatibility cases. The kernel owner case keeps native dialog/disk/event/registry behavior while controlling its external host client; it preserves plain mode, complete data, one published snapshot, failure identity and state on invalid owned wrappers/positions. The IPC case runs an actual local package entry and host process, checks supplied output/content-item/cross-realm JSON/fractional-position data, rejects malformed arguments/results, and records actual handler entry. Client-side invalid arguments do not reach the component. A returned accessor has its own side-effect marker, which must remain absent after the actual handler ran. Five invalid startup variants prove factory entry, with a separate start marker where relevant, and cannot become ready. These retain current compatibility value during the DSL migration; they do not require the retired App composition root as a destination.
- `test:semantic:components`: emits four bilingual actual owner-wrapper/invariant cases and thirty-five IPC/startup diagnostics. The [component review](./semantic/reviews/2026-10-31-component-boundaries.json) preserves actual output, context and independent subjective verdicts. The host getter/readiness markers are fixture data; errors are judged from their actual meaning, never an error-sentence regex. Declared frontend URLs are not a running HTTP/WebSocket listener, artifact payload references do not establish image decoding/file access, and native store/event checks do not prove browser delivery. The external client is controlled only in the kernel owner case. Its manager name is supplied metadata, not an executed maintenance capability. The deliberately invalid Date input explicitly lies outside JsonValue to exercise the JS runtime boundary; production types and test exclusions are not weakened.

- `test:shell`: nine isolated cases. Captured-shell tests retain the known colour/progress environment policy, mixed-case alias cleanup, source immutability and actual shell_cmd non-TTY JSON data; readonly_shell measures environment data only. Real owned Node programs exercise immediate/250ms completion and stdin EOF without creating a background reminder. Long stdout retains supplied first/last rows, omits middle data, carries numeric truncation metadata and stays bounded; a short result is a positive control. Readonly cases use actual files and an owned Git repository to prove native reads, normalized timeout arguments, reserved-root refusal, nested-root access and blocked writes. Platform-only native readers are explicitly unexecuted elsewhere.
- `test:semantic:shell`: eight producers emit fifty-four actual receipts/diagnostics on the current POSIX lane. The [shell review](./semantic/reviews/2026-10-31-shell-execution.json) retains initial rejected Windows guidance, fresh full text/context, independent judgments and the original assertion/value review. Shared Windows guidance is additionally checked against the actual readonly schema and validation result; that component context does not establish a native Windows tool call. Windows spawn/quoting and stop/output parsing protect supplied command/argv/boolean/PID contracts; they do not execute Windows shells or taskkill. The controlled Windows path-error peer is a real local child with supplied stderr/exit status, not a Windows filesystem. Actual native rg cases check extension/raw-glob effects, native path semantics, 500 real matches, five correct source contexts, empty success, unavailable scope, partial matches and invalid options. An additional filesystem-rg positive/refusal pair covers its public sibling. No global Buffer.concat restriction, private --type/--glob choice, memory benchmark or current-platform result establishes native Windows coverage. Evidence generation remains pending until separately reviewed.

The [tool-data boundary review](./semantic/reviews/2026-10-31-tool-data-boundaries.json) adds five cases to existing lanes: directory and image tools in filesystem, provider listings and availability snapshots in configuration, dedicated memory in manual. Directory checks count actual given filenames and preserve files; a one-file listing is a complete positive control. Provider listing reads actual 240×20 YAML, returns a bounded given-ID subset and retrieves an omitted provider with provider_pattern; long model rows have a separate inline character budget. The snapshot retains the original Main/Side/specialist/direct-binding ID matrix from real Team configuration, without claiming tool execution or authorization enforcement. Pure availability does not generate semantic evidence and still runs through the managed CLI when selected by smoke.

Image cases verify exact work-file bytes, native image-item fields and referenced artifact bytes within the actual dialog event directory. Refused duplicate, signature and existing owned external-image requests preserve files/artifacts and attach no image. They do not prove pixel decoding, vision quality or provider/browser delivery. Memory checks dedicated personal/team file paths and complete given contents despite ordinary file-write restrictions; an owned absolute-path target is refused unchanged. This does not grant memory tools to a caller that lacks them. Four explicit producers add sixteen full actual listing/refusal cases to the corresponding semantic lanes. Each fresh generation remains pending independent subjective review; receipt wording and inline omission explanations are never literal acceptance oracles.

- `test:taskdoc`: three isolated cases protect actual shared section creation/append/recall/replacement/deletion, canonical data, public CRC32 tokens, true same-process conflicting writes, scope/role refusal, discovery and Unicode recall limits. Four Side writes use valid inputs with unchanged package trees and identical successful Main requests; an invalid-input failure cannot stand in for a role guard. Actual prefix-sibling data proves non-injection and refusal preservation. Discovery uses an owned explicit root, real root/nested/default ignores, encapsulation and source-file metadata. Unicode recall independently checks the precise given UTF-8 prefix and its own 100KiB body bound; header/notice overhead has a separate 4KiB ceiling.
- `test:semantic:taskdoc`: two explicit producers emit fifty-four actual bilingual formatter, recovery, missing/invalid/stale, concurrent-conflict and byte-budget cases. The [Taskdoc review](./semantic/reviews/2026-10-31-taskdoc-state.json) retains initial fifty-two records (46 accepted/six rejected), the separately rejected initial Unicode case, fresh verdicts, full input/text and source provenance. Rejected Side guidance mixed unavailable write advice into its status/index; a duplicate-extra recovery example lost category. The real Unicode regression returned the whole120047-byte body while claiming a102400-byte truncation. Current fixes preserve role/schema/CRC rules and restore a complete UTF-8 prefix within the stated byte budget. Exact disk bodies/newline data and technical hash tokens are machine contracts; instruction sentences, headings and display whitespace are not semantic oracles. Source-data preservation is not zero read/write syscalls, independent-process locking, power-loss recovery, LLM consumption or a browser claim. The new recall budget case does not establish the separate whole-Taskdoc injection limit; the original small bearinmind sample establishes selection/order only.

- `test:provider-local`: eleven isolated cases check supplied Anthropic stream data, independent tool blocks, raw malformed arguments, tool-looking text non-execution, whitespace preservation, failures and incomplete lifecycles; Responses whitespace projection; tool-choice policy; Codex instruction input fidelity and built-in configuration; and setup DTO/file effects. The added custom-provider case verifies actual team.yaml data and restores its supplied environment state; the controlled-probe case exercises all eleven entry points against one real localhost OpenAI-compatible SDK peer. Native SDK fixture types replace broad event casts. The service-tier case uses the current Volcano `openai-compatible` namespace, checks configuration-to-DTO label fidelity and preserves failed workspaces. No vendor request is sent.
- `test:semantic:provider-local`: seven explicit producers emit sixty-eight actual instruction, catalog, setup-description, refusal and probe-prerequisite cases for independent review. [The batch record](./semantic/reviews/2026-10-31-provider-local.json) retains full material and review scope. Supplied stream/custom-prompt bytes and label transport from configuration are data contracts; fallback wording, guard instructions, diagnostics and display labels have no literal semantic oracle. The optional reasoning instruction quirk is not evidence of elapsed reasoning time or improved model compliance. Configured capacities are repository data contracts, not independently verified vendor specifications. These cases do not establish actual service-tier availability, billing, SDK streaming transport, browser delivery or live-model behavior.

- `test:server-local`: seven isolated files protect authentication configuration/protocol inputs, certificate creation/lookup/renewal, setup paste data and real dotenv round-trips, actual port selection and WebSocket language packets. Certificate refusal preserves every owned cert/key/metadata byte; force changes actual validity and passes native X509/private-key checks. Port cases retain the default5666 contract, inspect actual bound addresses and complete two local TLS handshakes trusting only the generated certificate and verifying its advertised host. Port subcases share one managed workspace; only `EADDRINUSE` means occupied, and fixture search never reruns failed product behavior. LAN auto-selection uses observed local detection; an unavailable host is a failed prerequisite, not a pass. The setup case uses a dedicated supplied provider environment variable and restores its process value.
- `test:semantic:server-local`: three explicit producers emit sixteen actual auth-token, certificate/CLI and invalid-WebSocket-request diagnostics for independent review. The [server-local record](./semantic/reviews/2026-10-31-server-local.json) retains actual inputs, complete text and scope. Certificate CLI-module tests capture the process-exit/console boundary in-process; root CLI routing is separate. Single-line `cert status --origin` is parsed as machine URL data. Native local TLS does not establish browser trust or remote LAN access; native request fixtures do not establish an HTTP authentication exchange; a real `ws` client does not establish browser rendering or live-dialog language mutation. The first rewritten certificate case incorrectly expected localhost despite discovered LAN addresses; its failure is preserved as a fixture error, with no product fix claimed. Failed files remain available; owned clients/servers close on real events.

- `test:provider-live`: eleven deliberately gated vendor probes. Without `--live` and explicit configured model selection they report structured prerequisites, send no provider request and remain **skipped**. The suite returns2 for skips and1 for failures; neither is a passing vendor run. An actual live suite invocation must select one registered file with `--case`, so it cannot implicitly dispatch every vendor/model. Example:

```bash
pnpm run test:provider-live -- --case provider/openai-streaming.ts --live --provider openai --model '<configured-model>'
```

The coding-plan smoke entry accepts explicitly repeated `--model` targets and an optional `--reasoning-model`; the two-target reasoning entry requires both. Incorrect specified models fail instead of falling back. Ordinary credential-variable availability and Codex managed-profile readability have separate preflight paths; readability does not authenticate OAuth. `--help` on an individual package-script entry prints documentation and exits0. The live acceptance suite requires a unique owned observations artifact with completed, nonempty passing transport attempts, so help-only, no-op, empty and failed records cannot become passing coverage.

The [provider-probe review](./semantic/reviews/2026-10-31-provider-probes.json) preserves operator-text judgments and the complete assertion/value audit. Current control evidence comprises twelve reviewed actual prerequisite/help outputs; the eleven historical outputs come from an earlier control run that later failed on its nested tsx socket path. They do not accept that old behavior run. The existing twenty-nine provider-local semantic records were not regenerated by this batch; at that checkpoint a fresh full semantic lane emitted41 pending cases; the authentication additions bring the current lane to68.

Transport probes retain the five original opaque command/PID payloads, two native request modes, dual-function A/B payloads, supplied JSON field identifiers, preseeded history and actual two-turn captured reasoning/provider-data replay. Function tools are capture-only and cannot execute shell commands, read an environment value or stop a process. Full supplied input and observed reply data are saved with `semanticAcceptance: not-assessed`. Automatic results establish the stated protocol/data/lifecycle facts and do not judge task meaning, prose, reasoning quality or real-time delivery. The local control uses39 actual HTTP requests through the OpenAI-compatible SDK; its three legacy streaming filenames do not establish three native SDKs. All eleven real-vendor paths remain **UNEXECUTED** in this batch. The custom-provider setup case remains local, not a live prerequisite skip.

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

The configuration lane includes seven further audited MCP/team cases: config/header/catalog data,
real local SDK handshake and failing-handler diagnostics, capability removal on disable and
persistent enable on failed restart, current component member-import compatibility, derived
Problems refresh, filtered lifecycle cleanup, and configuration-edit path boundaries. These cases
run through the isolated CLI. The path cases pair rejection and existing external-file preservation
with successful legal-path writes; schema-name parity does not establish full behavior equivalence.
The new seven producers emit44 current semantic materials for separate subjective review;
this is not a count or acceptance of the whole configuration semantic lane. See the
[review record](semantic/reviews/2026-10-31-mcp-team-configuration.json).

The local lanes also cover all original authentication alignment/refresh groups and real HTTP
forensics downloads. Authentication uses explicit owned profiles and controlled credentials;
refresh begins with a supplied inherited-token override and verifies its restoration. Native
locks and persistence remain real; three managers establish same-process behavior, not a
cross-process refresh guarantee. Forensics checks actual ZIP payloads, native CRC and manifest
source/missing-file fidelity, protects an owned existing outside file, and preserves explicit
pick access to otherwise unrelated debug data. It adds no semantic producer.

[The authentication/forensics review](semantic/reviews/2026-10-31-auth-forensics.json)
retains the initial ten subjective refusals: the old login advice could address a different
profile. Both login and file-mode commands now bind the selected standard Codex home and
preserve an optional provider alias. New output still needs independent review. This batch
emits only the two added authentication producers (27 current materials); the full local
semantic lane emits68 fresh pending cases and is not accepted by those27 verdicts. No real
OAuth login, token authority, external provider or browser was used.

Registry and skill-handler remediation adds two audited cases to the configuration/manual
lanes. Registry assertions compare real tool handles and a supplied callback effect, require
an actual configured member, and preserve empty placeholders. Skill checks retain complete
supplied file data, directory/link moves, import boundaries and read permissions, ordinary and
deep copy-on-write, cycle/broken-link state preservation, and explicitly linked external assets.
Direct handler calls do not establish driver authorization; three-way callback/persistence/
scheduling behavior belongs to the separate dialog-driver lane.

The added skill producer emits22 actual catalog-component, move-receipt and failure diagnostics
for independent review; supplied metadata/body equality is a data-fidelity contract. Generated
read_skill instructions and explanations have no literal semantic oracle. The
[skill/registry record](semantic/reviews/2026-10-31-skill-registry.json) preserves the complete
original-value and assertion audit with actual material, verdicts and provenance. Registry is a
pure machine case and is excluded from semantic generation. The existing semantic producers
were not freshly accepted by this batch. Registered-session deduplication remains a separate
unremediated candidate until its background execution and persisted state are accepted.
