# Tool Availability Protocol

Status: implemented baseline for kernel/WebUI snapshot + update events; the control-point direction is intentionally fixed early, while detailed app-side protocol growth remains intentionally sparse at this stage.

## Why this exists

Dominds has several different mechanisms that can all affect what an agent can currently use:

1. MCP server tool registration
2. MCP runtime lease ownership
3. Team/member tool allocation
4. Dominds-app controlled dynamic tool availability

These mechanisms are **orthogonal**. They may compose, but they must not silently borrow each
other's semantics.

In particular:

- MCP lease is about ownership of an HTTP connection or stdio process/runtime instance.
- MCP lease does **not** decide whether a tool is globally registered.
- Member binding does **not** decide whether a tool exists globally.
- App dynamic availability does **not** mutate MCP semantics.

## App Control-Point Principle

The four protocols below describe the **kernel-observable semantics** of tool availability. They do
not by themselves define how apps extend the kernel.

The app mechanism has a separate design center:

- apps customize Dominds by registering callbacks at explicit kernel control points
- each control point has its own contract, timing, scope, and failure semantics
- `dynamicToolsets(ctx)` is the current app control point for tool availability
- `runControls` and reminder-owner handlers are the same family of extension mechanism

This distinction matters:

- the tool-availability snapshot describes the result the kernel currently observes
- the app side remains callback-driven, not an independent state machine parallel to MCP/team
- any future app push/invalidation protocol must remain auxiliary to callback evaluation, not
  replace it as the semantic authority

## Direction Guardrail

The development direction should stay stable even while the app layer is still young:

- keep app extension points explicit and named
- give each control point its own contract instead of forcing a generic callback framework too early
- let app-side details grow from concrete needs, not from preemptive abstraction

Current expectation:

- the app layer still has relatively few control points and limited detailed protocol surface
- this is expected at the current stage
- sparse detail does not mean the direction is undecided; it means the direction is fixed while the
  surface area is still being proven

## The Four Protocols

### 1. MCP Registry Protocol

Owner:

- MCP supervisor (`main/mcp/supervisor.ts`)

Source of truth:

- current loaded MCP server states + registered MCP toolsets/tools

Question answered:

- "Which MCP-backed toolsets/tools are globally registered right now?"

Non-goals:

- does not answer who is allowed to use them
- does not answer who currently holds runtime instances

Update triggers:

- `.minds/mcp.yaml` reload
- `mcp_restart`
- MCP collision-resolution re-registration

### 2. Runtime Lease Protocol

Owner:

- MCP supervisor lease map (`leasesByDialogKey`, `leaseInitByDialogKey`)

Source of truth:

- dialog-key -> MCP runtime instance ownership

Question answered:

- "Which dialog currently holds which MCP runtime instances?"

Non-goals:

- does not decide tool visibility
- does not decide global registration

Update triggers:

- first MCP tool call acquires a lease
- `mcp_release`
- restart/stop tears leases down

### 3. Member Tool-Binding Protocol

Owner:

- `.minds/team.yaml` + `Team.Member` resolution rules

Source of truth:

- `members.<id>.toolsets`
- `members.<id>.tools`
- runtime registry lookup for those selectors/ids

Question answered:

- "What static tool allocation does this member currently bind to?"

Notes:

- this layer may reference built-in, app, or MCP toolsets
- selectors such as `*` / `!foo` belong to this layer, not to MCP or apps

### 4. Dominds Apps Dynamic Tool-Availability Protocol

Owner:

- kernel tool-availability control point + apps-host `dynamicToolsets(ctx)` callback contract

Source of truth:

- evaluating enabled apps' `dynamicToolsets(ctx)` callbacks for a concrete context

Question answered:

- "What extra toolsets become available for this member in this task/dialog context?"

Current contract:

- callback-based request/response evaluation at the tool-availability control point
- handler returns `string[]`
- no app-originated push/update protocol yet

Important boundary:

- this layer is app-specific runtime policy, not a side effect of MCP lease or registry state
- this layer is not a separate registry; it is the kernel-observed result of a control-point
  callback evaluation

## Composition Rules

Tool visibility in a context is composed as:

1. start from the global registry catalog
2. apply member static binding
3. union in app-dynamic toolset ids for the same context
4. resolve the final visible toolsets from the current registry catalog

Runtime lease is reported alongside the snapshot, but:

- `runtimeLeaseAffectsVisibility` is explicitly `false`

That flag is part of the formal protocol so the UI/runtime never has to infer this rule from
implementation details.

## Formal Snapshot Contract

REST endpoint:

- `GET /api/tool-availability`

Kernel type:

- `ToolAvailabilitySnapshot` in `packages/kernel/src/types/tools-registry.ts`

The snapshot contains:

- `protocolVersion`
- `context`
- `layers.registry`
- `layers.memberBinding`
- `layers.appDynamicAvailability`
- `layers.runtimeLease`
- `composition`
- `timestamp`

Each layer carries its own `revision`, so future clients can cache by explicit revision instead of
blindly caching by dialog id.

## Update / Invalidation Contract

WebSocket event:

- `tool_availability_updated`

Current reasons:

- `registry_changed`
- `member_binding_changed`
- `app_dynamic_availability_changed`
- `runtime_lease_changed`

Current implementation guarantees:

- MCP registry changes broadcast `registry_changed`
- team config changes broadcast `member_binding_changed`
- explicit runtime lease acquire/release boundaries broadcast `runtime_lease_changed`

Current limitation:

- apps-host dynamic availability is still request/response only; there is not yet a formal
  app-originated push protocol for "dynamic availability changed for context X"

That missing push protocol is a real design gap, not an intentional semantic coupling to any other
layer.

## Current Implementation Notes

- WebUI tools widget no longer caches authority snapshots per dialog.
- The widget fetches a fresh `/api/tool-availability` snapshot and renders the composed visible
  toolsets/direct tools for the current context.
- In-flight prompts are still not rewritten retroactively. A fresh drive/load uses the latest
  composed availability snapshot, which remains the intended contract.
- App-controlled dynamic availability is still intentionally narrow in surface area:
  `dynamicToolsets(ctx)` is the current control point, and broader app-side invalidation semantics
  are not yet generalized.

## Major Open Design Decision

The remaining major design decision is what auxiliary invalidation protocol should exist around the
already chosen control-point direction.

The key rule should stay stable:

- app policy authority lives at explicit kernel control points
- snapshots/events are observable consequences, not the semantic owner of app policy

The current concrete choice is therefore narrower than "push or pull":

1. Keep `dynamicToolsets(ctx)` as a callback-only control point for now.
   Result: simple and aligned with the control-point model; UIs refresh or re-drive to observe
   changes.
2. Add a formal apps-host -> kernel invalidation protocol around that callback.
   Result: better convergence, but the invalidation scope, revision model, ordering, and lifecycle
   all need first-class design.

What we should **not** do is let push events, MCP restart, lease churn, or frontend caching become
the de facto owner of app-controlled tool policy.
