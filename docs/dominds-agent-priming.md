# Dominds Agent Priming (Deprecated in this branch)

English version: [中文](./dominds-agent-priming.zh.md)

## Status

In this branch, the legacy hardcoded Agent Priming implementation has been fully removed from runtime behavior.

- No automatic dialog-creation priming flow runs.
- No priming cache/reuse modes are executed at startup.
- No dedicated priming API behavior is enforced by the runtime.

## What this means for current behavior

- The runtime does **not** auto-run startup tellasks, environment probes, or distillation-only priming notes.
- FBR is still available only through normal runtime contracts, including `freshBootsReasoning`.
- `fbr_effort` still controls how many serial FBR sideline dialogs are spawned for a single `freshBootsReasoning` call (see [`fbr.md`](./fbr.md)).

## Planned replacement

Priming is being reimplemented from scratch as **startup-script replay**:

1. Persist normal dialog history as a deterministic startup script artifact.
2. Replay that script through a dedicated interface when startup priming is required.
3. Keep behavior explicit, observable, and easy to version by script artifact and replay contract.

Until the new interface is fully landed, this document should be treated as a migration note, not an active runtime contract.
