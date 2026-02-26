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

## Non-goals

- No protocol/schema versioning or compatibility strategy before 2.x
- No sandbox isolation before 2.x
- Run-control expansion is out of scope (will be specified in a dedicated doc)

## Core Concepts

- Kernel registry stays in the current Dominds state; built-in capabilities will gradually move out to apps.
- Each app owns its own registry, **local-first, same-name override allowed**.
- Apps do not register objects into the kernel registry.
- Apps are isolated from each other; exchange only via explicit export/import.

## App install json (`app --json`)

Add fields to `DomindsAppInstallJsonV1`:

- `depends?: [{ appId: string; versionRange: string }]`
- `exports?: { members?: string[]; toolsets?: string[] }`

Rules:

- Empty `exports` means nothing is importable.
- `exports` only lists **single member / single toolset** IDs (fixed granularity).
- Exported members must come from `contributes.teammatesYamlRelPath`.
- Exported toolsets must come from `contributes.toolsets`.

## Registry and Resolution

- App resolution order: **local(app) → kernel**.
- Apps do not override each other; import conflicts put the app into defunc.
- Kernel registry never receives app objects, so there is no removal from kernel registry.

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

## Defunc Semantics

- Defunc means the app is unusable.
- No registry removal is needed (app registry is no longer used; kernel has no app objects).
- Defunc reason should be recorded for diagnosis.

## App Integration Manual (`app_integration_manual`)

- Kernel-fixed tool: `app_integration_manual`
- Params: `{ appId: string, language?: string }`
  - If `language` is omitted, default to **work language**.
- Kernel routes the call to the app host via IPC.
- App can return static markdown or runtime-generated content.
- Apps must provide zh/en content.

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

add_member:
  - id: npc_new
    value:
      name: New NPC
      toolsets: [trae_toolset]

replace_member:
  - id: npc_old
    value:
      name: Old NPC
      hidden: true

modify_member:
  - id: npc_village_head
    set:
      toolsets: [trae_toolset, extra_toolset]
      streaming: true
    unset: [tools]
    merge:
      model_params:
        codex:
          temperature: 0.2

delete_member:
  - id: npc_removed

modify_member_defaults:
  set:
    provider: codex

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

## Key Anchors (existing code)

- install json parsing: `dominds/main/apps/app-json.ts`
- apps runtime: `dominds/main/apps/runtime.ts`
- apps host contract: `dominds/main/apps-host/app-host-contract.ts`
- apps host IPC: `dominds/main/apps-host/ipc-types.ts`
- team.yaml parsing: `dominds/main/team.ts`
- app teammates loader: `dominds/main/apps/teammates.ts`

---

This document is a prototype-stage design draft; details may evolve during implementation.
