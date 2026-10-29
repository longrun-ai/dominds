# Software Defined Harness

Chinese version: [中文版](./software-defined-harness.zh.md)

## Decision and implementation status

Retain the **MicroKernel**, retire the **Dominds App / App composition root** design, and define the runtime environment with a DSL. Extension components supply DSL-usable capabilities. An orchestration agent leads the design and evolution of how execution agents behave and interact by changing harness scripts: **Software Defined Harness**.

This is the target direction, not a shipped DSL. Existing `DomindsApp`, App Host IPC, install commands, `.minds/team.yaml`, and collaboration mechanisms remain implementation contracts until deliberately migrated. Preserve their business value rather than incidental names, directories, or the retired composition model.

## Value and responsibilities

The environment should evolve from task experience without requiring changes to Dominds internals for every collaboration rule. The orchestrator needs control over responsibilities, context, grants, interaction, continuation, and delivery criteria; workers need bounded tasks and authority; humans need understandable evidence and control.

Preserve specialization, durable continuation, human participation, capability boundaries, rtws isolation, inspectable state, and attributable results. Connect every abstraction to a business story, necessary invariant, inherited value, and observable acceptance evidence. Concerns and components have a many-to-many relationship. Structural symmetry, speculative optimization, and general frameworks do not justify themselves.

- **MicroKernel**: generic execution foundations, identities and isolation, controlled capability invocation, persisted facts, event delivery, dialog driving, interruption, and recovery. Integrity boundaries cannot move into bypassable scripts just to reduce core size.
- **Harness DSL**: the environment's program, including worker creation and responsibilities, inputs and context, capability binding, messages and results, concurrency and waiting, failures, human interaction, startup, and evolution. It is broader than static team configuration or a fixed workflow graph.
- **Extension components**: implementations of DSL-usable capabilities, such as browser sessions, integrations, collaboration protocols, domain rules, and interfaces. Installation, discovery, import, grant, and invocation remain distinct. A component gains no runtime sovereignty and is not a renamed App composition root.

Contracts describe enough inputs, outputs, events, authority, effects, and failure/retry behavior to support checking and recovery. Durable effects require deduplication and uncertain-outcome handling. Pure computation does not need irrelevant lifecycle machinery.

## Evolving the environment

The orchestrator proposes a change from business evidence, edits versioned scripts in the rtws, validates capability references and authority, and exercises affected scenarios in isolation. Activation goes through the MicroKernel under current authority. Existing actions retain definite script-version attribution; updates explicitly choose completion, cancellation, continued old-version execution, or supported migration. Reverting a script does not undo external effects.

This is program evolution, not App composition. Introduce internal plans, compilers, and hot-update machinery only when demonstrated scenarios need them.

## Scenarios that establish the minimal semantics

1. **Implementation and review**: dispatch implementation, obtain independent review, return actionable feedback when needed, and deliver only after acceptance. Verify context separation, grants, attribution, business control flow, and failures.
2. **Parallel work, human input, and recovery**: one worker waits for human clarification while another continues. Restart during result delivery preserves answers and completed work without consuming results twice. Explicitly stopped work stays stopped. Establish durable boundaries and uncertain-effect handling rather than claiming universal exactly-once execution.
3. **Extension and script evolution**: import a browser capability and grant it to one worker. Reject missing capabilities, incompatible versions, and unauthorized effects before execution. Updating scripts must account for existing actions, state, resources, and failed activation.

Illustrative pseudocode for the first scenario, **not executable syntax or a language choice**:

```text
on request_received(request):
    builder = agents.start(role="implement", context=request,
                           grants=[workspace.edit])
    checker = agents.start(role="review", grants=[workspace.read])
    result = await messages.result(builder)
    verdict = await review.check(checker, request, result)
    while verdict.needs_changes:
        result = await messages.ask(builder, verdict.feedback)
        verdict = await review.check(checker, request, result)
    deliver(result, evidence=verdict)
```

Names do not prescribe component boundaries. Cancellation, failures, stopping conditions, and restart still need executable experiments.

## Migration and open questions

Establish reliable business tests first, then build the smallest implementation-and-review experiment using one existing capability and durable facts. Add human waiting, restart, and an external capability before stabilizing contracts. Migrate working scenarios through temporary adapters with value-preservation and state-handling evidence. Remove retired App interfaces once their replacement paths are established; avoid two permanent runtime authorities.

Syntax and implementation technology, durable control flow, capability typing/versioning, supported state migration, and self-modification remain design questions. Resolve them through small executable scenarios and failure experiments, retaining current authority, recovery entry points, and human control. Valuable natural-language acceptance uses subjective test-execution-agent review of actual output; literal matching must not act as a semantic oracle.

See the [roadmap](./roadmap.md), [test remediation plan](./testing-strategy.md), and [terminology](./dominds-terminology.md).
