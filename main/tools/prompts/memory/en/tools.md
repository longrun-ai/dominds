# memory Tool Reference

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

### 1. add_memory

Create new memory (when path does not exist).

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

- `MEMORY_ALREADY_EXISTS`: Path already exists, use `replace_memory` to update

### 2. replace_memory

Update existing memory (when path exists).

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

- `MEMORY_NOT_FOUND`: Path does not exist, use `add_memory` to create

### 3. drop_memory

Delete specified memory.

**Parameters:**

- `path` (required): Memory path to delete

**Returns:**

```yaml
status: ok|error
path: <memory path>
deleted_at: <deletion timestamp>
```

**Errors:**

- `MEMORY_NOT_FOUND`: Path does not exist

### 4. clear_memory

Clear all personal memory.

**Warning:** This operation is irreversible!

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

### Add New Memory

```typescript
add_memory({
  path: 'project/todo',
  content: '- Complete i18n docs\n- Write test cases\n- Update README',
});
```

### Update Existing Memory

```typescript
replace_memory({
  path: 'project/todo',
  content: '- Complete i18n docs [DONE]\n- Write test cases [IN PROGRESS]\n- Update README',
});
```

### Delete Memory

```typescript
drop_memory({
  path: 'project/todo',
});
```

### Clear All Memory

```typescript
clear_memory({});
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
