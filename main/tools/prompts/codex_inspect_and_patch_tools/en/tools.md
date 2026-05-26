# codex_inspect_and_patch_tools Tool Reference

## Tool List

### 1. `readonly_shell`

Purpose: inspect the workspace with a constrained read-only shell.

Typical uses:

- `rg` / `sed` / `cat` / `nl` / `ls`
- read-only `git status` / `git diff` / `git log` / `git show`
- version probes and simple filesystem inspection

Windows notes:

- Prefer no-space forward-slash paths such as `D:/path/to/file`
- `readonly_shell` runs through `cmd.exe`; pass allowlisted commands available in `cmd.exe`/PATH
- Useful Windows-native allowlisted commands include `dir`, `type`, `where`, `findstr`, `more`, `fc`, and `ver`
- Avoid nested `cmd /c` or `powershell -Command`; obvious nested-shell patterns may only warn and are not rewritten

Example:

```typescript
readonly_shell({
  command: 'git status',
});
```

### 2. `apply_patch`

Purpose: apply explicit patch hunks to files in the workspace.

Typical uses:

- add or remove code blocks
- update a function implementation
- create or delete a file through patch syntax

Example:

```typescript
apply_patch({
  patch:
    '*** Begin Patch\n*** Update File: src/index.ts\n@@\n-console.log(\"old\");\n+console.log(\"new\");\n*** End Patch\n',
});
```

## Output Expectations

- `readonly_shell` returns command output or a structured failure message
- `apply_patch` returns whether the patch was applied or why it failed

Function-tool definitions remain the canonical source for parameters and returns.
