# team_memory Tool Reference

## Template (Tools)

### How to Read

- Function-tool definitions are the canonical source for parameters and returns; this manual only adds usage guidance.

### Per-Tool Fields (order)

1. Purpose
2. Call Signature
3. Parameters (summarize only when usage guidance is needed)
4. Preconditions
5. Success Signal
6. Failure/Errors
7. Copy-Ready Example
8. Common Misuse

## Tool List

### 1. add_team_memory

Create new shared memory (when path does not exist).

**Parameters:**

- `path` (required): Unique identifier for the memory
- `content` (required): Memory content

**Returns:**

```yaml
status: ok|error
path: <memory path>
content_size: <content size in bytes>
created_at: <creation timestamp>
```

**Errors:**

- Target path already exists: use `replace_team_memory` to update

### 2. replace_team_memory

Update existing shared memory (when path exists).

**Parameters:**

- `path` (required): Unique identifier for the memory
- `content` (required): New memory content

**Returns:**

```yaml
status: ok|error
path: <memory path>
content_size: <content size in bytes>
updated_at: <update timestamp>
```

**Errors:**

- Target path does not exist: use `add_team_memory` to create

### 3. drop_team_memory

Delete specified shared memory.

**Parameters:**

- `path` (required): Memory path to delete

**Returns:**

```yaml
status: ok|error
path: <memory path>
deleted_at: <deletion timestamp>
```

**Errors:**

- `SHARED_MEMORY_NOT_FOUND`: Path does not exist

### 4. clear_team_memory

Clear all shared memory.

**Warning:** This operation is irreversible! Will affect all team members.

**Parameters:** None

**Returns:**

```yaml
status: ok|error
cleared_count: <number of memories deleted>
cleared_at: <deletion timestamp>
```

**Errors:**

- None (returns success even if no memories exist)

## Usage Examples

### Add Team Convention

```typescript
add_team_memory({
  path: 'team/conventions/commit-message',
  content:
    '## Commit Message Format\n\nFormat: <type>(<scope>): <description>\n\n### Type\n- feat: New feature\n- fix: Bug fix\n- docs: Documentation\n- style: Formatting\n- refactor: Refactoring\n- test: Testing\n- chore: Maintenance\n\n### Examples\nfeat(auth): Add login verification\nfix(ui): Fix button style',
});
```

### Update Shared Invariants

```typescript
replace_team_memory({
  path: 'team/ops/release-invariants',
  content:
    '## Release Invariants\n\n- Before merging wire-protocol changes, check frontend consumers in the same change\n- Before release, confirm key rollback entrypoints\n- During incidents, lock the timeline and evidence first, then debate the fix',
});
```

### Delete Deprecated Information

```typescript
drop_team_memory({
  path: 'team/deprecated/api-v1',
});
```

## Output and Language

- Output is **plain text**, not structured JSON/YAML.
- The message language follows the current **work language**.
