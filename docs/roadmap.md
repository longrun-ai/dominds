# Dominds Roadmap

Chinese version: [中文版](./roadmap.zh.md)

## Summary

The target is **Software Defined Harness**: retain the MicroKernel, define the runtime environment with a DSL, and let extension components provide DSL-usable capabilities. An orchestration agent leads the design and evolution of execution-agent behavior and interaction through scripts.

The Dominds App, App composition root, and App composition revision design is superseded. Related interfaces remain current implementation contracts pending scenario-based migration, not the destination model. See the [design direction](./software-defined-harness.md).

## North Star

Make the environment an inspectable, versioned program that its orchestration agent can evolve. The MicroKernel maintains generic execution and non-bypassable integrity boundaries; the DSL expresses responsibilities, context, grants, interaction, waiting, failures, and continuation; extensions implement capabilities. This is broader than static tool configuration or a fixed workflow graph and needs no App composition root.

## Stage 0: Value baseline and test remediation

- Derive requirements from business value and failure consequences. Preserve specialization, continuation, human participation, authority, isolation, and explainability.
- Repair discovery, isolation, and failure reporting; audit unassigned cases and behavior coverage. See the [test remediation plan](./testing-strategy.md).
- Reject literal matching as a semantic oracle. Delete low-value checks; valuable semantic output goes to subjective test-execution-agent review. Apply the same blocking review to added and changed tests.
- Keep current mechanisms useful during migration. Do not preassign every collaboration, reminder, taskdoc, daemon, or UI concern to a component or DSL primitive.

## Stage 1: Minimal DSL experiments

- Connect implementation-and-review scripts to an existing capability, durable facts, and business acceptance.
- Establish parallel work, human waiting, restart, extension, and script-update behavior through the three design scenarios.
- Choose language and minimal contracts from executable evidence, separating proposals, implementation, and open questions. Avoid a speculative compiler or hot-update platform.
- Imports do not grant authority. Existing actions retain definite script versions and explicit update disposition.

## Stage 2: Scenario-based runtime migration

- Adapt existing capabilities into the DSL with value-preservation, state-handling, and fallback evidence.
- Let the orchestrator propose candidate script changes and activate validated versions through MicroKernel control.
- Remove retired App manifests, install/host interfaces, and structural assertions when replacement scenarios work. Avoid two permanent runtime authorities.
- Derive UI, collaboration, and domain component boundaries from actual uses and reuse needs.

## Stage 3: Evolving Software Defined Harness

- Stabilize only DSL and extension contracts demonstrated by real scenarios.
- Establish authority, recovery entry points, and human control during orchestrator self-modification.
- Expand capability and interaction ecosystems while preserving business acceptance and rtws isolation.

## Cross-stage principles

- **First principles and inherited value**: derive changes from needs and consequences; preserve useful outcomes rather than incidental technical shapes.
- **Proportionate engineering**: abstractions and optimizations need concrete uses and observable benefits; generality, symmetry, and speculative performance do not justify themselves.
- **Integrity and authority**: scripts, extensions, and updates remain subject to current execution boundaries.
- **Continuity and accountability**: associate versions, actions, results, and responsibilities; script rollback does not undo external effects.
- **Honest evidence**: report build checks, automated behavior tests, subjective semantic review, and unexecuted environments separately.

See [terminology](./dominds-terminology.md) and the [existing collaboration design](./design.md).
