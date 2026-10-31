# FBR implementation

Chinese version: [中文版](./fbr-implementation.zh.md). The behavior contract is [FBR](./fbr.md).

The caller needs an independent reasoning pass with a finite execution cost and one inspectable result. The runtime preserves that value through the existing MicroKernel dialog driver and durable reply delivery.

## Policy and context

[guardrails.ts](../main/llm/kernel-driver/guardrails.ts) selects the FBR policy and overlays `fbr_model_params` on the member’s ordinary model configuration. Divergence and convergence expose no callable tools. Finalization exposes only the two conclusion functions; ordinary tools and tellasks remain unavailable.

[drive.ts](../main/llm/kernel-driver/drive.ts) uses the same context assembly pipeline for ordinary and FBR dialogs. FBR receives its dedicated policy notice, its supplied task body and its own dialog history. Shared Taskdoc, member memories, ordinary reminders and ordinary reply-obligation instructions are omitted. This prevents unrelated workspace state and instructions for unavailable tools from entering the reasoning pass. Ordinary dialogs retain those context sources.

[reply-guidance.ts](../main/llm/kernel-driver/reply-guidance.ts) preserves durable delivery routing while leaving FBR stage prompts free of ordinary reply-tool requirements. The model closes through a conclusion function; runtime delivers the accepted content through the existing reply channel.

## Execution and closure

[fbr.ts](../main/llm/kernel-driver/fbr.ts) defines divergence, convergence and finalization prompts, the two conclusion tools, and the existing persisted phase state. Normal execution uses `N` divergence rounds, `N` convergence rounds and at most `N` finalization attempts. Measured caution skips remaining reasoning rounds and enters finalization early with the same attempt limit. Critical usage stops further model requests.

Accepted native conclusions are delivered once. If the attempt limit or critical context prevents a formal conclusion, runtime returns a closure notice stating that observed limit. It does not infer task complexity or reasoning quality from missing function calls or usage measurements. Private round output is not substituted for a formal conclusion.

Reply resolution, cleared obligations, execution markers and the retained effective effort are persisted through the normal dialog stores. Completed dialog reconstruction must retain delivery and must not recreate an unfinished reply obligation.

## Acceptance evidence

The isolated [closure regression](../tests/kernel-driver/fbr-internal-conclusion-flow.ts) drives real runtime/persistence with a provider boundary substitute. It checks phase capabilities, configured model overlays, body fidelity, caller/workspace/memory isolation, forbidden-tool effects, closure limits and one-result durable delivery. Semantic mode emits the actual requests and caller result for subjective test-execution-agent review. Machine checks, generated evidence and semantic verdicts remain separate; see the [test strategy](./testing-strategy.md).
