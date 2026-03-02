# memory Tool Reference

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

### 1. add_memory

Create new memory (when path does not exist).

**Parameters:**

- `path` (required): Unique identifier for the memory
- `content` (required): Memory content

**Returns:**

- Success: a short plain-text message in the work language (e.g. `Added`).
- Failure: a plain-text error message (often starts with `Error:`) with an actionable next step (e.g. use `replace_memory`).

**Errors:**

- `MEMORY_ALREADY_EXISTS`: Path already exists, use `replace_memory` to update

### 2. replace_memory

Update existing memory (when path exists).

**Parameters:**

- `path` (required): Unique identifier for the memory
- `content` (required): New memory content

**Returns:**

- Success: a short plain-text message in the work language (e.g. `Updated`).
- Failure: a plain-text error message (often starts with `Error:`) with an actionable next step (e.g. use `add_memory`).

**Errors:**

- `MEMORY_NOT_FOUND`: Path does not exist, use `add_memory` to create

### 3. drop_memory

Delete specified memory.

**Parameters:**

- `path` (required): Memory path to delete

**Returns:**

- Success: a short plain-text message in the work language (e.g. `Deleted`).
- Failure: a plain-text error message (often starts with `Error:`).

**Errors:**

- `MEMORY_NOT_FOUND`: Path does not exist

### 4. clear_memory

Clear all personal memory.

**Warning:** This operation is irreversible!

**Parameters:** None

**Returns:**

- Success: a short plain-text message in the work language (e.g. `Cleared`). If there is nothing to clear, returns a message like `No personal memory to clear.`
- Failure: a plain-text error message.

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

## Output and Language

- Output is **plain text**, not structured JSON/YAML.
- The message language follows the current **work language**.
