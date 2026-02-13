# codex_style_tools Codex Style Tools Manual

## Template (Index)
### One-line Positioning
- <What this toolset is for, in one sentence>
### Tool List
- <Enumerate core tools or point to Tools/Schema section>
### 30-Second Quickstart
1) <call ...>
2) <observe ...>
3) <next step ...>
### Navigation
- principles / tools / scenarios / errors
### Boundaries vs Other Toolsets
- <When to use this vs a sibling toolset>

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
