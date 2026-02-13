# codex_style_tools Tool Reference

## Template (Tools)

### How to Read

- The schema-generated "Tool Contract (Schema)" section is canonical for parameters/returns.

### Per-Tool Fields (order)

1. Purpose
2. Call Signature
3. Parameters (refer to schema)
4. Preconditions
5. Success Signal
6. Failure/Errors
7. Copy-Ready Example
8. Common Misuse

## Tool List

### 1. apply_patch

Apply code patch.

**Parameters:**

- `patch` (required): Patch content

**Returns:**

```yaml
status: ok|error
path: <file path>
patch_applied: <whether applied successfully>
applied_at: <application timestamp>
```

**Errors:**

- `PATCH_INVALID`: Invalid patch format
- `FILE_NOT_FOUND`: Target file doesn't exist

### 2. readonly_shell

Execute read-only Shell command.

**Parameters:**

- `command` (required): Command to execute

**Returns:**

```yaml
status: ok|error
command: <executed command>
output: <command output>
exit_code: <exit code>
executed_at: <execution timestamp>
```

**Errors:**

- `COMMAND_NOT_ALLOWED`: Command not allowed to execute

### 3. update_plan

Update task plan.

**Parameters:**

- `plan` (required): Plan items array (`[{ step, status }]`)
- `explanation` (optional): Plan update explanation

**Returns:**

```yaml
status: ok|error
plan: <plan content>
updated_at: <update timestamp>
```

## Usage Examples

### Apply Patch

```typescript
apply_patch({
  patch: '--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,4 @@\n line1\n line2\n+line3\n',
});
```

### Execute Read-Only Command

```typescript
readonly_shell({
  command: 'ls -la',
});
```

### Update Plan

```typescript
update_plan({
  explanation: "Today's Tasks",
  plan: [
    { step: 'Complete code review', status: 'in_progress' },
    { step: 'Fix bug', status: 'pending' },
    { step: 'Write documentation', status: 'pending' },
  ],
});
```

## YAML Output Contract

All tool outputs use YAML format for programmatic processing:

- `status`: Operation status, `ok` for success, `error` for failure
- Other fields: Additional information for specific operations
