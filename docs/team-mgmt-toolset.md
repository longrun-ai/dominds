# Team Management Toolset (`team-mgmt`)

This document specifies a dedicated **team management toolset** whose only job is managing the
workspace’s “mindset” configuration files under `.minds/` (team roster, LLM providers, and agent
minds files), without granting broad runtime-workspace access.

The outer repository root is the **rtws** (runtime workspace). All paths below are relative to the
rtws root.

## Motivation

We want a safe way for a “team manager” agent (typically the shadow teammate `fuxi`) to:

- Create/update `.minds/team.yaml` (team roster + permissions + toolsets).
- Create/update `.minds/llm.yaml` (LLM provider definitions overriding defaults).
- Create/update `.minds/mcp.yaml` (MCP server definitions that register dynamic toolsets).
- Create/update `.minds/team/<member>/{persona,knowledge,lessons}.md` (agent minds).

At the same time, we do **not** want to hand that agent full workspace read/write (e.g. the
equivalent of the `ws_mod` toolset + unrestricted `read_dirs`/`write_dirs`), because:

- Editing `.minds/team.yaml` is inherently a **privilege escalation surface** (it controls tool
  availability and directory permissions).
- Editing `.minds/llm.yaml` can change network destinations and model/provider behaviors.
- A “bootstrap” team manager should be able to configure the team without being able to change the
  product code, `.dialogs/`, etc.

## Migration Plan (Replacing legacy builtin team-manager knowledge)

This document is a **design spec** for the new `team-mgmt` toolset. It is not something we should
ever tell an agent to “look up” at runtime.

Instead, the runtime “single source of truth” for team management guidance should be
the function tool `team_mgmt_manual`.

Historically, some of the guidance lived in a legacy builtin “team manager” mind set inside the
`dominds/` source tree. That legacy builtin is being removed. The runtime “single source of truth”
should be the `team_mgmt_manual` tool output.

Planned change:

- Add a new function tool `team_mgmt_manual` whose responses cover the team-management topics (file
  formats, workflows, safety).
- Remove legacy builtin guidance to avoid duplication. If any stub remains, it must point to
  `team_mgmt_manual` (and not to this design document).

Rationale:

- The manual is versioned with the tool behavior, so it stays accurate.
- The framework source tree should not be the “primary” place the team config format is explained.
  Each rtws may have different policies and defaults.

## Current Problem Statement

In typical deployments we deny direct `.minds/` access via the general-purpose workspace tools:

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

## Proposed `team-mgmt` Toolset

The `team-mgmt` toolset mirrors a minimal subset of `fs`/`txt`, but **hard-scopes** all operations to
`.minds/` and rejects anything outside.

### Naming Conventions (Human / UI)

- **Tools** use `snake_case` (underscore-separated) for tool IDs (e.g. `team_mgmt_manual`). Avoid
  `kebab-case` aliases for tool IDs; if UX needs a friendlier label, treat that as presentation-only.
- **Teammates** use either `kebab-case` (hyphen-separated) or an “internet name” (dot-separated).
- This is a convention for docs/UI/readability only; do not enforce it via validation or other
  technical mechanisms.

### Tools

Recommended tools (names are suggestions; use `snake_case` to match existing tools):

| Tool name                             | Based on | Purpose                                                                           | Default allowlist scope |
| ------------------------------------- | -------- | --------------------------------------------------------------------------------- | ----------------------- |
| `team_mgmt_list_dir`                  | `fs`     | List directories/files under `.minds/`                                            | `.minds/**`             |
| `team_mgmt_read_file`                 | `txt`    | Read a text file under `.minds/`                                                  | `.minds/**`             |
| `team_mgmt_create_new_file`           | `txt`    | Create a new file under `.minds/` (empty content allowed; refuses overwrite)      | `.minds/**`             |
| `team_mgmt_overwrite_entire_file`     | `txt`    | Overwrite an existing file under `.minds/` (guarded exception path)               | `.minds/**`             |
| `team_mgmt_preview_file_modification` | `txt`    | Preview a single-file edit by line range under `.minds/` (returns a diff hunk id) | `.minds/**`             |
| `team_mgmt_preview_file_append`       | `txt`    | Preview an append-to-EOF edit under `.minds/` (returns a diff hunk id)            | `.minds/**`             |
| `team_mgmt_preview_insert_after`      | `txt`    | Preview inserting after an anchor under `.minds/` (returns a diff hunk id)        | `.minds/**`             |
| `team_mgmt_preview_insert_before`     | `txt`    | Preview inserting before an anchor under `.minds/` (returns a diff hunk id)       | `.minds/**`             |
| `team_mgmt_preview_block_replace`     | `txt`    | Preview a block replace between anchors under `.minds/` (returns a diff hunk id)  | `.minds/**`             |
| `team_mgmt_apply_file_modification`   | `txt`    | Apply a planned modification by hunk id under `.minds/`                           | `.minds/**`             |
| `team_mgmt_mk_dir`                    | `fs`     | Create directories under `.minds/`                                                | `.minds/**`             |
| `team_mgmt_move_file`                 | `fs`     | Move/rename files under `.minds/`                                                 | `.minds/**`             |
| `team_mgmt_move_dir`                  | `fs`     | Move/rename directories under `.minds/`                                           | `.minds/**`             |
| `team_mgmt_rm_file`                   | `fs`     | Delete files under `.minds/`                                                      | `.minds/**`             |
| `team_mgmt_rm_dir`                    | `fs`     | Delete directories under `.minds/`                                                | `.minds/**`             |
| `team_mgmt_validate_team_cfg`         | new      | Validate `.minds/team.yaml` and publish issues to the Problems panel              | `.minds/**`             |
| `team_mgmt_manual`                    | new      | Built-in “how-to” manual (see below)                                              | N/A                     |

Notes:

- Include the full `.minds/` lifecycle (create, update, rename/move, delete). The team manager must
  be able to correct mistakes and recover from accidental corruptions (including ones introduced by
  other tools).
- After any change to `.minds/team.yaml`, the team manager should run `team_mgmt_validate_team_cfg({})`
  to ensure all errors are detected and surfaced (and to avoid silently omitting broken member configs).
- Path handling should be strict:
  - Reject absolute paths.
  - Reject paths containing `..`.
  - Reject any path that resolves outside `.minds/` after normalization.
- Prefer an explicit allowlist over “anything in the rtws”.
  - For `team-mgmt`, that explicit allowlist is `.minds/**` (including `.minds/memory/**`) so the
    team manager can repair accidental corruptions made by other tools (even though `.minds/memory/**`
    already has dedicated `memory` / `team_memory` tools for normal use).
- Require explicit `.minds/...` paths and validate them; do not support “implicitly scoped” paths
  like `team.yaml`.

### Why a dedicated toolset (instead of only `read_dirs` / `write_dirs`)?

`read_dirs` / `write_dirs` are still valuable, but they are configured in `.minds/team.yaml`, which
may not exist during bootstrap. A dedicated `team-mgmt` toolset:

- Lets the team manager create `.minds/team.yaml` safely from “zero state”.
- Keeps the scope bounded even if the member’s directory allow/deny lists are empty.
- Makes it easy to grant _just_ team management capabilities to an ad-hoc agent without full rtws
  access.

## `team_mgmt_manual`

We need a single in-chat manual tool so the team manager can reliably self-serve guidance without
reading source code.

### Command shape

- `team_mgmt_manual({ "topics": [] })` → show a short index (topics).
- `team_mgmt_manual({ "topics": ["topics"] })` → list topics.
- `team_mgmt_manual({ "topics": ["llm"] })` → how to manage `.minds/llm.yaml` (+ templates).
- `team_mgmt_manual({ "topics": ["llm", "builtin-defaults"] })` → show builtin providers/models (from defaults).
- `team_mgmt_manual({ "topics": ["mcp"] })` → how to manage `.minds/mcp.yaml` (+ templates).
- `team_mgmt_manual({ "topics": ["mcp"] })` → how to manage `.minds/mcp.yaml` (transports, env/headers, tools whitelist/blacklist, naming transforms, hot reload, leasing).
- `team_mgmt_manual({ "topics": ["mcp", "troubleshooting"] })` → common MCP failure modes and how to recover.
- `team_mgmt_manual({ "topics": ["team"] })` → how to manage `.minds/team.yaml` (+ templates).
- `team_mgmt_manual({ "topics": ["team", "member-properties"] })` → list supported member fields and meanings.
- `team_mgmt_manual({ "topics": ["minds"] })` → how to manage `.minds/team/<id>/*.md` (persona/knowledge/lessons).
- `team_mgmt_manual({ "topics": ["permissions"] })` → how `read_dirs`/`write_dirs` and deny-lists work.
- `team_mgmt_manual({ "topics": ["troubleshooting"] })` → common failure modes and how to recover.

The manual should accept **multiple** `topics` entries (a simple topic “path”); the tool should
select the most specific match and fall back to the nearest parent when needed.

If UX wants a friendlier label than `team_mgmt_manual`, treat that as presentation-only; the
canonical tool ID remains `team_mgmt_manual`.

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

## Dynamic Loading from the Dominds Installation (Runtime Resources)

Where appropriate, the manual should **dynamically load** its “reference” content from the running
`dominds` installation (i.e. the files and registries shipped with the installed backend), rather
than duplicating that content in:

- `.minds/*` (workspace state), or
- docs, or
- hardcoded strings inside tool implementations.

This keeps the manual accurate when the framework changes, and avoids documentation drift.

Recommended sources by topic:

- `team_mgmt_manual({ "topics": ["llm", "builtin-defaults"] })`
  - Load from the same installation resource the runtime uses for defaults:
    `dominds/main/llm/defaults.yaml` (via `__dirname` resolution in the backend build output).
  - Prefer reusing `LlmConfig.load()` and formatting its merged view, or adding a helper that returns
    both “defaults-only” and “merged” provider maps.
- `team_mgmt_manual({ "topics": ["toolsets"] })` (if added)
  - Load from the in-memory registries at runtime (`listToolsets()` / `listTools()` in
    `dominds/main/tools/registry.ts`), rather than maintaining a separate list.

Keep these as **static/manual text** (not dynamically loaded):

- High-level explanations, best practices, and “why” sections.
- Schema summaries (e.g. the member field table). These can be authored as a stable contract and
  validated in code reviews; runtime introspection of TypeScript types is not reliable post-build.

## Managing `.minds/llm.yaml`

### What it does

`dominds` loads built-in provider definitions from `dominds/main/llm/defaults.yaml` and then merges
in workspace overrides from `.minds/llm.yaml` (workspace keys override defaults). See:

- `dominds/main/llm/client.ts` (`LlmConfig.load()`)
- `dominds/main/llm/defaults.yaml` (builtin provider catalog)

### File format (template)

`.minds/llm.yaml` must contain a `providers` object. Each provider is keyed by a short identifier
used in `.minds/team.yaml` member configurations.

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

- MCP behavior and semantics: `dominds/docs/mcp-support.md`
- Tools view UX and Problems panel: `dominds/docs/team-tools-view.md`

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

### File format (template)

```yaml
version: 1
servers:
  <serverId>:
    # Transport: stdio
    transport: stdio
    command: npx
    args: ['-y', '@playwright/mcp@latest']
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
- Directory access control for workspace file tools (`read_dirs`, `write_dirs`, `no_*`).

The file is loaded by `Team.load()` in `dominds/main/team.ts`. If the file is absent, the runtime
bootstraps a default team (today it creates shadow members `fuxi` + `pangu`).

### File format (template)

```yaml
member_defaults:
  provider: codex
  model: gpt-5.2
  toolsets:
    - ws_read
    - memory
  # Default posture: deny `.minds/` edits for normal members.
  # (Team management should be done via `team-mgmt` tools, not general file tools.)
  no_read_dirs:
    - .minds/team.yaml
    - .minds/llm.yaml
    - .minds/mcp.yaml
    - .minds/team/**
  no_write_dirs:
    - .minds/**

default_responder: fuxi

members:
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
- Keep `.minds/team.yaml` ownership tight; only the team manager should be able to edit it.

## Managing `.minds/team/<member>/*.md` (agent minds)

The runtime reads these on every dialog start:

- `.minds/team/<id>/persona.md`
- `.minds/team/<id>/knowledge.md`
- `.minds/team/<id>/lessons.md`

See `dominds/main/minds/load.ts` (`readAgentMind()`).

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

## Bootstrap Policy: Shadow bootstrap members

Preferred behavior for initial bootstrap:

- The shadow `fuxi` instance should get `team-mgmt` (and the manual tool), not broad `ws_mod`.
- The shadow `pangu` instance should get broad workspace toolsets (e.g. `ws_read`, `ws_mod`, `os`), but not `team-mgmt`.
- After `.minds/team.yaml` is created, the team definition becomes the source of truth.

This avoids needing to grant full rtws access to configure the team.

## Troubleshooting

- **“Missing required provider/model”**: Ensure `.minds/team.yaml` has `member_defaults.provider` and
  `member_defaults.model`.
- **Provider not found**: Ensure `.minds/team.yaml` `provider` keys exist in merged provider config
  (`dominds/main/llm/defaults.yaml` + `.minds/llm.yaml`).
- **Access denied when editing `.minds/`**: Intended for general file tools; use `team-mgmt` tools.
- **MCP tools not visible in Tools view**:
  - Confirm `.minds/mcp.yaml` exists and is valid.
  - Open **Problems** and look for MCP-related errors.
  - Confirm the teammate is granted the relevant `<serverId>` toolset in `.minds/team.yaml`.
- **MCP server keeps failing to (re)load**:
  - Check Problems details (missing env var, invalid tool name, collisions, connection errors).
  - After fixing config, use `mcp_restart` (from `mcp_admin`) for a best-effort per-server restart.
