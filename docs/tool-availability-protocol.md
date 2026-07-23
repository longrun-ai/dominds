# Tool Availability Protocol

Status: implemented for the kernel snapshot, WebUI tools widget, and update events.

## Purpose

Tool availability answers two separate questions:

1. Which tools and toolsets are registered in the current runtime?
2. Which of those capabilities has the current team member selected?

Registration and selection are independent. Runtime resource ownership, such as an MCP lease, is
reported alongside them but does not grant or revoke tool visibility.

## Registry

The registry catalog contains the toolsets currently contributed by Dominds, installed Apps, and
configured MCP servers. Its source of truth is the in-process tools registry.

Registry changes include:

- App toolset registration or removal
- MCP server registration, restart, disablement, or collision resolution
- framework toolset registration changes

The registry does not decide which member may use a capability.

## Member Selection

Member selection is resolved from:

- `members.<id>.toolsets`
- `members.<id>.tools`
- wildcard and exclusion selectors such as `*` and `!foo`
- the current registry catalog

The result records declared selectors, resolved toolset ids, directly selected tools, and unresolved
declarations. Built-in, App-provided, and MCP-provided toolsets all use the same selection rules.

## MCP Runtime Leases

The MCP supervisor owns the dialog-to-runtime lease map. A lease says which dialog currently owns a
runtime instance; it does not decide whether the corresponding toolset is registered or selected.

`runtimeLeaseAffectsVisibility` is therefore always `false`.

## Composition

For a concrete member and dialog context, the kernel:

1. reads the current registry catalog
2. resolves the member's declared toolsets and tools
3. filters shell tools according to the shell-specialist policy
4. injects intrinsic dialog-control capabilities according to dialog scope
5. exposes runtime-provided helpers such as `man` and `read_skill` when they are not already present

Apps participate by contributing normal toolsets and by supplying team/application configuration
that selects the components required by the App. There is no second category of toolset with a
separate availability callback.

## Snapshot Contract

REST endpoint:

- `GET /api/tool-availability`

Kernel type:

- `ToolAvailabilitySnapshot` in `packages/kernel/src/types/tools-registry.ts`

The snapshot contains:

- `protocolVersion`
- `context`
- `layers.registry`
- `layers.memberBinding`
- `layers.runtimeLease`
- `composition`
- `timestamp`

Each layer has a revision so clients can compare explicit state instead of inferring freshness from
a dialog id.

## Update Contract

WebSocket event:

- `tool_availability_updated`

Reasons:

- `registry_changed`
- `member_binding_changed`
- `runtime_lease_changed`

The WebUI fetches a fresh snapshot after an update and renders the composed capabilities. In-flight
prompts are not rewritten; the next drive/load observes the latest registry and member selection.
