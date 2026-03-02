# App Constitution (Kernel–App separation: App concept and mechanisms, Draft)

Chinese version: [中文版](./app-constitution.zh.md)

> Status: Draft / RFC-ish.
>
> This document clarifies what an “App” means in Dominds, what it can ship, how workspace overrides work,
> and how app-level teammates should participate in team composition.
> It does **not** imply all capabilities are implemented today; it explicitly distinguishes “Current (implemented)” vs “Target (planned)”.

## Scope

This document covers:

- Boundary between kernel and apps: an app as a distributable unit (a Node.js package), and the kernel as host/runtime.
- App-provided `.minds/**` assets: at least `.minds/team.yaml`, plus `mcp.yaml`, `env.md`, and similar.
- `<rtws>/.apps/<app-id>/`: workspace-side app state and override layer, including overrides for dependency apps.
- “Dev app” mode: allow an rtws to run _as_ a Dominds app during development, reusing the same directory structure/mechanisms.
- Enhanced `.minds/team.yaml`: `use` / `import` to reference teammates provided by other apps, with clear execution context semantics.

Relationship to `dominds/docs/kernel-app-architecture.md`:

- `kernel-app-architecture` focuses on runtime skeleton: registry, resolution, defunc semantics, IPC.
- This doc focuses on: the app package + `.minds/**` asset contract, override mechanisms, and team composition semantics.

## Non-goals

- No protocol/schema versioning or long-lived compatibility strategy in this draft.
- No sandbox/isolation definition (permissions/resource isolation is out of scope).
- Not a full implementation plan; we keep implementation details as “anchors”.

## Core concepts

### Kernel

The kernel is the Dominds host runtime: dialog driving, tool calling, persistence, WebUI/WS/HTTP, and app loading/execution.

### App

An app is a distributable capability package, typically a **Node.js project (with `package.json`)**, that may provide:

- Tools (tool/toolset) callable by the kernel (or other apps via the kernel).
- Teammates (agents) that can be responders, can be told/asked, or act as “bridge” members.
- `.minds/**` assets describing and composing team, tool integrations (e.g. MCP), environment requirements, etc.

> Note: An app may _also_ be a Python (uv) project (with `pyproject.toml`) to expose CLIs/wrappers.
> The kernel↔app-host contract remains Node-centric; Python is primarily for developer ergonomics and external tooling.

### rtws (Runtime workspace)

rtws is the runtime workspace root (`process.cwd()`). The kernel reads/writes:

- `.minds/`: team/model/tool configs (user-managed assets).
- `.dialogs/`: dialog persistence.
- `.apps/`: installed apps registry, runtime state, override layers, seeded taskdocs.

### App context

“Which app context an agent runs in” determines which teammates it can see and how tool/toolset resolution works.

- Kernel context: the global team (workspace `.minds/team.yaml`).
- App context: the app-local team (app `.minds/team.yaml` plus its dependency/override composition).

> Target direction: decouple “team visibility” from “tool availability”, but keep both encapsulated and overridable at app boundaries.

## App packages and manifests

### App manifest (YAML)

(Current: implemented) The kernel can read an app manifest and validate it:

- Types + validation: `dominds/main/apps/manifest.ts` (`DomindsAppManifest`).
- Default file name: `.minds/app.yaml` (overridable via `package.json` field `dominds.appManifest`, see `dominds/main/apps/package-info.ts`).

The manifest currently supports (key fields only; not exhaustive):

- `contributes.teammates.teamYaml`: path to the app’s team YAML.
- `contributes.tools.module`: path to the tool implementation module.
- `contributes.web.staticDir`: optional static resources.
- `contributes.rtwsSeed.taskdocs[]`: seed taskdocs under `<rtws>/.apps/<app-id>/...*.tsk/` (see `dominds/main/apps/rtws-seed.ts`).

### Install JSON (`npx <pkg> --json`)

(Target: planned) Install JSON should avoid overlapping with the manifest.

Its responsibility is: provide **minimum “cache / location pointers”** (e.g. cache directory, manifest path, and necessary verification data). The kernel must then read the manifest file from that location to obtain full app information.

Recommended principles:

- Install JSON carries only the minimal fields required for locating caches and reading the manifest.
- Capability inventory (teammates/tools/web/seed, etc.) must be **manifest-only**, to avoid drift from dual-writing.

(Current: implemented) existing anchors:

- JSON schema: `dominds/main/apps/app-json.ts` (`DomindsAppInstallJsonV1`).
- Installed apps file: `dominds/main/apps/installed-file.ts`.

## App-provided `.minds/**` assets

### Asset types and goals

“`.minds/**` assets” here means a set of configuration and documentation files shipped **inside the app package** (and/or materialized/overlaid by the kernel).

Typical assets:

- `.minds/team.yaml`: the app’s teammate definitions.
- `.minds/mcp.yaml`: MCP server declarations needed/recommended by the app.
- `.minds/env.md`: human-readable environment variable guide.

Design goals:

- **Portable**: install into different rtws and still work.
- **Overridable**: workspace can override a third-party app’s `.minds/**` partially.
- **Composable**: an app can depend on other apps and reuse their teammates/toolsets (via `use/import`).

### `.minds/team.yaml` (app-side)

(Target: planned) An app can ship `.minds/team.yaml` as its app-local team.

It describes:

- what teammates (members) the app has;
- default toolsets/tools for those members;
- how those members see each other and collaborate within the app.

> Current prototype behavior: the kernel loads enabled app teammates YAML and **additively merges `members` into workspace `.minds/team.yaml`**.
> The merge happens in `dominds/main/team.ts` and the loader is `dominds/main/apps/teammates.ts`.
> This is not yet equivalent to “per-app team + `use/import` semantics”.

### `.minds/mcp.yaml`

(Target: planned) Apps may ship MCP configuration (servers, start commands, env references).

Key semantics:

- app `.minds/mcp.yaml` should be treated as defaults/recommendations; workspace can override/disable.
- app tools may depend on MCP servers; MCP config should be versioned alongside tool capability.

### `.minds/env.md`

(Target: planned) `env.md` is **human-readable** documentation describing required env vars.

- The kernel must not implicitly write `env.md` into shell rc or environment.
- If the kernel offers “write managed rc block” (e.g. setup flow), it must be explicit and user-confirmed.

## `<rtws>/.apps/override/<app-id>/`: override layer

### `.apps/installed.yaml`

(Current: implemented) The kernel stores the installed/enabled apps list in `<rtws>/.apps/installed.yaml`.

This file is a source of truth for enabled apps snapshot.

### Override root

(Target: planned) The workspace override directory for an app is:

`<rtws>/.apps/override/<app-id>/`

Intended uses:

- store overrides for app assets.
- provide complete override capability beyond team config, including persona/knowledge/lessons and memory.

> Note: “runtime state” and “override” can be split structurally. This document focuses on override semantics and paths.

(Current: implemented) rtws seed taskdocs currently write under `<rtws>/.apps/<app-id>/...` (implementation: `dominds/main/apps/rtws-seed.ts#applyRtwsSeed()`).

(Target: planned) once `.apps/override/<app-id>/` is introduced, the seed landing zone should be re-defined (as part of state, or separately), while keeping:

- purge-ability by `appId`;
- non-confusing semantics vs user-edited overrides;
- traversal protection.

### Override app assets (including dependency apps)

(Target: planned) The workspace should be able to override third-party app assets without forking the app package.

Suggested override resolution for any app asset path `p`:

1. `<rtws>/.apps/override/<app-id>/.minds/<p>` (workspace override, higher priority)
2. `<appPackageRoot>/.minds/<p>` (app default)

This naturally supports “override dependency apps”: once a dependency app is enabled in the same rtws, it can be overridden via its own `.apps/<dep-id>/...` directory.

> Alignment note: `kernel-app-architecture` already sketches a `<rtws>/.apps/<app-id>/team.yaml` override DSL.
> This document generalizes the idea to the broader `.minds/**` asset set (not only team).

#### Override scope (recommended)

To allow an app to fully ship a reusable “team + knowledge/persona” bundle, overrides should cover at least:

- `.minds/team.yaml`
- `.minds/mcp.yaml`
- `.minds/env.md`
- `.minds/team/<memberId>/{persona,knowledge,lessons}.md` and work-language variants (e.g. `persona.zh.md`)
- `.minds/memory/**` (shared + personal memory; see `dominds/main/tools/mem.ts` and `dominds/main/minds/load.ts`)

## Enhanced `.minds/team.yaml`: `use` / `import`

(Target: planned) To reuse teammates provided by other apps without flattening everything into a single global team, we introduce two distinct semantics, and we propose a syntax where the source is declared inside `members`.

### `use`: reference (bridge / gatekeeper)

Intuition:

- I want to “use” an agent from another app, but not “bring it into” my local team.
- The agent **runs in the original app context**: it only sees the original app’s teammates/tool availability.
- From the current app’s perspective it behaves like a “gatekeeper”: you tell/ask it, it performs work in its home app, then returns results.

Constraints:

- The current app must not inject the home app’s teammate list into its own prompts.
- A `use`-mode agent should not be treated as an internal team member; it is a cross-app RPC surface.

### `import`: import as a local team member

Intuition:

- I want to reuse an agent’s identity/persona, but make it a member of my current team.
- The agent **runs in the current app context**: it only sees the current app’s teammates.
- Tool resolution follows the current app’s rules (e.g. local(app) → kernel).

Constraints:

- `import` must not implicitly grant visibility into the dependency app’s hidden teammates; dependency capability should be acquired via explicit toolset import or `use`.

### Suggested YAML shape

> Note: syntax below is a target design; the current `.minds/team.yaml` parser does not support it yet.

Example snippet:

```yaml
members:
  builder:
    name: Builder
    toolsets: [repo_tools]

  librarian:
    use: librarian # optional; defaults to using the same <id>
    from: knowledge_base # <dep-app-id>
    # optional overrides

  scribe:
    import: scribe # if omitted, defaults to `use`
    from: common_agents # <dep-app-id>
    # optional overrides
```

Semantic notes:

- `members.<id>.from` specifies the source app (dependency app id).
- `members.<id>.use` references a member from the source app (if `from` exists and `import` is omitted, default to `use`).
- `members.<id>.import` imports a member from the source app but runs it in the current app context (teammate visibility = current team).

Rule: `use` and `import` must not both appear in the same member definition.

Conflict handling (suggested):

- Invalid `from/use/import` syntax should be observable via Problems (fail-open is acceptable as long as the team remains usable).

#### Conflict matrix (v0 draft)

| Case                                                                              | Suggested result                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `members.<id>.from` is not a string                                               | Ignore the cross-app definition for that member; record a problem  |
| both `members.<id>.use` and `members.<id>.import` present                         | Ignore cross-app definition; record a problem                      |
| `use/import` present but `from` missing                                           | Ignore cross-app definition; record a problem                      |
| referenced app missing/not enabled                                                | Ignore cross-app definition; record a problem                      |
| referenced app exists but does not export the member (future: exports constraint) | Ignore cross-app definition; record a problem                      |
| `use`: bridge member is told/asked but the target app is defunc/unavailable       | tellask fails with an error; record a problem (must not be silent) |

#### Problems / issue id prefix (v0 draft)

Recommended aggregation prefix (stable and greppable):

- `team/team_yaml_error/members/<local-id>/from_app/<from-app-id>/<from-member-id>/`

Notes:

- `<local-id>` is only unique within the current team; it is not globally unique.
- The globally unique source identifier is `<from-app-id>/<from-member-id>`.
- If `from` / `use` / `import` are invalid, implementations may use placeholder segments (e.g. `_unknown_from_app_` / `_unknown_from_member_`) to keep the problem id stable and greppable.

## “Dev app” mode: let an rtws run as an app

(Target: planned) Allow treating a workspace root as a “Dominds app under development”, reusing the same directory structure and mechanisms.

Analogy: in Node.js development, a repo is both source tree and working directory; dependencies resolve via the package manager.

### Expected behavior

- When the current working directory can be recognized as a Dominds App (has a manifest; cfg-only is allowed and may not have `package.json`), the kernel can enter dev app mode.
- In dev app mode:
  - the directory’s `.minds/**` acts as the app defaults;
  - `<rtws>/.apps/override/<dep-app-id>/...` remains available to override dependency apps;
  - other installed apps can be enabled in the same rtws as dependencies.

### cfg-only apps (configuration-only apps)

(Target: planned) Allow “cfg-only apps” that do not contribute tools (no `contributes.tools`). They only ship `.minds/**` assets to reorganize AI teams (persona/knowledge/lessons/memory and related config).

This makes it possible that:

- an rtws as a dev app does not have to be a Node.js package;
- a Dominds app can be distributed purely as a configuration bundle.

### Why it matters

- App developers don’t need a package-install loop to test; run directly in the repo.
- The same dependency/override mechanism is reused in both “product runtime” and “local development”.

## Implementation anchors (current code)

- install json schema: `dominds/main/apps/app-json.ts`
- installed apps file: `dominds/main/apps/installed-file.ts`
- apps runtime (proxy tools): `dominds/main/apps/runtime.ts`
- app teammates loader (prototype flat merge): `dominds/main/apps/teammates.ts`, `dominds/main/team.ts`
- manifest parser: `dominds/main/apps/manifest.ts`
- rtws seed (taskdocs): `dominds/main/apps/rtws-seed.ts`

---

This document is a draft; it will evolve together with implementation.
