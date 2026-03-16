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
  - App install handshake (`<app> --dominds-app`) can be consumed by the kernel/CLI.
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

### Install JSON (`npx <pkg> --dominds-app`)

Install JSON is the app-to-kernel/CLI **install-and-runtime handshake payload**. It may contain resolution snapshots, but its most important job is to declare the app runtime entry and provide a consistent source of truth for later resolution.

Recommended principles:

- Install JSON must carry the runtime entry handshake fields: `host.moduleRelPath` and `host.exportName`.
- Install JSON may carry resolution snapshots consumed at runtime, but should avoid long-lived dual-writing where the same semantic source is split across manifest and handshake with no clear precedence.
- The manifest (`.minds/app.yaml`) still owns app capability/asset semantics; Install JSON answers “how should this app package be loaded right now”.

#### App entry handshake contract

- For any external app, the **only valid runtime entry source** is `host.moduleRelPath` plus `host.exportName` from the `--dominds-app` handshake JSON.
- The kernel, CLI, tests, doctor/diagnostics, and any other consumers **must not** guess, fall back to, or hard-code default entry paths or export names such as `src/app.js`, `src/app-host.js`, `dist/app.js`, `createDomindsApp`, or `createDomindsAppHost`.
- Published apps and local/dev apps share the same handshake contract. The only difference is who executes the app bin and obtains install JSON, not how the entry is resolved.
- `resolution.yaml.installJson` is a **derived snapshot** from the last successful resolution. It is useful for observation and reuse, but it is not a truth source above a fresh handshake probe.

#### Public import surface (current contract)

- The package split is now the contract. Formal consumers should depend on `@longrun-ai/kernel` for app/runtime-facing contracts, and use `@longrun-ai/shell` only when a shell-facing contract is explicitly defined there; they must not depend on `dominds/main/**` or any root-package aggregation shim.
- `dominds/main/**`, `dominds/main/shared/**`, and `dominds/main/apps-host/**` are private implementation paths. They are repo-internal source trees, not a source-level public surface.
- `dominds/main/index.ts` is intentionally gone. The repo must not keep a legacy aggregation entry that suggests `main pkg` still offers a consumer import contract.
- `tests/**` is explicitly **not** evidence for widening the public surface. Test convenience imports must not turn private implementation modules into de-facto public API.

The boundary must be written once, in the actual published package contracts:

- `packages/kernel/package.json#exports` defines the supported `@longrun-ai/kernel` surface.
- `packages/shell/package.json#exports` defines the supported shell-facing `@longrun-ai/shell` surface; it does not imply CLI or integrated runtime ownership.
- `dominds/package.json#exports` is limited to CLI/aggregation-shell entrypoints such as `./cli`; it must not grow a root runtime import surface again.
- Published package resolution must reject deep imports such as `dominds/main/**`, `dominds/main/shared/**`, `dominds/main/apps-host/**`, and `dominds/dist/**`.

Keep the responsibilities split cleanly:

- Install JSON / handshake: answers “how to load the app entry module and app factory export”.
- manifest: answers “what capabilities, assets, dependencies, and defaults the app provides”.
- `.minds/app-lock.yaml`, `.apps/configuration.yaml`, `.apps/resolution.yaml`: answer “what this rtws locked, explicitly configured, and derived as resolved state”.

User-facing installation and the low-level handshake must stay clearly separated:

- The **user-facing install entrypoint** should be `dominds install <spec>`, not `npx <pkg> --dominds-app`.
- `--dominds-app` is a **kernel/CLI-to-app handshake flag** used by Dominds to retrieve install JSON. It is not meant to be the ordinary human-facing UX.
- For published apps, the kernel/CLI may resolve install JSON through `npx -y <pkg> --dominds-app` during resolution.
- For local apps under development, the kernel/CLI may call the local package bin through `dominds install <path> --local`, still passing the same `--dominds-app` handshake flag underneath.
- `npm install` / `pnpm add` only answers “where is the package downloaded/cached”. They do **not** register an app into the current rtws by themselves. The operation that actually adds the app into the current workspace dependency graph is still `dominds install`.
- File layouts such as `src/app.js`, `src/app-host.js`, or `dist/app.js` remain implementation choices made by the app author. Consumers must not depend on those names as part of the contract.

Recommended user mental model:

- `npm` / `pnpm`: package managers responsible for publishing, downloading, and caching.
- `npx`: one-shot execution of an npm package entrypoint; in the app system it mainly serves as the kernel's resolution/handshake backend.
- `dominds install`: the product-level Dominds command that updates `.minds/app.yaml`, `.minds/app-lock.yaml`, `<rtws>/.apps/configuration.yaml`, and `<rtws>/.apps/resolution.yaml`, making the app actually part of the current rtws capability graph.

(Current: implemented) existing anchors:

- JSON schema: `dominds/main/apps/app-json.ts` (`DomindsAppInstallJsonV1`).
- Apps configuration file: `dominds/main/apps/configuration-file.ts`.
- Apps resolution file: `dominds/main/apps/resolution-file.ts`.

(Current: implemented) the kernel now splits `<rtws>/.apps/configuration.yaml` from `<rtws>/.apps/resolution.yaml`:

- `configuration.yaml` carries user config: `resolutionStrategy?` (if present) overrides the default strategy, and `disabledApps` records explicit disables.
- `resolution.yaml` carries derived state only: `apps[]` stores `enabled` / `assignedPort` / `source` / `installJson`.
- If `configuration.yaml` is missing, strategy falls back to defaults (`order=['local']`, `localRoots=['dominds-apps']`) and no explicit disables apply.
- If `resolution.yaml` is missing, the snapshot starts empty and the kernel re-materializes it from the declared dependency graph.

(Current: implemented) self-heal behavior for common entrypoints is:

- `dominds webui`: the server startup path initializes apps runtime and re-materializes `<rtws>/.apps/resolution.yaml`.
- `dominds tui` / `dominds run`: before entering interactive runtime, Dominds refreshes enabled-app runtime/tool proxies and re-materializes `resolution.yaml`.
- `dominds read` / `dominds manual`: Dominds refreshes enabled app tool proxies first; if the root manifest still declares dependencies, this also re-materializes `resolution.yaml`.

Self-heal only works when both prerequisites hold:

- root `.minds/app.yaml` still declares the correct app id (for example `@longrun-ai/web-dev`), and
- the current resolution strategy can actually resolve that app (for example, default `localRoots=['dominds-apps']` contains `dominds-apps/@longrun-ai/web-dev/`, and that package's install handshake / manifest also declares the same app id).

If the root manifest / team config uses the wrong app id (for example, still declaring the legacy id `web_dev` or the old unscoped id `web-dev` inside `dependencies[].id` or `members.<id>.from` while the app now installs as `@longrun-ai/web-dev`), refresh will still re-materialize `resolution.yaml` as empty. That means self-heal did run; it just correctly recomputed an empty result from incorrect source declarations.

So even without `<rtws>/.apps/configuration.yaml` or `<rtws>/.apps/resolution.yaml`, as long as `.minds/app.yaml` declares dependencies, the kernel still resolves local apps via the default strategy; if the root manifest has no dependencies, the effective enabled apps set is empty.

### `phase-gate` first slice: frozen decisions

The following frozen decisions exist to let `phase-gate` become the first recommended TypeScript app without prematurely turning the whole change-governance space into a generic engine. The goal here is to freeze the smallest set of boundaries that would otherwise keep churning kernel contracts, host projection, product recovery actions, and user-facing copy.

This first slice only covers a single change moving through `intake -> routing -> advancement`, plus the two high-value product states `blocked` and `exception in progress`. The only loops included for the first slice are `blocking follow-up`, `exception handling`, and `rollback/recovery`. The first-slice object model stays limited to `change dossier`, `governance decision`, `recovery action`, and `route context`.

#### `Routing` must produce required governance semantics

- `Routing` is not merely “record that the change entered the flow”. It must produce the minimum business truth needed for later governance.
- For the first slice, that truth must include at least:
  - the current governance intensity (for example large/medium/small, or an equivalent tiering),
  - the responsibility boundary (who may continue by default, and who has blocking/approval authority),
  - whether the default advancement path is allowed.
- These semantics should live inside the existing `route context + governance decision` surface. Do not introduce a fifth first-slice object just to carry them.
- Once the flow enters `exception in progress`, the decision must also carry scope, time limit, approving responsibility, and compensating action(s); otherwise a constrained exception degrades into an ungoverned bypass.

#### Minimal formal input contract for `pre-drive decision -> host projection`

- The key first-slice contract is not “push app-private vocabulary into kernel”. It is to freeze how an app expresses whether the host may continue driving.
- The target direction should widen the current `continue | reject` shape into a formal surface that can express `allow / reject / block`; and for now `block` should carry only mechanism-level orchestration primitives such as `await_members`, `await_human`, and `await_app_action`.
- For `await_app_action`, the app must provide at least the following stable fields before the host may project it into a product-level recovery action:
  - `actionClass`
  - `actionId`
  - `owner`
  - `resolutionMode`
  - `targetRef`
  - enough target/summary material such as `title`, `promptSummary`, and, for `select`, `optionsSummary`
- Admission responsibility belongs to host projection: the app provides structured material; the host decides whether the material is sufficient for a concrete recovery action or must be uniformly downgraded to the fallback diagnostic path.
- This contract should be frozen before implementation starts. `dominds/packages/kernel/src/app-host-contract.ts` still exposes `DomindsAppRunControlResult` as only `continue | reject`, while existing `phase-gate` contract tests already depend on richer blocked / primary-action structures. That gap is the current hard blocker.

#### `Resume advancement` is a product action, not an implicit state jump

- The first slice must expose one explicit, product-level recovery action: `resume advancement`.
- The reason is simple: `blocking follow-up`, `exception handling`, and `rollback/recovery` only cover “handle the abnormal condition first”. They do not answer “how does the user clearly re-enter the main path once the abnormal condition is resolved?”
- So after follow-up is completed, an exception is granted/closed, or recovery finishes, host projection must be able to surface a clear “you may now resume advancement” action, instead of hiding that step inside a silent state transition or an implementation detail.

#### Unified fallback label: `View problem details`

- When the app does not provide enough structured material to form a concrete recovery action, the product layer must not surface hollow action classes or implementation placeholders. It should uniformly downgrade to the `inspect_problem` path.
- The default external label for that path is now fixed as: `View problem details`.
- Internal identifiers such as `inspect_problem`, `select`, `confirm`, `input`, `driver`, `wiring`, and `host adapter` should not appear in user-facing primary sentences by default.
- If implementation keeps internal names such as `input`, the projected user copy should still say something like “Provide information” or “Fill in information”, not the raw internal identifier.

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

### Reference design: Web Dev App (replacing the old prototype-app narrative)

Instead of continuing to discuss app semantics around an accidental prototype, this document now uses a more durable reference design: **Web Dev App**.

Its goal is not to represent one specific product. Its goal is to provide a high-frequency, easy-to-validate app shape:

- focused on web development and browser regression work,
- packaging browser interaction capability as an explicit toolset,
- shipping a minimal but complete team with at least `web_tester` and `web_developer`.

Design stance:

- `Web Dev App` is an **integrator-style app**. The important part is the packaging of team, toolsets, environment guidance, and collaboration posture, not a demo business frontend.
- It should reuse existing capabilities where possible instead of inventing a new browser automation protocol inside the app.
- The current upstream capability to learn from is OpenAI's `playwright-interactive` entry in the `skills` repo. It appears as a `SKILL.md` largely because the upstream product treats `js_repl` as a built-in capability and uses the skill layer to explain how to operate it. Dominds should not inherit that split directly. A more self-consistent Dominds packaging boundary is to ship **dedicated tools + toolset manual + recommended teammate definitions** as one app-level capability. In that sense, `Web Dev App` is not “wrapping a pure skill”; it is re-packaging the same capability family with a cleaner product boundary.

So `Web Dev App` should make the `playwright-interactive` relationship explicit as two separate layers:

1. **Product-semantic layer (in scope for this design)**
   - define a stable toolset name such as `playwright_interactive`;
   - define which teammates receive it, what problem it solves, and when to use it;
   - ship the related `.minds/team.yaml`, member persona/knowledge/lessons, `.minds/env.md`, toolset manual, etc.
2. **Execution-backend layer (replaceable implementation detail)**
   - the app may provide its own dedicated tools and productize a browser-interaction capability in the same family as `playwright-interactive`;
   - or later be replaced by an equivalent MCP server / local App Host module;
   - as long as the team-facing toolset contract does not drift.

It must be explicit that **an app is not the same thing as a skill**, and that both are now first-class mechanisms in the current implementation:

- An **app** is a Dominds install/resolve/composition unit. It has an `id`, a manifest (`.minds/app.yaml`), team-facing assets (`.minds/team.yaml`, persona/knowledge/lessons), env docs (`.minds/env.md`), and participates in rtws-level lock/configuration/resolution.
- A **skill** is a pure-Markdown capability asset inside the rtws. It is currently loaded from `.minds/skills/team_shared/**` and `.minds/skills/individual/**`, selects `SKILL.cn.md` / `SKILL.en.md` / `SKILL.md` by work language preference, and injects the body directly into the agent system prompt. It is best suited for soft guidance, checklists, decision heuristics, and team-specific methods, not for distributable product capability that depends on a stable tool contract.
- Skill frontmatter currently supports `name`, `description`, `allowed-tools`, `user-invocable`, and `disable-model-invocation`; the last three are currently compatibility/migration metadata only. They do not automatically grant tool permissions and do not replace team/toolset runtime policy.
- A **toolset manual / app-bundled manual** is a better place for guidance that is shipped together with tools: it is skill-like in tone, but distributed together with dedicated tools, toolsets, and app identity. That is a better fit for something like `web-dev`.
- `playwright-interactive/` should not be classified as that pure-Markdown rtws skill category. More precisely, it represents a guidance layer on top of built-in browser execution capability. In Dominds, the cleaner move is to package dedicated tools, toolset manual, recommended teammate definitions, and runtime state together as an app such as `@longrun-ai/web-dev`.
- In Dominds terminology, **workflow** should preferably be reserved for hard process mechanisms such as `phase-gate`, which carry phase/gate/quorum/rollback/auto-advance semantics. Skills and toolset manuals are closer to guidance layers or operating manuals than to a workflow engine.

So the correct story is not “install a pure skill as an app”. The correct story is:

- if the content is **pure prompt/pure Markdown and needs no extra tool capability**, keep it directly as an rtws skill,
- once a capability package needs dedicated tools, external binaries, MCP, App-provided tools, stable toolset naming, teammate assembly, or dependency resolution, package **tools + toolset manual + recommended teammate definitions + team-facing contract** as an app,
- when other apps depend on that capability, they should depend on the packaged app rather than expecting each workspace to copy the skill and hand-wire tools,
- the app exposes the stable team/toolset/env contract, while the low-level skill / MCP / local App Host backend may change later without changing the app identity or team-facing semantics.

The shortest rule of thumb is:

- **skills own soft guidance, toolset manuals own tool-coupled operating guidance, and apps own tool capability, dependency relationships, and the team-facing contract.**

Suggested user-facing installation flow:

```bash
# Local app under development
dominds install ./dominds-apps/@longrun-ai/web-dev --local --enable

# Published npm app (target shape)
dominds install @longrun-ai/web-dev --enable
```

Web Dev App needs three names kept distinct to avoid drift:

- installable app id: `@longrun-ai/web-dev`
- local development directory: `dominds-apps/@longrun-ai/web-dev/`
- npm package name: `@longrun-ai/web-dev`

That means workspace `.minds/app.yaml` `dependencies[].id`, `.minds/team.yaml` `members.<id>.from`, and `<rtws>/.apps/resolution.yaml` `apps[].id` must all use `@longrun-ai/web-dev`; the local development directory and npm package should stay aligned to that same scoped identity so the app no longer carries split naming.

After installation, the user should expect these files to change:

- `.minds/app.yaml`: root dependency declaration is updated.
- `.minds/app-lock.yaml`: app package version is frozen.
- `<rtws>/.apps/configuration.yaml`: explicit enable/disable intent is recorded.
- `<rtws>/.apps/resolution.yaml`: effective source, enabled state, and stable `assignedPort` are materialized.

Suggested minimal asset shape:

```text
@longrun-ai/web-dev/
├── package.json
├── .minds/
│   ├── app.yaml
│   ├── team.yaml
│   ├── env.md
│   ├── app-lock.yaml
│   └── team/
│       ├── web_tester/
│       │   ├── persona.zh.md
│       │   ├── knowledge.zh.md
│       │   └── lessons.zh.md
│       └── web_developer/
│           ├── persona.zh.md
│           ├── knowledge.zh.md
│           └── lessons.zh.md
├── bin/
│   └── <app>.js
└── src/
    └── app.js
```

Suggested team shape:

- `web_tester`
  - primary responsibility: run browser interaction, perform regression walkthroughs, collect screenshot/console/network evidence;
  - default toolsets: `playwright_interactive` plus read-only workspace tools such as `ws_read`;
  - non-goal: does not directly edit product code or take over build/process management.
- `web_developer`
  - primary responsibility: implement UI/interaction fixes, consume `web_tester` findings, and close the loop;
  - default toolsets: code-edit/search tools such as `codex_style_tools` (or equivalent) plus optional access to read tester evidence;
  - non-goal: should not blur browser acceptance into an implicit “I also tested it” posture; when acceptance is needed, it should explicitly tell/ask `web_tester`.

Suggested `team.yaml` fragment:

```yaml
members:
  web_tester:
    name: Web Tester
    icon: '🧪'
    toolsets:
      - ws_read
      - playwright_interactive

  web_developer:
    name: Web Developer
    icon: '🛠️'
    toolsets:
      - ws_read
      - codex_style_tools
```

Requirements for the `playwright_interactive` toolset design:

- It should be treated as a **stable team-facing capability name**, not as a hard-coded implementation detail tied forever to one backend.
- At minimum it should cover these task intents:
  - open/reuse a browser session,
  - navigate to a target URL,
  - perform interaction and assertions,
  - capture screenshots and key debugging evidence,
  - preserve the “reusable session across multiple fix iterations” mental model.
- If the current phase does not yet ship a directly executable backend, the docs must label it as a **target contract (planned)** instead of pretending it is already built in.

Current prototype note (`dominds-apps/@longrun-ai/web-dev`, as of March 8, 2026):

- The app is already installable and contributes `web_tester` / `web_developer` teammates plus a live `playwright_interactive` toolset registration.
- The installable app id remains `@longrun-ai/web-dev`; the local development directory and npm package also keep the same scoped identity so the app no longer carries split naming.
- `playwright_session_new/list/status/eval/attach/detach/close` and cross-dialog reminder sync are already implemented.
- `kind: "web"` sessions now create a real Playwright-backed browser/context/page runtime and report live page surfaces via session status/reminders.
- `kind: "electron"` is **not** at the same completion level yet: it still falls back to the older prototype runtime path and should be treated as unfinished.
- Reminder UX contract: tool output may summarize reminder-sync actions, but the reminder panel is the authoritative surface for attachment state.
- Runtime refresh contract: after enabling the app, a full Dominds instance restart should not be required just to discover the toolset; the next minds reload / tools-registry fetch should refresh enabled app tool proxies. This does **not** mean in-flight prompts are rewritten retroactively.
- Remaining gap list for the browser capability layer: screenshot / console / network evidence are not yet exposed as first-class tool outputs, and there is not yet a production-grade browser lifecycle manager.
- Restart boundary: if the kernel/apps-host process restarts, persisted session records remain but the in-memory browser runtime degrades and must be recreated.

Why this app shape matters:

- It makes `.minds/team.yaml` collaboration semantics concrete: development and testing are two long-lived teammates, not vague temporary roles.
- It validates whether “app provides team + toolset + env docs” is expressive enough for a real collaborative capability package.
- It gives future skill/MCP/local-host convergence a stable semantic anchor at the app layer.

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
