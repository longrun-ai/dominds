# @dominds/codex-tools

Dominds integration helpers that port the **Codex CLI (Rust)** “built-in tools” contracts into
**Dominds function tools** (and provide Dominds toolsets that bundle them).

This package exists because Codex models are often prompted with Codex CLI–style tool names
(`shell_command`, `apply_patch`, etc.), while Dominds historically exposed a different tool surface.

## What You Get

### Tools (ported contracts)

- `shell_command` — run a shell command (string form) with optional `workdir`, `login`, and
  `timeout_ms`.
- `apply_patch` — apply the Codex `apply_patch` patch format to the current workspace.

The `apply_patch` patch grammar and behavior are based on the Rust implementation:
`codex-rs/apply-patch/apply_patch_tool_instructions.md` and `codex-rs/apply-patch/src/*`.

### Dominds Toolsets

Dominds registers these toolsets (function-tools only) to make it easy to opt-in per agent:

- `codex_ws_read` — workspace read-only + Codex compatibility (`shell_command`).
- `codex_ws_mod` — workspace read/write + Codex compatibility (`shell_command`, `apply_patch`).

## Usage (Dominds)

In your rtws `team.yaml`, add the toolset(s) to the relevant member:

```yaml
members:
  fuxi:
    toolsets:
      - codex_ws_mod
```

## `shell_command`

Ported from the Codex protocol tool-call shape (`codex-rs/protocol/src/models.rs`).

### Arguments

```ts
{
  command: string;
  workdir?: string;
  login?: boolean;
  timeout_ms?: number;
  sandbox_permissions?: unknown; // accepted for compatibility; not enforced by Dominds
  justification?: string;        // accepted for compatibility; not enforced by Dominds
}
```

### Output

Returns a Markdown string containing:

- exit code (or “timeout”)
- captured `stdout` and `stderr` (bounded; may be truncated)

## `apply_patch`

`apply_patch` applies a **file-oriented patch** (not unified diff) to the current workspace.
Paths must be **relative** to the workspace root.

### Arguments

```ts
{
  patch: string;
}
```

### Patch format (grammar)

The accepted patch format matches the Codex CLI `apply_patch` tool:

```text
*** Begin Patch
[ one or more file sections ]
*** End Patch
```

File sections:

```text
*** Add File: <path>
+<line>
+<line>
*** Delete File: <path>
*** Update File: <path>
[*** Move to: <new path>]
@@ [optional header]
 <context line>
-<removed line>
+<added line>
[*** End of File]
```

Notes:

- Marker lines allow leading/trailing whitespace (lenient parsing like Codex CLI).
- `*** Add File:` overwrites an existing file if present (Codex CLI behavior).
- `*** Update File:` requires the source file to exist.
- `*** Move to:` overwrites the destination if it already exists (Codex CLI behavior).
- Patches are applied **sequentially**; if a later operation fails, earlier successful changes stay.

### Example

```text
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.ts
@@
-console.log("Hi")
+console.log("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
```

## Scope / non-goals

- This package ports **tool contracts and patch semantics**, not the Codex CLI UI.
- Dominds does not currently implement Codex CLI “approval” UX for these tools.
- `sandbox_permissions` and `justification` are accepted for compatibility but are not enforced here.
