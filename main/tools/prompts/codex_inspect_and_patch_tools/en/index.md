# codex_inspect_and_patch_tools Manual

`codex_inspect_and_patch_tools` is Dominds' lightweight inspect-and-patch toolset for coding agents.

It intentionally exposes only two tools:

- `readonly_shell`: inspect the workspace with a tightly constrained read-only shell
- `apply_patch`: make explicit, reviewable file edits through patch hunks

## Recommended Use

- Recommended by default for `gpt-5.x` coding models across providers, as an addition to `ws_read` / `ws_mod`
- Good fit when you want a model to inspect code and submit precise patches without giving it full shell mutation power
- Not a drop-in recreation of Codex runtime orchestration; this toolset focuses on local inspection and patching only

## Quick Start

1. Inspect the current state with `readonly_shell`
2. Read the relevant files through normal workspace tools
3. Apply the concrete edit with `apply_patch`

## Navigation

| Topic                         | Description                                    |
| ----------------------------- | ---------------------------------------------- |
| [principles](./principles.md) | Toolset purpose, safety model, and boundaries  |
| [tools](./tools.md)           | Tool-by-tool reference and copy-ready examples |
| [scenarios](./scenarios.md)   | Common coding workflows                        |
| [errors](./errors.md)         | Failure modes and recovery guidance            |

## Difference From Nearby Toolsets

| Toolset                         | Main role                              |
| ------------------------------- | -------------------------------------- |
| `codex_inspect_and_patch_tools` | Constrained inspect-and-patch workflow |
| `os`                            | Broader shell/runtime operations       |
| `ws_mod`                        | General workspace file mutation tools  |
