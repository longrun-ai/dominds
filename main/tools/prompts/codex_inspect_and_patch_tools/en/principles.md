# codex_inspect_and_patch_tools Principles

## Design Goals

- Give coding models a small, high-signal tool surface for inspection plus explicit patching
- Preserve reviewability: edits happen through patches, not arbitrary shell mutation
- Stay provider-agnostic at the toolset level; recommend it for `gpt-5.x` models regardless of provider

## Core Model

### 1. Inspect First

Use `readonly_shell` to inspect repo state, grep, diff, and verify assumptions without mutating the workspace.

### 2. Patch Explicitly

Use `apply_patch` for deliberate file changes. The patch itself is the review surface.

### 3. Keep It Narrow

This toolset is intentionally not a general shell toolset and not a planning/status toolset. If you need broader execution, use another toolset instead of stretching this one.

## Tool Overview

| Tool             | Role                                     |
| ---------------- | ---------------------------------------- |
| `readonly_shell` | Read-only shell inspection               |
| `apply_patch`    | Explicit code/file edits through patches |

## Best Practices

- Inspect before editing; do not guess file state
- Prefer `readonly_shell` for repo probes such as `rg`, `git diff`, `ls`, and `sed`
- Keep `apply_patch` hunks focused and reviewable
- Pair this toolset with `ws_read` / `ws_mod` rather than treating it as a replacement

## Boundaries

1. `readonly_shell` rejects mutation and scripting patterns outside its allowlist
2. `apply_patch` is for concrete patch hunks, not free-form file writing workflows
3. Task planning and reminder management belong elsewhere, not in this toolset
