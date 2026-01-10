# Dominds Tests

`tests/` is a workspace package (`@dominds/tests`). When you run scripts from this package, `tsx` automatically picks up `tests/tsconfig.json`.

## Running Tests

From the `dominds` project root (recommended):

```bash
pnpm -C tests run parsing
```

Or directly from `tests/`:

```bash
pnpm run parsing
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

| Script              | Runs                                                      |
| ------------------- | --------------------------------------------------------- |
| parsing             | `texting/parsing.ts` (headline/body parser)               |
| mentionx            | `texting/mentionx.ts` (extractMentions tests)             |
| realtime            | `texting/realtime.ts` (streaming parser boundaries)       |
| func-call           | `provider/func-call.ts` (non-streaming function calls)    |
| stream-func-call    | `provider/stream-func-call.ts` (streaming function calls) |
| anthropic-streaming | `provider/anthropic-streaming.ts` (streaming smoke test)  |
| codex-streaming     | `provider/codex-streaming.ts` (streaming smoke test)      |
| toolset-registry    | `toolsets/registry.ts` (tool registry checks)             |
| dialog-driving      | `driving/dialog-driving.ts` (dialog event driving)        |
| type-a-flow         | `driving/type-a-flow.ts`                                  |
| type-b-flow         | `driving/type-b-flow.ts`                                  |
| type-c-flow         | `driving/type-c-flow.ts`                                  |
| revival-flow        | `driving/revival-flow.ts`                                 |
| llm-streaming       | `driving/llm-streaming.ts`                                |
| teammate-call-parse | `driving/teammate-call-parse.ts`                          |
