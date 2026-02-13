# mcp_admin MCP Administration Tools Manual

## Template (Index)

### One-line Positioning

- <What this toolset is for, in one sentence>

### Tool List

- <Enumerate core tools or point to Tools/Schema section>

### 30-Second Quickstart

1. <call ...>
2. <observe ...>
3. <next step ...>

### Navigation

- principles / tools / scenarios / errors

### Boundaries vs Other Toolsets

- <When to use this vs a sibling toolset>

mcp_admin is Dominds' **MCP administration toolset** for managing MCP (Model Context Protocol) connections and resources:

- **MCP restart**: Restart MCP service
- **MCP release**: Release MCP lease
- **Environment variables**: Read environment variables

## Quick Navigation

| Topic                         | Description                                          |
| ----------------------------- | ---------------------------------------------------- |
| [principles](./principles.md) | Core concepts, connection management, best practices |
| [tools](./tools.md)           | Complete tool list and interface contracts           |
| [scenarios](./scenarios.md)   | Common usage scenarios (copy-paste ready)            |
| [errors](./errors.md)         | Error codes and solutions                            |

## Status

- Status: Implemented
- Main implementation files:
  - Tool implementation: `dominds/main/tools/mcp-admin.ts`
  - Toolset metadata: `dominds/main/tools/builtins.ts`, `dominds/main/tools/registry.ts`

## Core Concepts

### MCP (Model Context Protocol)

MCP is a protocol for connecting to external services and tools, allowing agents to invoke external tools and services.

### MCP Lease

MCP connections use a lease mechanism to manage resources, ensuring proper allocation and release.
