# codex_style_tools Codex Style Tools Manual

## Overview

codex_style_tools is Dominds' **Codex style toolset** providing Codex-compatible tools:

- **Apply patch**: Apply code patches
- **Read-only shell**: Execute read-only commands safely
- **Update plan**: Update task plans

## Quick Navigation

| Topic                         | Description                                        |
| ----------------------------- | -------------------------------------------------- |
| [principles](./principles.md) | Core concepts, Codex compatibility, best practices |
| [tools](./tools.md)           | Complete tool list and interface contracts         |
| [scenarios](./scenarios.md)   | Common usage scenarios (copy-paste ready)          |
| [errors](./errors.md)         | Error codes and solutions                          |

## Status

- Status: Implemented
- Main implementation files:
  - Tool implementation: `dominds/main/tools/codex-style.ts`
  - Toolset metadata: `dominds/main/tools/builtins.ts`, `dominds/main/tools/registry.ts`

## Design Goal

The Codex style toolset is designed to be compatible with Codex provider, providing consistent tool calling experience.

## Difference from Other Toolsets

| Toolset           | Features                          |
| ----------------- | --------------------------------- |
| codex_style_tools | Codex compatible, read-only first |
| os                | Full shell support                |
| ws_mod            | Full file operations              |
