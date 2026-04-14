# Team Management Toolset (`team_mgmt`)

Chinese version: [中文版](./team_mgmt-toolset.zh.md)

This document specifies a dedicated **team management toolset** whose only job is managing the
rtws’s “mindset” configuration files under `.minds/` (team roster, LLM providers, and agent
minds files), without granting broad rtws access.

> Historical note: the runtime/manual entrypoint has since been unified to
> `man({ "toolsetId": "team_mgmt" })`, which now renders the authoritative handbook content.

The outer repository root is the **rtws** (runtime workspace). All paths below are relative to the
rtws root.

## Motivation

We want a safe way for a “team manager” agent (typically the shadow teammate `fuxi`) to:

- Create/update `.minds/team.yaml` (team roster + permissions + toolsets).
- Create/update `.minds/llm.yaml` (LLM provider definitions overriding defaults).
- Create/update `.minds/mcp.yaml` (MCP server definitions that register dynamic toolsets).
- Create/update `.minds/team/<member>/{persona,knowledge,lessons}.md` (agent minds).

At the same time, we do **not** want to hand that agent full rtws read/write (e.g. the
equivalent of the `ws_mod` toolset + unrestricted `read_dirs`/`write_dirs`), because:

- Editing `.minds/team.yaml` is inherently a **privilege escalation surface** (it controls tool
  availability and directory permissions).
- Editing `.minds/llm.yaml` can change network destinations and model/provider behaviors.
- A “bootstrap” team manager should be able to configure the team without being able to change the
  product code, `.dialogs/`, etc.

## Migration Plan (Replacing legacy builtin team-manager knowledge)

This document is a **design spec** for the new `team_mgmt` toolset. It is not something we should
ever tell an agent to “look up” at runtime.

Instead, the runtime “single source of truth” for team management guidance should be
`man({ "toolsetId": "team_mgmt" })`.

Historically, some of the guidance lived in a legacy builtin “team manager” mind set inside the
`dominds/` source tree. That legacy builtin is being removed. The runtime “single source of truth”
should be the `man({ "toolsetId": "team_mgmt" })` output.

Planned change:

- Route team-management handbook content through the generic `man` tool under
  `man({ "toolsetId": "team_mgmt" })`, covering file formats, workflows, and safety.
- Remove legacy builtin guidance to avoid duplication. If any stub remains, it must point to
  `man({ "toolsetId": "team_mgmt" })` (and not to this design document).

Rationale:

- The manual is versioned with the tool behavior, so it stays accurate.
- The framework source tree should not be the “primary” place the team config format is explained.
  Each rtws may have different policies and defaults.

### Scope Boundary of This Document (important)

- This document is responsible for stable design intent, conceptual boundaries, responsibility split,
  and why the system is designed this way.
- This document should **not** become a home for overly detailed runtime specifications such as exact
  injection order, current fallback rules, full topic inventories, dynamic enumeration results,
  field-by-field rendering details, or authoring rules that are expected to evolve with the implementation.
- For “what the runtime does today”, use:
  - `man({ "toolsetId": "team_mgmt" })`
  - the corresponding implementation and runtime validators
- If the design document and the runtime handbook disagree about current behavior, the runtime handbook
  wins and the design doc should be corrected afterward. Readers should not treat this design doc as a
  runtime specification manual.

## Current Problem Statement

In typical deployments we deny direct `.minds/` access via the general-purpose rtws tools:

- `fs` / `txt` (`list_dir`, `read_file`, `overwrite_entire_file`, …)

This makes sense for “normal” agents, but it blocks the team manager from doing its job.

## Goals / Non-Goals

**Goals**

- Enable a trusted team manager to manage only the `.minds/` configuration surface.
- Provide a single “manual” tool to teach the correct file formats and safe best practices.
- Keep the tool behavior predictable and statically scoping paths to `.minds/` (no clever
  auto-discovery outside that subtree).

**Non-goals**

- Replacing the existing `ws_read` / `ws_mod` toolsets.
- Providing general-purpose file editing across the repo.
- Making `.minds/` broadly writable by default team members.

## Proposed `team_mgmt` Toolset

The `team_mgmt` toolset mirrors a minimal subset of `fs`/`txt`, but **hard-scopes** all operations to
`.minds/` and rejects anything outside.

### Naming Conventions (Human / UI)

- **Tools** use `snake_case` (underscore-separated) for tool IDs (e.g. `team_mgmt_validate_team_cfg`). Avoid
  `kebab-case` aliases for tool IDs; if UX needs a friendlier label, treat that as presentation-only.
- **Teammates** use either `kebab-case` (hyphen-separated) or an “internet name” (dot-separated).
- This is a convention for docs/UI/readability only; do not enforce it via validation or other
  technical mechanisms.

### Tools

Recommended tools (names are suggestions; use `snake_case` to match existing tools):

| Tool name                              | Based on | Purpose                                                                           | Default allowlist scope |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------- | ----------------------- |
| `team_mgmt_list_dir`                   | `fs`     | List directories/files under `.minds/`                                            | `.minds/**`             |
| `team_mgmt_read_file`                  | `txt`    | Read a text file under `.minds/`                                                  | `.minds/**`             |
| `team_mgmt_create_new_file`            | `txt`    | Create a new file under `.minds/` (empty content allowed; refuses overwrite)      | `.minds/**`             |
| `team_mgmt_overwrite_entire_file`      | `txt`    | Overwrite an existing file under `.minds/` (guarded exception path)               | `.minds/**`             |
| `team_mgmt_prepare_file_range_edit`    | `txt`    | Prepare a single-file edit by line range under `.minds/` (returns a diff hunk id) | `.minds/**`             |
| `team_mgmt_prepare_file_append`        | `txt`    | Prepare an append-to-EOF edit under `.minds/` (returns a diff hunk id)            | `.minds/**`             |
| `team_mgmt_prepare_file_insert_after`  | `txt`    | Prepare inserting after an anchor under `.minds/` (returns a diff hunk id)        | `.minds/**`             |
| `team_mgmt_prepare_file_insert_before` | `txt`    | Prepare inserting before an anchor under `.minds/` (returns a diff hunk id)       | `.minds/**`             |
| `team_mgmt_prepare_file_block_replace` | `txt`    | Prepare a block replace between anchors under `.minds/` (returns a diff hunk id)  | `.minds/**`             |
| `team_mgmt_apply_file_modification`    | `txt`    | Apply a planned modification by hunk id under `.minds/`                           | `.minds/**`             |
| `team_mgmt_mk_dir`                     | `fs`     | Create directories under `.minds/`                                                | `.minds/**`             |
| `team_mgmt_move_file`                  | `fs`     | Move/rename files under `.minds/`                                                 | `.minds/**`             |
| `team_mgmt_move_dir`                   | `fs`     | Move/rename directories under `.minds/`                                           | `.minds/**`             |
| `team_mgmt_rm_file`                    | `fs`     | Delete files under `.minds/`                                                      | `.minds/**`             |
| `team_mgmt_rm_dir`                     | `fs`     | Delete directories under `.minds/`                                                | `.minds/**`             |
| `team_mgmt_validate_priming_scripts`   | new      | Validate path constraints and script format under `.minds/priming/**.md`          | `.minds/**`             |
| `team_mgmt_validate_team_cfg`          | new      | Validate `.minds/team.yaml` and publish issues to the Problems panel              | `.minds/**`             |
| `man({ "toolsetId": "team_mgmt" })`    | builtin  | Handbook entrypoint for the `team_mgmt` toolset (see below)                       | N/A                     |

Notes:

- Include the full `.minds/` lifecycle (create, update, rename/move, delete). The team manager must
  be able to correct mistakes and recover from accidental corruptions (including ones introduced by
  other tools).
- After any change under `.minds/priming/**`, the team manager should run
  `team_mgmt_validate_priming_scripts({})` to ensure startup script paths/formats are parseable.
- After any change to `.minds/team.yaml`, the team manager should run `team_mgmt_validate_team_cfg({})`
  to ensure all errors are detected and surfaced (and to avoid silently omitting broken member configs).
- Path handling should be strict:
  - Reject absolute paths.
  - Reject paths containing `..`.
  - Reject any path that resolves outside `.minds/` after normalization.
- Prefer an explicit allowlist over “anything in the rtws”.
  - For `team_mgmt`, that explicit allowlist is `.minds/**` (including `.minds/memory/**`) so the
    team manager can repair accidental corruptions made by other tools (even though `.minds/memory/**`
    already has dedicated `personal_memory` / `team_memory` tools for normal use).
- Conversely, the denial of `.minds/**` / `*.tsk/**` for general file tools is a **built-in hard runtime
  rule**, not a standard deny stanza you should keep repeating in `team.yaml`. Only additional
  business-specific constraints belong in explicit `no_read_dirs` / `no_write_dirs`.
- Require explicit `.minds/...` paths and validate them; do not support “implicitly scoped” paths
  like `team.yaml`.

### Why a dedicated toolset (instead of only `read_dirs` / `write_dirs`)?

`read_dirs` / `write_dirs` are still valuable, but they are configured in `.minds/team.yaml`, which
may not exist during bootstrap. A dedicated `team_mgmt` toolset:

- Lets the team manager create `.minds/team.yaml` safely from “zero state”.
- Keeps the scope bounded even if the member’s directory allow/deny lists are empty.
- Makes it easy to grant _just_ team management capabilities to an ad-hoc agent without full rtws
  access.

## Team Handbook via `man({ "toolsetId": "team_mgmt" })`

We need a single in-chat manual tool so the team manager can reliably self-serve guidance without
reading source code.

### Command shape

- `man({ "toolsetId": "team_mgmt" })` → show a short index (topics).
- `man({ "toolsetId": "team_mgmt", "topics": ["topics"] })` → list topics.
- `man({ "toolsetId": "team_mgmt", "topics": ["llm"] })` → how to manage `.minds/llm.yaml` (+ templates).
- `man({ "toolsetId": "team_mgmt", "topics": ["llm", "builtin-defaults"] })` → show builtin providers/models (from defaults).
- `man({ "toolsetId": "team_mgmt", "topics": ["mcp"] })` → how to manage `.minds/mcp.yaml` (+ templates).
- `man({ "toolsetId": "team_mgmt", "topics": ["mcp"] })` → how to manage `.minds/mcp.yaml` (transports, env/headers, tools whitelist/blacklist, naming transforms, hot reload, leasing).
- `man({ "toolsetId": "team_mgmt", "topics": ["mcp", "troubleshooting"] })` → common MCP failure modes and how to recover.
- `man({ "toolsetId": "team_mgmt", "topics": ["team"] })` → how to manage `.minds/team.yaml` (+ templates).
- `man({ "toolsetId": "team_mgmt", "topics": ["team", "member-properties"] })` → list supported member fields and meanings.
- `man({ "toolsetId": "team_mgmt", "topics": ["minds"] })` → how to manage `.minds/team/<id>/*.md` (persona/knowledge/lessons).
- `man({ "toolsetId": "team_mgmt", "topics": ["skills"] })` → how to manage `.minds/skills/*` (injection point, tone, heading levels, migration boundaries).
- `man({ "toolsetId": "team_mgmt", "topics": ["priming"] })` → how to manage startup scripts under `.minds/priming/*`.
- `man({ "toolsetId": "team_mgmt", "topics": ["env"] })` → how to manage `.minds/env.*.md` (runtime-environment injection point, tone, heading levels).
- `man({ "toolsetId": "team_mgmt", "topics": ["toolsets"] })` → inspect the actually visible toolsets in the current installation/rtws and common grant patterns.
- `man({ "toolsetId": "team_mgmt", "topics": ["permissions"] })` → how `read_dirs`/`write_dirs` and deny-lists work.
- `man({ "toolsetId": "team_mgmt", "topics": ["troubleshooting"] })` → common failure modes and how to recover.

The manual should accept **multiple** `topics` entries (a simple topic “path”); the tool should
select the most specific match and fall back to the nearest parent when needed.

If UX wants a friendlier label than `man`, treat that as presentation-only; the
canonical runtime entrypoint remains `man({ "toolsetId": "team_mgmt" })`.

## Manual Coverage Requirements (legacy coverage)

As part of the migration away from the legacy builtin team-manager knowledge files, the manual
must cover (at minimum) the information that used to live there:

- `!team`:
  - Explain `member_defaults`, `default_responder`, and `members` (structure overview).
  - Include an explicit “member configuration properties” reference (fields table) via
    `!team !member-properties`:
    - `name`, `icon`, `gofor`, `provider`, `model`, `toolsets`, `tools`, `streaming`, `hidden`
    - `read_dirs`, `no_read_dirs`, `write_dirs`, `no_write_dirs`
- `!llm`:
  - Explain the provider map structure used by `.minds/llm.yaml` and how it relates to
    `.minds/team.yaml` (`provider` + `model` keys).
  - Provide a “builtin defaults” view via `!llm !builtin-defaults`.
    - Implementation guidance: render this content from `dominds/main/llm/defaults.yaml` at runtime
      (or via a shared helper) rather than copy/pasting a static block into code, so it won’t drift.
- `!mcp`:
  - Explain `.minds/mcp.yaml` as the source of dynamic MCP toolsets.
  - Explain how MCP servers map to toolsets (`<serverId>`) and how those toolsets are granted via
    `.minds/team.yaml`.
  - Explain tool exposure controls (whitelist/blacklist) and naming transforms (prefix/suffix).
  - Explain secret/env wiring patterns and operational troubleshooting (Problems + logs, restart,
    hot reload semantics).
- `!skills`:
  - Explain `.minds/skills/*` as reusable team skill assets.
  - Explain the boundary that a skill is prompt/guidance content, not a permission system.
  - Explain when content should remain a skill versus being elevated into an app / toolset /
    teammate contract.
- `!env`:
  - Explain `.minds/env.*.md` as the place for current-rtws runtime-environment orientation, not
    persona definition or a dump of repo-wide policy.
  - Explain its boundary relative to `persona/knowledge/lessons`, skills, and priming.
- `!toolsets`:
  - Explain that the visible toolsets include built-in toolsets, toolsets exposed by installed
    apps, and MCP toolsets dynamically registered from `.minds/mcp.yaml`.
  - Explain why this topic must be rendered from runtime state rather than maintained as a static
    list in the design docs.

## Dynamic Loading from the Dominds Installation (Runtime Resources)

Where appropriate, the manual should **dynamically load** its “reference” content from the running
`dominds` installation (i.e. the files and registries shipped with the installed backend), rather
than duplicating that content in:

- `.minds/*` (rtws state), or
- docs, or
- hardcoded strings inside tool implementations.

This keeps the manual accurate when the framework changes, and avoids documentation drift.

Recommended sources by topic:

- `man({ "toolsetId": "team_mgmt", "topics": ["llm", "builtin-defaults"] })`
  - Load from the same installation resource the runtime uses for defaults:
    `dominds/main/llm/defaults.yaml` (via `__dirname` resolution in the backend build output).
  - Prefer reusing `LlmConfig.load()` and formatting its merged view, or adding a helper that returns
    both “defaults-only” and “merged” provider maps.
- `man({ "toolsetId": "team_mgmt", "topics": ["toolsets"] })`
  - Load from the in-memory registries at runtime (`listToolsets()` / `listTools()` in
    `dominds/main/tools/registry.ts`), rather than maintaining a separate list.

### Why `toolsets` Must Stay a Dynamic Topic

- `toolsets` is not a stable inventory that should be hardcoded in a design document.
- The visible toolsets are jointly determined by:
  - framework built-ins
  - toolsets exposed by the currently installed Dominds apps
  - MCP toolsets mapped at runtime from `.minds/mcp.yaml` `servers.<serverId>`
- The MCP portion is inherently **dynamic**: teams can add/remove servers, rename exposure, and
  constrain tool exposure per rtws, so the resulting toolset set changes with the live installation
  and workspace state.
- This is intentional. The design binds capability discovery to the actual runtime environment
  instead of to a static document that will drift:
  - it avoids maintaining a doomed-to-drift toolset list in the design docs
  - it avoids misleading readers into treating MCP-derived toolsets as framework built-ins
  - it ensures the team manager sees the capabilities that are truly available in this installation
    and this rtws right now
- Therefore the design docs should explain the mechanism and rationale only; the current toolset list
  belongs to runtime `man(...topics:["toolsets"])`.

Keep these as **static/manual text** (not dynamically loaded):

- High-level explanations, best practices, and “why” sections.
- Schema summaries (e.g. the member field table). These can be authored as a stable contract and
  validated in code reviews; runtime introspection of TypeScript types is not reliable post-build.

## Managing `.minds/priming/*` (startup scripts)

Startup script directories:

- Individual: `.minds/priming/individual/<member-id>/<slug>.md`
- Team shared: `.minds/priming/team_shared/<slug>.md`

Core principles:

- Startup scripts are mapped into real dialog history; they are not read-only logs.
- Their runtime semantics are not “extra system prompt text”, but “restore reminders first, then replay records into dialog history where possible”.
- Therefore tone must follow the chosen record type: write `human_text_record` as what a user/requester says to the agent; write `agent_words_record` as what the agent has already said; use `agent_thought_record` only sparingly for internal reasoning traces.
- Some technical record types such as `ui_only_markdown_record` are persisted but do not become model-facing chat messages, so they should not be your main steering layer.
- The outer file structure should be “top-level frontmatter + repeated `### record <type>` blocks”; do not wrap the file in decorative `# Startup Script` / `## History` headings.
- Team managers should treat them as editable startup playbooks.
- Freely add/edit assistant or user messages, and fully rewrite scripts when workflows evolve.

Recommended format:

- Frontmatter (optional, recommended): metadata such as `title` and `applicableMemberIds`.
- Record blocks (required): `### record <type>` with the actual content inside the corresponding markdown/json block.

Maintenance guidance:

- Organize scripts with meaningful hierarchical slugs (for example `release/webui/smoke-v1`).
- WebUI “save current course as script” exports are starting points; managers should review and rewrite into stable playbooks.

## Managing `.minds/llm.yaml`

### What it does

`dominds` loads built-in provider definitions from `dominds/main/llm/defaults.yaml` and then merges
in rtws overrides from `.minds/llm.yaml` (rtws keys override defaults). See:

- `dominds/main/llm/client.ts` (`LlmConfig.load()`)
- `dominds/main/llm/defaults.yaml` (builtin provider catalog)

### File format (template)

`.minds/llm.yaml` must contain a `providers` object. Each provider is keyed by a short identifier
used in `.minds/team.yaml` member configurations.

`apiType` notes (common values):

- `openai`: uses the OpenAI **Responses API** (best for OpenAI official endpoints; requires a `/v1`-style `responses` endpoint)
- `openai-compatible`: uses the OpenAI **Chat Completions API** (best for most “OpenAI-compatible” third-party/proxy endpoints; e.g. Volcano Engine Ark `.../api/v3`)
  - **Vision support**: if the provider/model supports multimodal Chat Completions, Dominds will pass tool-output images (`func_result_msg.contentItems[].type=input_image`, e.g. from MCP tools) to the model as `image_url` inputs after reading the persisted artifact; unsupported mime types are downgraded to text.

```yaml
providers:
  openai:
    name: OpenAI
    apiType: openai
    baseUrl: https://api.openai.com/v1
    apiKeyEnvVar: OPENAI_API_KEY
    tech_spec_url: https://platform.openai.com/docs
    api_mgmt_url: https://platform.openai.com/api-keys
    models:
      gpt-5.2:
        name: GPT-5.2
        context_length: 272000
        input_length: 272000
        output_length: 32768
        context_window: 272K
```

Best practices:

- Store **no secrets** in `.minds/llm.yaml`. Use `apiKeyEnvVar` and environment variables.
- Add only providers you truly need. Most setups should rely on `defaults.yaml`.
- Keep model keys stable; they become the `model` values used in `.minds/team.yaml`.

## Managing `.minds/mcp.yaml` (MCP Servers)

### What it does

`.minds/mcp.yaml` configures MCP (Model Context Protocol) servers as a first-class tool source.
Each configured server registers a Dominds **toolset** named `<serverId>` and a set of tools
under that toolset.

This file is **hot-reloaded** at runtime (no server restart required). If the file is absent, MCP
support is disabled (no dynamic MCP toolsets are registered).

Reference specs:

- MCP behavior and semantics: [`mcp-support.md`](./mcp-support.md)

### Mapping: server → toolset (and granting it)

- Server ID `sdk_http` registers toolset `sdk_http`.
- To allow a teammate to use the MCP tools, grant the toolset in `.minds/team.yaml`:

```yaml
members:
  alice:
    toolsets:
      - ws_read
      - sdk_http
```

Notes:

- MCP tool names are global across all toolsets (built-in + MCP). Collisions cause tools to be
  skipped and should surface via Problems + logs.
- `mcp_admin` is a built-in toolset that contains `mcp_restart` (best-effort per-server restart).
- Optional per-toolset manual can live in `.minds/mcp.yaml` at `servers.<serverId>.manual` using:
  - `content`: overview text
  - `sections`: chapterized guidance (`[{ title, content }]` or `{ "<title>": "<content>" }`)
- Missing manual does **not** mean the toolset is unavailable; it means team-manager documentation
  is incomplete. Agents should continue by reading each tool’s own description/arguments.
- Team-manager recommendation: after MCP config validation passes, carefully read each exposed tool
  description, discuss intended rtws usage with the human user, then write
  `servers.<serverId>.manual` that captures typical usage patterns, primary intent directions, and
  unavailable-case business handling rules.
- Use a semi-structured chapter shape: high-value sections often include `When To Use`,
  `Guardrails`, and `Business Handling When Unavailable`, but do not force every toolset into one
  fixed template. Start from the real business goal, then decide which sections deserve depth,
  which can stay brief, and which should be merged or renamed to fit the scenario.
- For each MCP toolset, deliberately document unavailable-case business handling rules. At minimum,
  answer:
  - whether a temporarily unavailable toolset must be escalated to a coordinator or specialist
  - whether a manual or alternate-tool fallback path is allowed
  - which business actions must pause until the toolset recovers

### File format (template)

```yaml
version: 1
servers:
  <serverId>:
    # Transport: stdio
    transport: stdio
    command: npx
    args: ['-y', '@playwright/mcp@latest']
    cwd: '.' # optional; defaults to Dominds process cwd
    env: {}

    # Transport: streamable_http
    # transport: streamable_http
    # url: http://127.0.0.1:3000/mcp
    # headers: {}
    # sessionId: '' # optional

    # Tool exposure controls
    tools:
      whitelist: [] # optional
      blacklist: [] # optional

    # Tool name transforms
    transform: [] # optional

    # Optional toolset manual for agents
    manual:
      content: "What this MCP toolset is for"
      sections:
        - title: "When To Use"
          content: "Use when ..."
        Guardrails: "Avoid ..."
        UnavailablePolicy: "If temporarily unavailable: ask @coordinator whether to switch to the fallback path; only ... may substitute, and tasks involving ... must pause until recovery."
```

### Tool exposure controls (whitelist / blacklist)

Use `tools.whitelist` / `tools.blacklist` to reduce the exposed tool surface and avoid UI clutter.
Patterns use `*` wildcards and apply to the **original MCP tool name** (before transforms), so
filters remain stable even if naming transforms change later.

### Naming transforms (prefix / suffix)

MCP servers often export short/common tool names (`open`, `search`, `list`, …). Use transforms to
avoid global collisions and make tool names recognizable:

```yaml
transform:
  - prefix: 'playwright_'
  - suffix: '_mcp'
```

### Env and headers wiring

Prefer copying from the host environment for secrets:

```yaml
env:
  MCP_TOKEN:
    env: MY_LOCAL_MCP_TOKEN
```

For `streamable_http`, `headers` supports the same literal-or-env mapping.

### Operational behavior (hot reload + last-known-good)

- Config edits should apply without restart.
- If a server update fails (spawn/connect/schema/name collision/etc.), the system should keep that
  server’s **last-known-good** toolset registered and surface a Problem describing the failure.
- Deleting `.minds/mcp.yaml` should unregister all MCP-derived toolsets/tools and auto-clear related
  MCP Problems.

## Managing `.minds/team.yaml`

### What it does

`.minds/team.yaml` defines:

- The team roster (`members`).
- Defaults applied to all members (`member_defaults`).
- Tool availability (`toolsets` / `tools`).
- Directory access control for rtws file tools (`read_dirs`, `write_dirs`, `no_*`).

The file is loaded by `Team.load()` in `dominds/main/team.ts`. If the file is absent, the runtime
bootstraps a default team (today it creates shadow members `fuxi` + `pangu`).

### File format (template)

```yaml
member_defaults:
  provider: codex
  model: gpt-5.2
  toolsets:
    - ws_read
    - personal_memory

default_responder: fuxi

members:

Note: in the normal-member example above, do **not** add `no_read_dirs` / `no_write_dirs` merely to
restate that `.minds/**` is blocked. That boundary is already enforced by the runtime for general
file tools; explicit deny entries should be reserved for extra constraints beyond the built-ins.
  # Example visible teammate (recommended): define at least one non-hidden responder for daily work.
  dev:
    name: Dev
    icon: '🧑‍💻'
    toolsets:
      - ws_mod
      - os
    streaming: true
```

Important notes:

- `member_defaults.provider` and `member_defaults.model` are required (see validation in
  `dominds/main/team.ts` and server error messages in `dominds/main/server/api-routes.ts`).
- Member objects use **prototype fallback** to `member_defaults` (see `Object.setPrototypeOf` in
  `dominds/main/team.ts`). Omitted properties inherit defaults automatically.
- Directory patterns are evaluated by `matchesPattern()` in `dominds/main/access-control.ts`:
  - Patterns behave like “directory scopes”, and support `*` and `**`.
  - Deny-lists (`no_*`) are checked before allow-lists (`*_dirs`).

Best practices:

- Make `member_defaults` conservative. Grant additional tools/dirs on a per-member basis.
- Prefer toolsets over individually enumerating tools unless you need a one-off tool.
- Platform note: Windows runtime intentionally does not register `codex_style_tools`; do not grant that toolset in `.minds/team.yaml` on Windows hosts.
- Keep `.minds/team.yaml` ownership tight; only the team manager should be able to edit it.
- Avoid repeating built-in constraints in `team.yaml`:
  - `*.tsk/**` (encapsulated Taskdocs) are hard-denied for all general file tools.
  - `.minds/**` is hard-denied for general file tools; only the dedicated `team_mgmt` toolset can access it.
    Put these in `no_*` only when you need extra explicitness; they are enforced regardless.

## Managing `.minds/team/<member>/*.md` (agent minds)

At dialog start, the runtime reads that member’s `persona.*.md` / `knowledge.*.md` / `lessons.*.md`
assets.

- For exact language-file selection, fallback rules, injection order, and other current authoring
  details, use `man({ "toolsetId": "team_mgmt", "topics": ["minds"] })`.

See `dominds/main/minds/load.ts` (`readAgentMind()`).

Authoring rule (important):

- `persona.*.md` is spliced into that member's `role=system` prompt, so it should normally be written directly to the agent itself.
- In practice, prefer second-person "you" when defining responsibilities, boundaries, working style, and delivery expectations.
- Do not write `persona.*.md` as a third-person biography or as operator-facing documentation for a human/team manager.
- `knowledge.*.md` / `lessons.*.md` also end up in the member's system prompt, specifically under `## Knowledge` / `## Lessons`. `knowledge` is better for stable facts, indexes, conventions, and decision cues; `lessons` is better for reusable heuristics such as “if X happens, do Y, avoid Z”. Both should still be written to help that member act, not to narrate the member from the outside.
- Heading levels should follow the system-prompt wrapper too: the outer template already provides `## Persona` / `## Knowledge` / `## Lessons`, so bodies should usually start at `###` or plain bullets instead of repeating `#` / `##` or restating the wrapper title.

Suggested structure:

```
.minds/
  team.yaml
  llm.yaml
  team/
    fuxi/
      persona.md
      knowledge.md
      lessons.md
    pangu/
      persona.md
      knowledge.md
      lessons.md
```

## Managing `.minds/skills/*` (skill assets)

Design-level positioning:

- `.minds/skills/*` stores reusable team skill / operating-guidance assets.
- Its job is to capture “when to use this, how to do it, and where the boundary is”, not to grant
  permissions.
- If a skill depends on scripts, privileged tools, MCP, external binaries, or reusable execution
  capability, the design should usually elevate it into a Dominds app / toolset / teammate contract
  rather than stopping at Markdown alone.
- This design doc intentionally limits itself to boundary and migration guidance. For current file
  naming, injection semantics, heading levels, and language-file rules, use
  `man({ "toolsetId": "team_mgmt", "topics": ["skills"] })`.

## Managing `.minds/env.*.md` (runtime-environment notes)

Design-level positioning:

- `.minds/env.*.md` exists to describe stable facts about the current rtws runtime environment so
  members can orient themselves quickly.
- It should not take on the role of persona definition, skill tutorial, giant operating manual, or
  repo-wide policy dump.
- Those responsibilities belong, respectively, in `persona/knowledge/lessons`, skills, priming, or
  the repo’s own policy files.
- This design doc only defines that boundary. For the current injection position, fallback behavior,
  and authoring guidance, use `man({ "toolsetId": "team_mgmt", "topics": ["env"] })`.

## Bootstrap Policy: Shadow bootstrap members

Preferred behavior for initial bootstrap:

- The shadow `fuxi` instance should get `team_mgmt` (and the manual tool), not broad `ws_mod`.
- The shadow `pangu` instance should get broad rtws toolsets (e.g. `ws_read`, `ws_mod`, `os`), but not `team_mgmt`.
- After `.minds/team.yaml` is created, the team definition becomes the source of truth.

This avoids needing to grant full rtws access to configure the team.

## Troubleshooting

- **“Missing required provider/model”**: Ensure `.minds/team.yaml` has `member_defaults.provider` and
  `member_defaults.model`.
- **Provider not found**: Ensure `.minds/team.yaml` `provider` keys exist in merged provider config
  (`dominds/main/llm/defaults.yaml` + `.minds/llm.yaml`).
- **Access denied when editing `.minds/`**: Intended for general file tools; use `team_mgmt` tools.
- **MCP tools not visible in Tools view**:
  - Confirm `.minds/mcp.yaml` exists and is valid.
  - Open **Problems** and look for MCP-related errors.
  - Confirm the teammate is granted the relevant `<serverId>` toolset in `.minds/team.yaml`.
- **MCP server keeps failing to (re)load**:
  - Check Problems details (missing env var, invalid tool name, collisions, connection errors).
  - After fixing config, use `mcp_restart` (from `mcp_admin`) for a best-effort per-server restart.
