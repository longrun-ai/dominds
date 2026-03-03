# personal_memory Tool Reference

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

### 1. add_personal_memory

Create new **personal** memory (when path does not exist).

**Parameters:**

- `path` (required): Unique identifier for the memory
- `content` (required): Memory content

**Returns:**

- Success: a short plain-text message in the work language (e.g. `Added`).
- Failure: a plain-text error message (often starts with `Error:`) with an actionable next step (e.g. use `replace_personal_memory`).

**Errors:**

- `MEMORY_ALREADY_EXISTS`: Path already exists, use `replace_personal_memory` to update

### 2. replace_personal_memory

Update existing memory (when path exists).

**Parameters:**

- `path` (required): Unique identifier for the memory
- `content` (required): New memory content

**Returns:**

- Success: a short plain-text message in the work language (e.g. `Updated`).
- Failure: a plain-text error message (often starts with `Error:`) with an actionable next step (e.g. use `add_personal_memory`).

**Errors:**

- `MEMORY_NOT_FOUND`: Path does not exist, use `add_personal_memory` to create

### 3. drop_personal_memory

Delete specified memory.

**Parameters:**

- `path` (required): Memory path to delete

**Returns:**

- Success: a short plain-text message in the work language (e.g. `Deleted`).
- Failure: a plain-text error message (often starts with `Error:`).

**Errors:**

- `MEMORY_NOT_FOUND`: Path does not exist

### 4. clear_personal_memory

Clear all personal memory.

**Warning:** This operation is irreversible!

**Parameters:** None

**Returns:**

- Success: a short plain-text message in the work language (e.g. `Cleared`). If there is nothing to clear, returns a message like `No personal memory to clear.`
- Failure: a plain-text error message.

**Errors:**

- None (returns success even if no memories exist)

## Usage Examples

### Add New Personal Memory

```typescript
add_personal_memory({
  path: 'project/todo',
  content: '- Complete i18n docs\n- Write test cases\n- Update README',
});
```

### Update Existing Memory

```typescript
replace_personal_memory({
  path: 'project/todo',
  content: '- Complete i18n docs [DONE]\n- Write test cases [IN PROGRESS]\n- Update README',
});
```

### Delete Memory

```typescript
drop_personal_memory({
  path: 'project/todo',
});
```

### Clear All Memory

```typescript
clear_personal_memory({});
```

## Output and Language

- Output is **plain text**, not structured JSON/YAML.
- The message language follows the current **work language**.
