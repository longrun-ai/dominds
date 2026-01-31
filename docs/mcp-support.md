# MCP Support (`.minds/mcp.yaml`)

This document specifies how Dominds should support MCP (Model Context Protocol) servers as a
first-class tool source, **in addition to** any existing/legacy JSON-based MCP config formats.

The outer repository root is the **rtws** (runtime workspace). All paths below are relative to the
rtws root.

## Status (Current Code)

As of the current Dominds implementation in this workspace, MCP is implemented (using the official
MCP TypeScript SDK):

- `.minds/mcp.yaml` loader with mandatory hot-reload.
- MCP-derived tools/toolsets registered into the existing global tool(set) registry.
- Supported transports: `stdio` and `streamable_http` (SSE transport is not supported as a separate
  config option).
- Workspace Problems surfaced to the WebUI (Problems pill + panel) for MCP and LLM provider
  rejections.

This doc remains the canonical design/spec for the behavior and semantics.

## Relevant Existing Primitives (How Tools Work Today)

MCP support should be implemented by composing existing primitives rather than inventing a parallel
system:

- Dominds tools are function tools (`FuncTool`) only (see `dominds/main/tool.ts`).
  - NOTE: “tellask” is reserved for teammate tellask / dialog orchestration and is not a tool type.
- Tools and toolsets are globally registered via `registerTool` / `registerToolset` in
  `dominds/main/tools/registry.ts` (with built-ins registered during module initialization).
- Team members resolve toolsets into concrete tool lists at runtime via `Team.Member.listTools()` in
  `dominds/main/team.ts` using `getToolset()` / `getTool()`.
- The LLM layer only “sees” function tools (`FuncTool`) through the generators (e.g.
  `dominds/main/llm/gen/codex.ts`), and tool execution happens via `FuncTool.call()` inside the
  driver (`dominds/main/llm/driver.ts`).
- Function tool calls can be executed concurrently (the driver `Promise.all()`s them), so any MCP
  client wrapper must safely handle parallel in-flight requests.

Many real-world MCP servers are **not safe to share concurrently** across multiple dialogs/agents.
Examples include servers that keep mutable session state, maintain implicit “current page” handles,
or have global process-scoped caches.

Dominds therefore treats MCP client connections/processes as **leased resources** by default.

### Server config: `truely-stateless` (default: `false`)

Each MCP server supports an explicit boolean flag:

- `truely-stateless: false` (default): the server is assumed **not** safe for concurrent multi-dialog
  use.
- `truely-stateless: true`: the server is declared safe to share concurrently across dialogs.

Note: the YAML key is intentionally spelled `truely-stateless` (not `truly-stateless`) to match the
implemented config surface.

### Default behavior (`truely-stateless: false`)

- The first time any MCP tool from that server’s toolset is used in a given dialog, Dominds creates
  a **dedicated MCP client instance** (and thus a dedicated MCP server process/connection for that
  dialog).
- That client instance remains **leased to that dialog** for future tool calls from the same
  toolset.
- If another dialog uses the same MCP toolset concurrently, Dominds creates **another** MCP client
  instance for that requesting dialog (no cross-dialog sharing).
- On first lease, Dominds adds a **sticky owned reminder** to the dialog instructing the agent to
  release the lease when it is confident the toolset won’t be needed again soon.

Releasing:

- Agents should call `mcp_release({"serverId":"<serverId>"})` (from `mcp_admin`) to release the
  leased client instance for the current dialog.

### Shared behavior (`truely-stateless: true`)

- Dominds may share a single MCP client instance across dialogs for that server/toolset.
- No per-dialog lease reminder is required.

## Goals

- Configure MCP servers via `.minds/mcp.yaml`.
- Treat each MCP server as a Dominds **toolset** (so it can be granted via `team.yaml`).
- Support tool-name whitelist/blacklist filtering by pattern.
- Support tool-name prefix/suffix transforms to avoid collisions and improve naming UX.
- Support safe environment variable wiring, including renaming/copying from host env (so secrets
  don’t need to be committed to YAML).

## Non-goals

- Replacing Dominds built-in toolsets (`ws_read`, `ws_mod`, `os`, etc.).
- Mirroring every third-party MCP client configuration detail exactly; this is a Dominds-focused
  config surface.

## File Location

- Primary config file: `.minds/mcp.yaml`
- If the file does not exist, MCP support is disabled (no dynamic MCP toolsets are registered).

## Mapping: MCP Server → Dominds Toolset

Each configured MCP server is mapped to:

- A Dominds toolset named `<serverId>` (e.g. `playwright`).
- A set of Dominds tools registered into the global tool registry (tool names must be globally
  unique across all toolsets).

Dominds **must** ensure tool name uniqueness across:

- Built-in tools (e.g. `read_file`, `shell_cmd`)
- All MCP-derived tools across all servers

If a collision occurs, Dominds should skip the conflicting MCP tool and log a clear warning
identifying the server + tool.

## Implementation Sketch (Based on Current Registry Model)

### Where to initialize

Because the tool registry is global, MCP toolsets must be registered before `Team.Member.listTools()`
is used to build an agent’s tool list (and thus before LLM generation in
`dominds/main/llm/driver.ts`).

Two viable integration points:

1. **Server startup init (recommended)**: call an async `initMcpToolsetsFromWorkspace()` during
   server boot (before accepting requests).
2. **Lazy init on first use**: call `ensureMcpToolsetsLoaded()` inside `loadAgentMinds()` (or the
   driver loop) with simple caching/mtime checks to support “edit config and retry”.

### What needs to be added

At minimum:

- A YAML loader for `.minds/mcp.yaml` (similar to `Team.load()` and `LlmConfig.load()` patterns).
- A registry “owner” layer that tracks which tool names belong to which MCP server, so it can:
  - Unregister stale tools (`unregisterTool`) and toolsets (`unregisterToolset`) on reload.
  - Avoid leaving old tools behind after config edits.
- An MCP client implementation per server (official SDK), which:
  - Connects via `stdio` (spawn `command` + `args` + `env`) or `streamable_http` (`url` + `headers`).
  - Performs MCP handshake and fetches the tool list (including per-tool JSON schema).
  - Exposes each MCP tool as a Dominds `FuncTool` whose `call()` performs the MCP `callTool` request.

### Why MCP tools should be `FuncTool`s

Dominds already supports structured “function calling” across providers, with argument validation
(`validateArgs()`), tool schema conversion, persistence, and UI lifecycle events. Implementing MCP
tools as `FuncTool`s means:

- MCP tools automatically show up to the model as function tools.
- Results are recorded as `func_result_msg`, matching existing persistence and UI logic.

Tellask is a separate **teammate-call grammar** (not a tool type) and is not a good fit for MCP’s
structured schema-driven tools.

### Stdio transport caveat (MCP server side)

For stdio transport, the MCP server process must treat its stdout as the protocol channel.
Operational logs must go to stderr (or a file), otherwise the protocol stream will be corrupted.

## Tool Filtering (Whitelist/Blacklist)

Filtering is intended to:

- Reduce the exposed attack surface (only load tools you mean to grant).
- Avoid clutter in the UI and prompt.

The key requirement is: tools that do not pass the whitelist/blacklist rules are **never registered**
into Dominds’ tool system, and therefore can never be presented to agents for use.

### Pattern Rules

- Patterns use simple wildcard matching with `*` (match any substring).
- Matching is evaluated against the **original MCP tool name** (before rename transforms). This
  keeps filters stable even if naming transforms change.

### Semantics

`whitelist` supports two modes depending on whether `blacklist` is configured:

- **Whitelist-only mode** (`blacklist` omitted or empty):
  - If `whitelist` is provided and non-empty, **only** tools matching at least one `whitelist`
    pattern are registered.
  - If `whitelist` is omitted or empty, all tools are registered.
- **Whitelist + blacklist mode** (`blacklist` provided and non-empty):
  - Tools matching any `blacklist` pattern are never registered, **unless** they also match the
    `whitelist` (whitelist overrides blacklist for cherry-picking).
  - Tools that match neither `whitelist` nor `blacklist` are registered (i.e. whitelist does not
    restrict the universe when a blacklist is present).

## Tool Name Transforms

Transforms are applied to the MCP tool name to produce a Dominds tool name.

### Why transforms exist

- MCP servers frequently expose short/common tool names (`open`, `search`, `list`, …) that can
  collide across servers and with built-ins.
- Dominds tool names are global, so names must be made unique and recognizable.

### Supported transforms

Transforms are applied in order:

1. `prefix`: add or replace a prefix.
2. `suffix`: add a suffix.

Examples:

```yaml
transform:
  - prefix: 'playwright_'
  - prefix:
      remove: 'stock_prefix_'
      add: 'my_prefix_'
  - suffix: '_playwright'
```

Notes:

- `prefix: "x_"` always adds `x_` in front of the current name.
- `prefix: { remove, add }` removes the specified leading substring if present, then adds `add`.
- `suffix: "_x"` always appends `"_x"` to the current name.

## Tool Name Validity (Reject Invalid Names)

Dominds must **reject** MCP tools whose names are invalid for function-tool naming rules shared by
supported LLM providers. Rejected tools are never registered.

Exact rule (intersection of OpenAI + Anthropic tool name constraints):

- Must match: `^[a-zA-Z0-9_-]{1,64}$`
  - Allowed characters: ASCII letters, digits, underscore, hyphen
  - Length: 1–64 characters

Notes:

- This applies to both the original MCP tool name and the post-transform Dominds tool name.
- Dominds must not auto-normalize invalid names (no implicit renaming). Only explicit configured
  transforms may change the name.
- This rule is chosen because both OpenAI and Anthropic enforce essentially the same constraints for
  tool/function names; using the intersection avoids provider-specific surprises.

## Tool Schema Support (MCP Input JSON Schema)

Dominds should treat MCP tools as `FuncTool`s. That requires `FuncTool.parameters` to support the
full JSON Schema feature set used by standard MCP servers.

This implies extending `dominds/main/tool.ts` schema types beyond the current minimal subset to
support (at minimum) the JSON Schema constructs commonly emitted by MCP servers, including:

- `type`: including `'integer'` and `'null'` (in addition to string/number/boolean/object/array), and
  union forms (e.g. `type: ['string', 'null']`)
- Composition: `oneOf`, `anyOf`, `allOf`, `not`
- Literals: `enum`, `const`, `default`
- Objects: `properties`, `required`, `additionalProperties` (boolean or schema), `patternProperties`,
  `propertyNames`
- Arrays: `items` (schema or tuple), `prefixItems`, `minItems`, `maxItems`, `uniqueItems`
- Strings: `minLength`, `maxLength`, `pattern`, `format`
- Numbers/integers: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`
- Metadata: `title`, `description`

For now, Dominds should **pass the schema through** to the LLM provider as-is, and only tighten this
if/when a provider rejects specific schemas in practice. Any provider-side schema rejection must be
surfaced via Problems + logs.

## Provider-Safe Tool Projection (LLM Wrapper API)

Even if Dominds can represent and validate an MCP tool schema internally, each LLM provider may have
its own tool schema constraints. Dominds needs a provider-specific “projection” step so we only send
provider-compatible tool definitions to the model.

Design:

- Keep a canonical, full-fidelity `FuncTool` in the tool registry.
- At generation time, project tools for the active provider:
  - `projectFuncToolsForProvider(apiType, funcTools) -> { tools, problems }`
  - The generator uses only `tools` in the provider request payload.
  - (Future) tools excluded by projection produce Problems entries so the user can see why tools are
    missing for that provider.

The projection layer is an LLM wrapper API that lives between:

- `Team.Member.listTools()` (tool registry output)
- LLM generators (e.g. `dominds/main/llm/gen/codex.ts`, `dominds/main/llm/gen/anthropic.ts`, `dominds/main/llm/gen/openai.ts`)

Rules:

- For now, projection is a **no-op passthrough**: it does not attempt to “down-convert” schemas or
  pre-emptively exclude tools. Providers are allowed to reject requests if they dislike a tool
  schema.
- When a provider rejects a tool schema, Dominds must surface a Problem describing the provider,
  tool name, and error text. We can later evolve projection into true provider-safe filtering and/or
  schema downgrading.
- This projection must be deterministic and side-effect-free (no background mutations).

## Retry & Stop Policy (When Providers Reject Requests)

Dominds must not blindly retry provider rejections that are caused by invalid requests (e.g. tool
schema/tool name/tool payload incompatibility). These should stop the dialog and require explicit
human intervention.

Policy:

- **Provider rejection (non-retriable)**: if the LLM provider rejects the request (e.g. HTTP 400, or a
  structured provider error indicating an invalid request/tool schema), Dominds must:
  - Transition the dialog into a **stopped/interrupted** run state (no automatic retries).
  - Surface a Problem with provider name, dialog id, and the error text (plus implicated tool name if
    identifiable).
  - Allow the user to resume after they change config/code (e.g. adjust MCP config, rename tools,
    reduce tool set, etc.).
- **Network/retriable errors**: Dominds may auto-retry only for clearly retriable classes such as
  transient network failures/timeouts and provider transient errors (e.g. rate limits or 5xx), using
  bounded backoff and a max retry count.

This keeps the system responsive and avoids infinite “retry loops” caused by invalid tool schemas.

## Environment Variables (`env`)

MCP servers often need credentials or runtime knobs. Dominds should support two ways to populate a
server process environment:

1. **Literal value** (use sparingly; avoid secrets in YAML)
2. **Copy from host process env** (preferred for secrets and local-only values)

### Env value forms

```yaml
env:
  # Literal value
  SOME_ENV_VAR_NAME: 'some_env_var_value'

  # Copy/rename from host env
  NEW_ENV_VAR_NAME:
    env: EXISTING_ENV_VAR_NAME
```

Semantics:

- Child process env starts from `process.env` (inherit), then applies the `env` mappings on top.
- For `{ env: EXISTING_ENV_VAR_NAME }`, the value is taken from the Dominds process environment at
  runtime; if missing, server startup should fail with a clear message.

## HTTP Headers (`streamable_http`)

`streamable_http` servers can optionally define HTTP request headers. Values use the same literal
or `{ env: ... }` mapping form as `env`:

```yaml
headers:
  Authorization:
    env: MCP_AUTH_TOKEN
  X-Client-Name: 'dominds'
```

## Proposed `.minds/mcp.yaml` Schema (v1)

This is a Dominds-oriented schema. It is intentionally small and should be easy to validate.

```yaml
version: 1
servers:
  <serverId>:
    # Concurrency model (IMPORTANT)
    # - Default false: per-dialog client leasing (safer for stateful servers)
    # - True: shared client across dialogs (only for servers that are truly stateless)
    truely-stateless: false

    # Transport config (minimum viable set)
    #
    # 1) stdio
    transport: stdio
    command: npx
    args: ['-y', '@playwright/mcp@latest']

    # Optional environment wiring
    env: {}

    # 2) streamable_http
    # transport: streamable_http
    # url: http://127.0.0.1:3000/mcp
    # headers: {} # optional (supports literal or { env: NAME } values)
    # sessionId: '' # optional

    # Tool exposure controls
    tools:
      whitelist: [] # optional
      blacklist: [] # optional

    # Tool name transforms (optional)
    transform: []
```

### Example: Playwright MCP server

```yaml
version: 1
servers:
  playwright:
    truely-stateless: false
    transport: stdio
    command: npx
    args: ['-y', '@playwright/mcp@latest']
    tools:
      whitelist: ['browser_*', 'page_*']
      blacklist: ['*_unsafe']
    transform:
      - prefix: 'playwright_'
```

With the example above, the server registers toolset `playwright`, and exposes tools like:

- `playwright_browser_click`
- `playwright_browser_snapshot`

## Interaction with `team.yaml`

Once MCP toolsets are registered, they can be granted like any other toolset:

```yaml
members:
  alice:
    toolsets:
      - ws_read
      - playwright
```

## Loading / Reloading

- Load `.minds/mcp.yaml` at server startup (recommended).
- Hot-reload is **mandatory**: Dominds must detect `.minds/mcp.yaml` changes and apply them at
  runtime (no server restart required), including:
  - Unregister removed toolsets/tools.
  - Re-register updated toolsets/tools.
  - Avoid leaving stale tools in the global registry.

## Dynamic Reload Design (Runtime Adaptation)

This section designs a safe, practical hot-reload mechanism that fits Dominds’ **global tool(set)
registry** and the fact that agents re-resolve tools each generation.

### Detection: How to notice changes

Use one of:

1. **File watch**: watch `.minds/mcp.yaml` via `fs.watch()` and trigger reload on `change` / `rename`.
2. **Polling fallback**: record `mtimeMs` from `fs.stat()` and compare periodically (or on each generation
   in `loadAgentMinds()`).

Recommendation: implement both (watch for fast feedback; poll for reliability).

Always debounce (e.g. 100–500ms) because editors may write via temp file + rename or multiple writes.

Treat deletion of `.minds/mcp.yaml` as equivalent to an empty config (clear all servers): unregister
all MCP toolsets/tools and stop all MCP server processes.

### Atomicity: Reload as “compute then swap”

Reload should be implemented as:

1. Parse + validate YAML into a typed config object.
2. Build a **desired runtime model** from that config.
3. Diff desired vs current runtime model.
4. Apply mutations to the registries in a short critical section.

The critical insight is: **tool objects are captured into `agentTools` per generation**. Registry changes
only affect future generations (or other dialogs) when they call `Team.Member.listTools()` again.

### Registry ownership tracking (required)

Because `toolsRegistry` is global, MCP hot-reload must track exactly which names it created so it
can remove them later without touching built-ins.

Maintain an in-memory structure like:

- `mcpRuntimeByServerId: Map<string, { toolsetName: string; toolNames: string[]; client: ...; hash:
string; ... }>`
- `toolOwnerByName: Map<string, { kind: 'mcp'; serverId: string }>`

Rules:

- Only unregister tools/toolsets that are owned by MCP (by consulting `toolOwnerByName`).
- Never unregister built-in tools/toolsets.

### Diff rules (added/removed/changed)

Compute a stable hash per server definition (including transport-specific fields like
command/args/env or url/headers/sessionId, plus tool filters/transforms).

- **Added server**: spawn client, list tools, register its tools + toolset.
- **Removed server**: unregister its toolset, unregister its tools, stop its client.
- **Changed server**: treat as remove + add (or do an in-place update), but keep the operation
  atomic from the registry’s point of view.

Reloads are committed **per server independently**:

- If server A fails to reload, keep A’s last-known-good registration running.
- If server B reloads successfully in the same cycle, commit B’s update even if A failed.

### Ordering (avoid collisions and partial states)

When applying a reload:

1. Prepare all new `Tool` objects and toolsets in memory first.
2. In the critical section:
   - Unregister toolsets for removed/changed servers first.
   - Unregister tools for removed/changed servers next.
   - Register tools for added/changed servers.
   - Register toolsets for added/changed servers last.

This reduces collision risk and avoids a toolset briefly pointing at missing tools.

### Concurrency & in-flight calls

Dominds may execute function tools concurrently. For MCP tools, that implies:

- Each MCP server client must support multiple in-flight `callTool` requests safely.
- Hot-reload must not corrupt in-flight calls.

Practical approach:

- When tools are removed/changed, stop serving **new** calls by unregistering the tool objects.
- Keep the underlying MCP client alive until all in-flight calls complete, then terminate it.
  - Track `inFlightCount` per server client.
  - On “stop requested”, set `closing = true` and only terminate when `inFlightCount === 0`.
  - Optionally enforce a timeout to force-kill hung servers.

### Failure behavior

If reload fails (invalid YAML, missing env var, server spawn fails, tool schema invalid, etc.):

- Log an actionable error with the failing server ID and reason.
- Keep the **last known good** MCP runtime registration in place.
  - “Good” means: a server was successfully started, initialized, and its toolset/tools were
    registered.
  - An already-initialized MCP server instance must keep functioning (and remain registered) until a
    new “good” instance replaces it.
- Do not partially apply a reload for a given server (no half-updated registry state for that
  server).

### Interaction with `team.yaml` during reload

If a member references a toolset that disappears (e.g. `playwright` removed), then
`Team.Member.listTools()` will warn “Toolset not found” and the agent simply won’t have those tools
in that generation. This is acceptable; a separate UX improvement can surface the missing toolset in UI.

### Optional: Versioning

Maintain a monotonically increasing `mcpRegistryVersion` updated after each successful reload.
This can be useful for:

- Debug logs (“agent generation used MCP version N”)
- UI status display (“MCP config loaded at …”)

## Validation & Error Handling

Dominds must **always start**, even if MCP config or servers are misconfigured. MCP issues should be
reported via Problems + logs, and MCP should degrade gracefully per-server.

Dominds should fail early (with actionable messages) at two scopes:

**Workspace-level (reject this reload attempt; keep last-known-good set as-is):**

- Invalid YAML, missing `version`, or unsupported `version`.
- Duplicate server IDs.

**Per-server (reject only that server’s update; keep that server’s last-known-good instance/tools):**

- Unsupported `transport` values (for example `sse` is not supported as a config option).
- Tool name collisions after transforms.
- Missing host environment variables referenced by `{ env: ... }`.

Warnings (non-fatal) should include:

- Tools never registered due to `blacklist` patterns.
- Tools excluded by whitelist-only mode (only when `blacklist` is omitted or empty).
- Tools dropped due to collisions.
