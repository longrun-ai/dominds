# os Shell and Process Tools Manual

## Overview

os is Dominds' **shell and process toolset** for executing system commands and managing processes:

- **Shell execution**: Execute system commands
- **Process management**: Start, stop, view daemon processes
- **Environment variables**: Read, set, delete environment variables

## Quick Navigation

| Topic                         | Description                                        |
| ----------------------------- | -------------------------------------------------- |
| [principles](./principles.md) | Core concepts, security principles, best practices |
| [tools](./tools.md)           | Complete tool list and interface contracts         |
| [scenarios](./scenarios.md)   | Common usage scenarios (copy-paste ready)          |
| [errors](./errors.md)         | Error codes and solutions                          |

## Status

- Status: Implemented
- Main implementation files:
  - Tool implementation: `dominds/main/tools/os.ts`
  - Toolset metadata: `dominds/main/tools/builtins.ts`, `dominds/main/tools/registry.ts`

## Security Notes

⚠️ Shell command execution requires caution:

- Avoid destructive commands (e.g., `rm -rf`)
- Use absolute paths to avoid path injection
- Verify command output before executing follow-up operations
