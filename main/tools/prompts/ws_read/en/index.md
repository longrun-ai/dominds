# ws_read Runtime Workspace Read-Only Tools Manual

## Overview

ws_read is Dominds' **runtime workspace read-only toolset** for reading and searching files and content in the runtime workspace (rtws):

- **Directory listing**: List directory contents
- **File reading**: Read file contents
- **Content searching**: Use ripgrep to search files and content

## Quick Navigation

| Topic                         | Description                                         |
| ----------------------------- | --------------------------------------------------- |
| [principles](./principles.md) | Core concepts, read-only principles, best practices |
| [tools](./tools.md)           | Complete tool list and interface contracts          |
| [scenarios](./scenarios.md)   | Common usage scenarios (copy-paste ready)           |
| [errors](./errors.md)         | Error codes and solutions                           |

## Status

- Status: Implemented
- Main implementation files:
  - Tool implementation: `dominds/main/tools/fs.ts`, `dominds/main/tools/ripgrep.ts`
  - Toolset metadata: `dominds/main/tools/builtins.ts`, `dominds/main/tools/registry.ts`

## Difference from ws_mod

ws_read is a read-only subset of ws_mod, providing only read functionality without write functionality.

| Feature | ws_read | ws_mod |
| ------- | ------- | ------ |
| Read    | ✓       | ✓      |
| Write   | ✗       | ✓      |
| Delete  | ✗       | ✓      |
| Move    | ✗       | ✓      |
