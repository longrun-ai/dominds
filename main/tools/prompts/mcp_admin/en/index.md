# mcp_admin MCP Administration Tools Manual

## Overview

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
