# Dominds Tests

To ensure correct module resolution and configuration, tests should be run with this directory (`tests/`) as the current working directory.

## Running Tests

From the `dominds` project root:

```bash
cd tests
npx tsx texting/parsing.ts
```

Or directly from this directory:

```bash
npx tsx texting/parsing.ts
```

## Why CWD matters?

Running from this directory ensures that `tsx` picks up the local [tsconfig.json](tsconfig.json), which defines the necessary path aliases for the `dominds` module:

```json
"paths": {
  "dominds": ["../main/index.ts"],
  "dominds/*": ["../main/*.ts"]
}
```
