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

This document is the unified entry point for app-related semantics and mechanisms.

## Roadmap: Phases A/B/C/D (MVP = phase)

This document uses **A/B/C/D** to describe the evolution phases of this feature.

- What “**MVP=C**” means: the acceptance gate for this stage is the **Phase C** checklist (i.e. only Phase C capabilities are required for this milestone; anything outside Phase C is not part of the gate even if implemented).
- Phases are not a compatibility/stability promise: Dominds is still in a prototype/alpha iteration mode; phases are used to define **scope + acceptance focus** for this feature.

> Note: This roadmap is an RFC-ish “scope definition”; it does not automatically imply everything is implemented today. The rest of this doc still marks items as “Current (implemented)” vs “Target (planned)”.

### Phase A: Concepts and minimal skeleton (Foundations)

Goal: make the kernel/app boundary and the minimal data flow runnable, so the install/resolve/boot path can be validated.

- Key capabilities (at minimum):
  - App install handshake (`<app> --json`) can be consumed by the kernel/CLI.
  - App manifest (`.minds/app.yaml`) schema/loader is available.
  - Basic local resolution strategy (`local`) works: discover local apps under `<rtws>/dominds-apps/<appId>/`.

### Phase B: Team composition and cross-app references (Team Composition)

Goal: allow app-provided teammates to participate in team composition, with explicit execution-context semantics for cross-app references.

- Key capabilities (at minimum):
  - Load enabled apps’ teammates YAML (with workspace overrides).
  - Workspace `.minds/team.yaml` supports explicit cross-app referencing via `members.<id>.from + (use|import)`.
  - Name collisions / reference failures are diagnosed and routed through Problems/defunc (retryable).

### Phase C: MVP gate (deps/lock/override contract/port pinning/Problems)

Goal: close the loop for “dependency resolution + observability + regressability”, so dogfooding is diagnosable and recoverable.

- Key capabilities (must-pass):
  - required/optional dependencies:
    - optional missing/disabled: silently skipped (must not block startup; Problems not required; debug logs allowed).
    - required missing/disabled: must not block startup; must be observable in WebUI Problems; related capability enters defunc/unavailable.
  - required disable propagation:
    - `<rtws>/.apps/configuration.yaml` must represent explicit user disables (`disabledApps`).
    - `<rtws>/.apps/resolution.yaml` must only record the resolved effective enabled state.
    - when dependencies recover, propagated disables must auto-recover (without overriding explicit user disables).
  - Override precedence (documented contract): `rtws override > app override > app defaults`.
  - Lock semantics (design contract): `.minds/app-lock.yaml` freezes dependency versions only; enable/disable must not jitter the lock.
  - assignedPort: once pinned, `assignedPort` must be non-zero; conflicts must be surfaced and re-assigned; uninstall naturally frees ports.
  - Problems: Problems ids use a stable prefix (currently `apps/apps_resolution/`); after a fix, issues must reconcile/clear (no permanent residue).

### Phase D: Integrator packaging and UX (Integration & UX)

Goal: let an integrator app ship publishable default overrides for dependency apps, and polish the observability/Problems experience.

- Key capabilities (target):
  - app override: app packages may ship default overrides for dependency apps (publishable integration config), while rtws overrides still take precedence.
  - Override surface expands to more `.minds/**` assets (persona/knowledge/lessons, memory, mcp, etc.).
  - Problems mechanism enhancements: record and display “occurred at / resolved at / resolved state”, and allow “clear resolved” in UI.
  - More complete error-path contracts (corrupt YAML, partial availability, recovery strategy) with regression coverage.

## Non-goals

- No protocol/schema versioning or long-lived compatibility strategy in this draft.
- No sandbox/isolation definition (permissions/resource isolation is out of scope).
- Not a full implementation plan; we keep implementation details as “anchors”.

## Kernel-App Runtime Skeleton

The following rules define the key runtime boundaries between kernel and apps:

- Resolution order inside an app is fixed: `local(app) -> kernel`.
- Override semantics: overrides happen at the **configuration layer**, not by “registering and overwriting” runtime objects:
  - For a given app asset path `p`: `<rtws>/.apps/override/<app-id>/.minds/<p>` (rtws override) wins over the app package default.
  - (Target: planned) an app integrator may ship _app overrides_ for its dependency apps (e.g. default overrides packaged with the app), but rtws overrides still take precedence.
  - Shadowing kernel registry names is not a goal: name collisions should be diagnosed explicitly (and handled via defunc / Problems), not silently overwritten by last-writer-wins.
- Conflict semantics: import name conflicts or unsatisfied dependencies put the app into defunc.
- Registry boundary: app objects do not register into kernel registry; defunc does not require “removing app objects from kernel”.
- Observability: defunc reasons should surface in Problems (at minimum with `appId`, reason kind, and suggested action).
- Retry semantics: defunc is retryable by default (reload on a later refresh cycle once dependency/config issues are fixed).
- Fixed tool contract: `app_integration_manual({ appId, language? })` failures should be observable but must not trigger defunc.
- Typical load sequence: register toolsets first, then team/imports, apply overrides, validate, and finally register members; failures result in defunc.

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

### App manifest (`.minds/app.yaml`) (YAML)

(Current: implemented) The kernel can read an app manifest (`.minds/app.yaml`) and validate it:

- Types + validation: `dominds/main/apps/manifest.ts` (`DomindsAppManifest`).
- Default file name: `.minds/app.yaml` (overridable via `package.json` field `dominds.appManifest`, see `dominds/main/apps/package-info.ts`).

The manifest currently supports (key fields only; not exhaustive):

- `contributes.teammates.teamYaml`: path to the app’s team YAML.
- `contributes.tools.module`: path to the tool implementation module.
- `contributes.web.staticDir`: optional static resources.
- `contributes.rtwsSeed.taskdocs[]`: seed taskdocs under `<rtws>/.apps/<app-id>/...*.tsk/` (see `dominds/main/apps/rtws-seed.ts`).

#### Dependency declaration / lock / workspace resolution (v0 draft)

(Target: planned) Split “dependency declaration”, “version freezing”, and “workspace resolution” into separate layers. Avoid mixing _declaration_, _locking_, and _runtime state_ into a single file.

Analogy (intuition only):

- `.minds/app.yaml`: like `package.json` (declares the dependency graph + app default config such as `frontend.defaultPort`).
- `.minds/app-lock.yaml`: like `pnpm-lock.yaml` (freezes dependency versions; should not jitter due to enable/disable).
- `<rtws>/.apps/configuration.yaml`: workspace user config (resolution strategy + explicit `disabledApps`).
- `<rtws>/.apps/resolution.yaml`: per-rtws resolution snapshot (“where each app resolved from / whether it is effectively enabled / whether its port is already pinned”).

Key semantics:

- enable/disable operations must only affect `<rtws>/.apps/configuration.yaml.disabledApps`.
- dependencies can be declared as `required` vs `optional`:
  - disabling a `required` dependency must transitively make dependents _effectively disabled_ (at minimum observable via UI/Problems).
  - disabling an `optional` dependency must not disable dependents.
- ports:
  - apps declare `frontend.defaultPort` in the manifest (`.minds/app.yaml`) (may be `0` to allow runtime decision).
  - `<rtws>/.apps/resolution.yaml` can pin an `assignedPort` as a stable resolved config; **if present it must be non-zero** (anti-jitter).
  - `assignedPort` is not the runtime “bound port”; it is the resolver’s stable config output.

### Install JSON (`npx <pkg> --json`)

(Target: planned) Install JSON should avoid overlapping with the manifest (`.minds/app.yaml`).

Its responsibility is: provide **minimum “cache / location pointers”** (e.g. cache directory, manifest path, and necessary verification data). The kernel must then read the manifest (`.minds/app.yaml`) from that location to obtain full app information.

Recommended principles:

- Install JSON carries only the minimal fields required for locating caches and reading the manifest.
- Capability inventory (teammates/tools/web/seed, etc.) must be **manifest-only**, to avoid drift from dual-writing.

(Current: implemented) existing anchors:

- JSON schema: `dominds/main/apps/app-json.ts` (`DomindsAppInstallJsonV1`).
- Apps configuration file: `dominds/main/apps/configuration-file.ts`.
- Apps resolution file: `dominds/main/apps/resolution-file.ts`.

(Current: implemented) the kernel now splits `<rtws>/.apps/configuration.yaml` from `<rtws>/.apps/resolution.yaml`:

- `configuration.yaml` carries user config: `resolutionStrategy?` (if present) overrides the default strategy, and `disabledApps` records explicit disables.
- `resolution.yaml` carries derived state only: `apps[]` stores `enabled` / `assignedPort` / `source` / `installJson`.
- If `configuration.yaml` is missing, strategy falls back to defaults (`order=['local']`, `localRoots=['dominds-apps']`) and no explicit disables apply.
- If `resolution.yaml` is missing, the snapshot starts empty and the kernel re-materializes it from the declared dependency graph.

So even without `<rtws>/.apps/configuration.yaml` or `<rtws>/.apps/resolution.yaml`, as long as `.minds/app.yaml` declares dependencies, the kernel still resolves local apps via the default strategy; if the root manifest has no dependencies, the effective enabled apps set is empty.

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
> Current (v0): the kernel loads enabled app teammates YAML but does **not** flatten-merge their `members` into workspace `.minds/team.yaml`.
> You must explicitly reference a dependency app teammate via `members.<id>.from + (use|import)` in workspace `.minds/team.yaml`.
> Loader: `dominds/main/apps/teammates.ts`; resolver/execution: `dominds/main/team.ts`.

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

> This document also covers the `<rtws>/.apps/<app-id>/team.yaml` override DSL concept, and generalizes it to broader `.minds/**` assets (not only team).

#### Override scope (recommended)

To allow an app to fully ship a reusable “team + knowledge/persona” bundle, overrides should cover at least:

- `.minds/team.yaml`
- `.minds/mcp.yaml`
- `.minds/env.md`
- `.minds/team/<memberId>/{persona,knowledge,lessons}.md` and work-language variants (e.g. `persona.zh.md`)
- `.minds/memory/**` (shared + personal memory; see `dominds/main/tools/mem.ts` and `dominds/main/minds/load.ts`)

#### Override example: pinning a dependency app port (v0 draft)

(Target: planned) Treat ports as **publishable integration config**, not runtime state.

- an app declares `frontend.defaultPort` in its manifest (`.minds/app.yaml`).
- a workspace (or an integrating app) can pin a dependency app port via an override file:
  - `<rtws>/.apps/override/<target-app-id>/frontend.yaml`

Conventions:

- keep the file minimal (e.g. only `port: <number>`).
- the override file can be used in local rtws development, and can also be **shipped by an app package** (an app may include `.apps/override/<target-app-id>/frontend.yaml` as its “default override”).
- when a dependency app is integrated again by an outer app, the outer app override can override the inner app’s default override (overrides propagate along the integration chain).
- after the resolver computes a final port for a given rtws, it may write `<rtws>/.apps/resolution.yaml.assignedPort` to pin it (and `assignedPort` must be non-zero).

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

> Current (v0): the `.minds/team.yaml` parser supports this syntax.
> However, since app-context isolation/bridging is not implemented yet, `use` and `import` are runtime-equivalent for now.
> Also: `from`-only is accepted but has no effect in v0 (it is treated as a local member definition).

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

Recommend a short, stable problem id scheme that reflects the defining scope hierarchy.

- Shape: `team/team_yaml_error/members/<defining-app-id>/<local-id>/...`

Where:

- `<defining-app-id>` treats both rtws and kernel as “virtual apps”:
  - rtws may not have a manifest (`.minds/app.yaml`), but its virtual app-id is `rtws`
  - kernel virtual app-id is `kernel`
- `<local-id>` is the `members` key inside that scope.

Examples (illustrative):

- `team/team_yaml_error/members/rtws/scribe/use_and_import_conflict`
- `team/team_yaml_error/members/rtws/librarian/from/missing`
- `team/team_yaml_error/members/rtws/bad_from/from/invalid`

## “Dev app” mode: let an rtws run as an app

(Target: planned) Allow treating a workspace root as a “Dominds app under development”, reusing the same directory structure and mechanisms.

Analogy: in Node.js development, a repo is both source tree and working directory; dependencies resolve via the package manager.

### Expected behavior

- When the current working directory can be recognized as a Dominds App (has a manifest (`.minds/app.yaml`); cfg-only is allowed and may not have `package.json`), the kernel can enter dev app mode.
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
- apps resolution file: `dominds/main/apps/resolution-file.ts`
- apps runtime (proxy tools): `dominds/main/apps/runtime.ts`
- app teammates loader (prototype flat merge): `dominds/main/apps/teammates.ts`, `dominds/main/team.ts`
- manifest parser: `dominds/main/apps/manifest.ts`
- rtws seed (taskdocs): `dominds/main/apps/rtws-seed.ts`

---

This document is a draft; it will evolve together with implementation.
