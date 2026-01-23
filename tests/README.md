# Dominds Tests

`tests/` is a workspace package (`@dominds/tests`). When you run scripts from this package, `tsx` automatically picks up `tests/tsconfig.json`.

## Running Tests

From the `dominds` project root (recommended):

```bash
pnpm -C tests run tellask:parsing
```

Or directly from `tests/`:

```bash
pnpm run tellask:parsing
```

General form:

```bash
pnpm -C tests run <script>
```

## Why the tests tsconfig?

Scripts run with `tests/` as CWD, so `tsx` picks up `tests/tsconfig.json` automatically.

If a script takes arguments, pass them after `--`:

```bash
pnpm -C tests run func-call -- --provider minimaxi.com-coding-plan --model MiniMax-M2
```

If you run `tsx` directly from the repo root, pass `--tsconfig tests/tsconfig.json` to pick up the aliases.

Path aliases in `tests/tsconfig.json`:

```json
"paths": {
  "dominds": ["../main/index.ts"],
  "dominds/*": ["../main/*.ts"]
}
```

## Available scripts

| Script                           | Runs                                                      |
| -------------------------------- | --------------------------------------------------------- |
| auth                             | `auth.ts` (auth key/env/header parsing)                   |
| mindset-i18n                     | `minds/mindset-i18n.ts` (mindset i18n checks)             |
| persistence-latest-writeback     | `persistence/latest-writeback.ts`                         |
| persistence-reminders-owner-meta | `persistence/reminders-owner-meta.ts`                     |
| tellask:parsing                  | `tellask/parsing.ts` (tellask parser)                     |
| tellask:realtime                 | `tellask/realtime.ts` (streaming boundaries)              |
| task-package                     | `task-package.ts`                                         |
| taskdoc-search                   | `taskdoc-search.ts`                                       |
| team-yaml-parsing                | `team-yaml-parsing.ts`                                    |
| func-call                        | `provider/func-call.ts` (non-streaming function calls)    |
| stream-func-call                 | `provider/stream-func-call.ts` (streaming function calls) |
| anthropic-streaming              | `provider/anthropic-streaming.ts` (streaming smoke test)  |
| codex-streaming                  | `provider/codex-streaming.ts` (streaming smoke test)      |
| toolset-registry                 | `toolsets/registry.ts` (tool registry checks)             |
| diag-tool                        | `toolsets/diag.ts`                                        |
| memory-access                    | `toolsets/memory-access.ts`                               |
| webapp-last-modified             | `webapp/dialog-last-modified.ts`                          |
| webapp-run-control-visual        | `webapp/run-control-visual.ts`                            |
