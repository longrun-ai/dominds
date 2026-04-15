# codex_inspect_and_patch_tools Error Handling

## Common Failures

### `PATCH_INVALID`

Meaning: the patch format is invalid or does not match the target file state.

Recovery:

1. Re-read the target file
2. Rebuild the patch against current content
3. Retry with a smaller, cleaner hunk if needed

### `FILE_NOT_FOUND`

Meaning: the patch targets a path that does not exist in the expected state.

Recovery:

1. Verify the path
2. Confirm whether this should be an add-file patch instead

### `COMMAND_NOT_ALLOWED`

Meaning: `readonly_shell` rejected the command as non-read-only or outside the allowlist.

Recovery:

1. Rewrite the command using allowed read-only primitives
2. Split complex logic into simpler allowed inspection commands

## FAQ

### What is this toolset for?

It is a narrow inspect-and-patch surface for coding agents, especially recommended for `gpt-5.x` models.

### Why is my shell command rejected?

Because `readonly_shell` is intentionally strict. It accepts only read-only inspection commands and rejects mutation or scripting patterns outside the allowlist.

### When should I use `os` instead?

Use `os` only when you truly need broader shell execution. Keep `codex_inspect_and_patch_tools` for the safer inspect-and-patch default.
