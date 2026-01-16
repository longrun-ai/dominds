# Team Tools View (WebUI)

This document specifies the WebUI experience for inspecting what **tools** and **toolsets** are
available to team members, including dynamic MCP-derived tools and any tool-related Problems
reported by the backend.

## Sidebar: Tools Activity

The Tools view is an **activity** in the left sidebar.

- The activity bar contains a Tools button.
- Selecting Tools shows the Tools activity view (and hides other activity views).

## Tools Panel (Tools Registry Snapshot)

The Tools activity view renders a Tools Registry snapshot so operators can verify which toolsets and
tools are currently registered (including MCP-derived toolsets).

### UX

- The Tools view has a **Refresh** control that fetches a fresh snapshot from the backend.
- While fetching, the view should clear any previous snapshot (so the user doesn’t mistake stale
  data for current).

### Contents

- A server-provided **timestamp** for the currently displayed snapshot.
- Two top-level tool group sections:
  - **Texting Tools** (collapsible; expanded by default)
  - **Function Tools** (collapsible; expanded by default)
- Within each group, toolsets are displayed as grouped sections titled `toolsetName (N)` where `N`
  is the number of tools in that toolset **for that group**.
- Toolsets are collapsed by default; a triangle indicator reflects collapsed/expanded state.
- Toolsets and tools are shown in **registration order** (as provided by the backend snapshot).
- Tools within a toolset show:
  - Kind marker (`ƒ` for function tools, `@` for texters)
  - Tool name
  - Optional description

Order note:

- MCP toolset ordering should reflect `.minds/mcp.yaml` server order when possible (and remain stable
  across reloads when the config order doesn’t change).

## Problems Panel/Button

Some tool-related issues should be visible in the WebUI (not only in backend logs), especially when
they prevent tools from being available to agents (e.g. MCP config errors, tool name collisions, or
LLM provider request rejections caused by tool schemas).

### UX

- Add a header “pill” button named **Problems** with:
  - A count badge (number of active problems).
  - A severity color (error > warning > info).
- Clicking toggles a right-side panel (or modal) listing current problems.
- Panel supports:
  - Filter by severity/source (optional).
  - Copy details (serverId, tool name, reason).
  - Clear/acknowledge (optional; if implemented, it only clears UI state, not the underlying cause).

### Data model (Active problems only)

Problems are a workspace-level stream (not per-dialog). They represent **current active** issues
only; when the underlying condition disappears (e.g. config fixed, server removed), the problem is
automatically removed from the active set.

Each problem should have:

- `id` (stable/dedup-able key)
- `severity` (`info` | `warning` | `error`)
- `timestamp`
- `source` (e.g. `mcp`)
- `message` (human readable)
- `detail` (structured: `serverId`, `toolName`, etc.)

### Transport

Use WebSocket to keep the UI current:

- Server sends a snapshot on connect: `type: 'problems_snapshot'` with `version` + full list.
- Server broadcasts new snapshots whenever the set changes.
- Client may request an on-demand refresh: `type: 'get_problems'`.

Problems should be kept in memory on the server as the current active set.

## Stable DOM Hooks (E2E Contract)

These identifiers are treated as a stability contract for browser automation / E2E helpers.

### Tools activity

- Sidebar activity button: `.activity-button[data-activity="tools"]`
- Activity view container: `.activity-view[data-activity-view="tools"]`
- Refresh button: `#tools-registry-refresh`
- Snapshot timestamp: `#tools-registry-timestamp`
- Toolsets list container: `#tools-registry-list`
- Top-level group section: `details.tools-section` with `summary.tools-section-title`
- Toolset grouping: `details.toolset` with `summary.toolset-title`
- Tool row: `.tool-item` with `.tool-kind`, `.tool-name`, and optional `.tool-desc`

### Problems UI

- Header pill toggle: `#toolbar-problems-toggle` (severity via `data-severity`, count in inner
  `span`)
- Panel container: `#problems-panel` (hidden via `.hidden`)
- List container: `#problems-list`
- Refresh button: `#problems-refresh`
- Close button: `#problems-close`
