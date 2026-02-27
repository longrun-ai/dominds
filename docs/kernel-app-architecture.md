# Kernel–App Architecture (Prototype v0.1)

Chinese version: [中文版](./kernel-app-architecture.zh.md)

## Scope and Goals

This document describes the Kernel–App separation prototype in Dominds, covering:

- Two-level namespace (kernel outer / app inner) and resolution rules
- App install json (`app --json`) extensions
- Export/import semantics and conflict handling
- App defunc semantics
- App integration manual (`app_integration_manual`)
- App language policy (work/ui language and i18n)
- Incremental override DSL for `<rtws>/.apps/<app-id>/team.yaml`

The prototype code is used for **concept and functional validation**. This document is the main artifact for “driving the integrated plan forward” (stable reference for implementation/migration/review).

## Non-goals

- No protocol/schema versioning or compatibility strategy before 2.x
- No sandbox isolation before 2.x
- Run-control expansion is out of scope (will be specified in a dedicated doc)

## Core Concepts

- Kernel registry stays in the current Dominds state; built-in capabilities will gradually move out to apps.
- Each app owns its own registry, **local-first, same-name override allowed**.
- Apps do not register objects into the kernel registry.
- Apps are isolated from each other; exchange only via explicit export/import.

## Identity and Resolution

### Namespaces

- Two-level scope: `kernel` and `app`.
- For runtime resolution, short IDs (e.g. `toolsetId`, `memberId`, `toolName`) follow current kernel conventions.
- For logs/diagnostics/Problems/docs, we need a stable, source-qualified identifier, so we introduce **Qualified Id** (display/diagnostics only; not forced into the wire protocol):
  - `kernel:<name>`
  - `app:<appId>:<name>`

### Resolution order (inside an app)

For any resolution request (tool/toolset/member), the order is fixed:

1. `local(app)` (app self-registered + imported objects)
2. `kernel`

Notes:

- “Same-name override allowed” only applies when `local(app)` overrides `kernel`.
- Apps never override each other; if imports create same-name conflicts inside `local(app)`, the app becomes defunc.

## App install json (`app --json`)

Add fields to `DomindsAppInstallJsonV1`:

- `depends?: [{ appId: string; versionRange: string }]`
- `exports?: { members?: string[]; toolsets?: string[] }`

Rules:

- Empty `exports` means nothing is importable.
- `exports` only lists **single member / single toolset** IDs (fixed granularity).
- `exports` may list multiple objects, but the minimal import unit is fixed to **a single member / a single toolset** (each import points to exactly one ID).
- Exported members must come from `contributes.teammatesYamlRelPath`.
- Exported toolsets must come from `contributes.toolsets`.

## Registry and Resolution

- App resolution order: **local(app) → kernel**.
- Apps do not override each other; import conflicts put the app into defunc.
- Kernel registry never receives app objects, so there is no removal from kernel registry.
- A defunc app does not participate in resolution (but its objects are not “removed”, since they never entered the kernel registry).

## Export / Import Semantics

### Export

- Declared by `exports` in app install json.
- Kernel exposes app exports (API shape can be decided during implementation).

### Import

- **Members**: declared in app `team.yaml`.
- **Toolsets**: declared in app `team.yaml`; loaded via dominds API and registered into the app registry.

Suggested structure (example):

```yaml
imports:
  members:
    - app: foo_app
      id: npc_foo
  toolsets:
    - app: bar_app
      id: bar_toolset
```

### Conflicts and Dependency Failures

- Import conflicts or dependency failures → app defunc.

#### Conflict matrix (minimal rules)

| Case                                                  | Result                         |
| ----------------------------------------------------- | ------------------------------ |
| Same name in `local(app)` vs `kernel`                 | Allowed (local shadows kernel) |
| Imported member/toolset conflicts with app-local name | defunc                         |
| Imported member/toolset conflicts with another import | defunc                         |
| Import points to a non-exported object                | defunc                         |
| depends not satisfied (missing/version mismatch)      | defunc                         |

## Defunc Semantics

- Defunc means the app is unusable.
- No registry removal is needed (app registry is no longer used; kernel has no app objects).
- Defunc reason should be recorded for diagnosis.

### Defunc triggers (suggested enumeration)

- `MANIFEST_INVALID`: missing/invalid install json fields.
- `DEPENDENCY_MISSING` / `DEPENDENCY_VERSION_MISMATCH`: depends missing or not satisfied.
- `EXPORTS_INVALID`: exports references missing member/toolset.
- `IMPORT_NOT_EXPORTED`: import points to an object not declared in exports.
- `IMPORT_CONFLICT`: same-name conflicts introduced by imports.
- `TEAM_OVERRIDE_INVALID`: override DSL parse/validation failed for `<rtws>/.apps/<app-id>/team.yaml`.
- `IMPORT_FETCH_FAILED`: fetching toolset metadata via API failed or returned invalid data.

### Retry semantics (suggested)

- Defunc is **retryable by default**: once dependencies/config are fixed, kernel retries loading the app on the next refresh cycle.
- Retry does not mutate existing dialogs/history; it only affects future resolution/new calls.

### Observability (suggested)

- Defunc must surface in Problems (or equivalent), including at least: `appId`, `reasonKind`, `detail`, `firstSeenAt`, `lastSeenAt`, `retryable`, `suggestedAction`.
- `app_integration_manual` call failures **must not trigger defunc** (they should be observable but not make the app unusable).

## App Integration Manual (`app_integration_manual`)

- Kernel-fixed tool: `app_integration_manual`
- Params: `{ appId: string, language?: string }`
  - If `language` is omitted, default to **work language**.
- Kernel routes the call to the app host via IPC.
- App can return static markdown or runtime-generated content.
- Apps must provide zh/en content.
- Failure does not trigger defunc (return an error is enough).

## Language Policy

- **Work language** comes from the `LANG` environment variable; kernel and app host inherit and it is immutable at runtime.
- Apps must follow kernel work language for reasoning/logic content.
- Apps may provide their own UI with a user-configurable UI language.
- All apps must support at least zh/en.

## Incremental Override DSL for `team.yaml`

Override file: `<rtws>/.apps/<app-id>/team.yaml`

- No `actions:` top level.
- Domain-specific DSL with **add/replace/modify/delete**.
- Each load applies actions; failures put the app into defunc.

Example:

```yaml
version: 1

add:
  members:
    - id: npc_new
      value:
        name: New NPC
        toolsets: [trae_toolset]

replace:
  members:
    - id: npc_old
      value:
        name: Old NPC
        hidden: true

modify:
  members:
    - id: npc_village_head
      set:
        toolsets: [trae_toolset, extra_toolset]
        streaming: true
      unset: [tools]
      merge:
        model_params:
          codex:
            temperature: 0.2
  member_defaults:
    set:
      provider: codex

delete:
  members:
    - id: npc_removed

set_default_responder: npc_village_head

add_shell_specialist:
  - npc_village_head

remove_shell_specialist:
  - npc_foo
```

Rules:

- `modify_member` supports `set`/`unset`/`merge`; `merge` is a deep merge on objects.
- All changes must pass existing team.yaml validation.
- Conflicts or parse failures → app defunc.

## Suggested Load Flow

1. Resolve and register toolsets first (local toolsets + imports.toolsets), **including their tools**
2. Read app built-in team.yaml
3. Resolve imports.members
4. Apply `<rtws>/.apps/<app-id>/team.yaml` overrides
5. Validate (toolsets/tools are now resolvable)
6. Success → register members into app registry
7. Failure → app defunc

## Review Packet

This section is meant to let a reviewer validate and continue in ~30 minutes (without putting implementation details into Taskdoc progress).

### Artifacts

- Architecture (semantic source): `dominds/docs/kernel-app-architecture.zh.md`
- English alignment: `dominds/docs/kernel-app-architecture.md`

### Delta (recent changes)

- WebSocket driving no longer accepts `runControlId/runControlInput` (run-control expansion is intentionally split into a dedicated doc).
- apps-host run control result no longer supports `systemPromptPatch/prompt` (collapsed to a minimal continue/reject shape).
- kernel-driver context-health driving logic is aligned with driver-v2 style (prototype-stage cleanup).

### Minimal smoke (suggested)

Given this is a prototype for concept/functional validation, this smoke list focuses on ensuring recent cleanups do not break existing paths:

1. `pnpm -C dominds run lint:types` passes.
2. If the current rtws has enabled apps: startup initializes apps-host and registers proxy tools for each app’s `contributes.toolsets` (no name collisions).
3. WebUI dialog driving + Q4H answering no longer requires/sends `runControlId/runControlInput`.

## Prototype Status and Gap List

What is already present as a verifiable skeleton (facts only, not a completeness claim):

- Apps runtime + apps-host IPC infrastructure exists (forks apps-host and forwards tool calls).
- Proxy registration for app-declared `contributes.toolsets` exists (concept/functional validation).
- App-declared dialog run controls can be registered (run-control semantic expansion is out of scope here).

What is not yet closed / needs implementation-level landing points (the “status & issues” deliverable):

- `depends/exports/imports` loading/validation/conflict handling is currently mostly at the spec level; needs implementation + end-to-end verification.
- Defunc lifecycle state machine, Problems surfacing, retry/reload entrypoints need an implementation-closed loop (including logging/error taxonomy).
- `<rtws>/.apps/<app-id>/team.yaml` override DSL: read/apply/validate landing points + regression.
- Kernel-fixed `app_integration_manual(appId, language?)` tool + IPC routing needs implementation + regression.
- Migration playbook (which built-ins to migrate first, rollback strategy, dogfooding gates) should be produced in the implementation phase.

## Completion Criteria (Acceptance)

This prototype-stage “integrated plan” document can be considered complete when:

- It explicitly specifies: Identity/Resolution, defunc triggers + retry, imports/exports granularity + conflict matrix, team.yaml override DSL, and the `app_integration_manual` contract.
- Key rules are written as “when X happens → the system does Y”, without requiring readers to infer behavior from source.
- `kernel-app-architecture.zh.md` and this English version are kept consistent (zh is the semantic source of truth).

## Key Anchors (existing code)

- install json parsing: `dominds/main/apps/app-json.ts`
- apps runtime: `dominds/main/apps/runtime.ts`
- apps host contract: `dominds/main/apps-host/app-host-contract.ts`
- apps host IPC: `dominds/main/apps-host/ipc-types.ts`
- team.yaml parsing: `dominds/main/team.ts`
- app teammates loader: `dominds/main/apps/teammates.ts`

---

This document is a prototype-stage design draft; details may evolve during implementation.
