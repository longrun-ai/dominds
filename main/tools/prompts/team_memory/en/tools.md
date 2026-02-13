# team_memory Tool Reference

## Template (Tools)
### How to Read
- The schema-generated "Tool Contract (Schema)" section is canonical for parameters/returns.
### Per-Tool Fields (order)
1) Purpose
2) Call Signature
3) Parameters (refer to schema)
4) Preconditions
5) Success Signal
6) Failure/Errors
7) Copy-Ready Example
8) Common Misuse

## Tool List

### 1. add_shared_memory

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

- `SHARED_MEMORY_ALREADY_EXISTS`: Path already exists, use `replace_shared_memory` to update

### 2. replace_shared_memory

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

- `SHARED_MEMORY_NOT_FOUND`: Path does not exist, use `add_shared_memory` to create

### 3. drop_shared_memory

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

### 4. clear_shared_memory

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
add_shared_memory({
  path: 'team/conventions/commit-message',
  content:
    '## Commit Message Format\n\nFormat: <type>(<scope>): <description>\n\n### Type\n- feat: New feature\n- fix: Bug fix\n- docs: Documentation\n- style: Formatting\n- refactor: Refactoring\n- test: Testing\n- chore: Maintenance\n\n### Examples\nfeat(auth): Add login verification\nfix(ui): Fix button style',
});
```

### Update Project Status

```typescript
replace_shared_memory({
  path: 'team/project/status',
  content:
    '## Project Status\n\n- Current Sprint: Sprint 15\n- Release Target: 2024-02-01\n- Blocking Issues: None\n- Pending Review: 3 PRs',
});
```

### Delete Deprecated Information

```typescript
drop_shared_memory({
  path: 'team/deprecated/api-v1',
});
```

## YAML Output Contract

All tool outputs use YAML format for programmatic processing:

- `status`: Operation status, `ok` for success, `error` for failure
- `path`: Memory path
- Other fields: Additional information for specific operations

On error, returns:

```yaml
status: error
error_code: <error code>
message: <error message>
```
