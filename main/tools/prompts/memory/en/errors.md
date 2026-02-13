# memory Error Handling

## Template (Errors)

### Error Chain (required)

1. Trigger Condition
2. Detection Signal
3. Recovery Steps
4. Success Criteria
5. Escalation Path (optional)

## Error Codes

### MEMORY_ALREADY_EXISTS

**Description:** Path already exists, cannot use `add_memory` to create new memory.

**Cause:**

- The path you're trying to add is already occupied by another memory

**Solution:**

- Use `replace_memory` to update existing memory
- Or use a different path to create new memory

**Example:**

```
Error:
status: error
error_code: MEMORY_ALREADY_EXISTS
message: Path "project/todo" already exists, please use replace_memory to update
```

### MEMORY_NOT_FOUND

**Description:** Path does not exist, cannot perform operation.

**Cause:**

- The memory path you're trying to access doesn't exist
- The path was deleted or never created

**Solution:**

- For update/delete operations, first use `add_memory` to create
- Check if the path is correct

**Example:**

```
Error:
status: error
error_code: MEMORY_NOT_FOUND
message: Path "project/todo" does not exist, please use add_memory to create first
```

### MEMORY_PATH_INVALID

**Description:** Path format is invalid.

**Cause:**

- Path contains illegal characters
- Path length exceeds limit

**Solution:**

- Ensure path only contains letters, numbers, underscores, slashes
- Path length should not exceed 255 characters

**Example:**

```
Error:
status: error
error_code: MEMORY_PATH_INVALID
message: Path "project/*invalid*" contains illegal characters
```

### MEMORY_CONTENT_TOO_LARGE

**Description:** Memory content is too large.

**Cause:**

- Single memory content exceeds 1MB limit

**Solution:**

- Compress content
- Split into multiple memories
- Use external storage (e.g., files)

**Example:**

```
Error:
status: error
error_code: MEMORY_CONTENT_TOO_LARGE
message: Content size 1.2MB exceeds 1MB limit
```

### MEMORY_STORAGE_ERROR

**Description:** Storage error.

**Cause:**

- Insufficient disk space
- Permission issues
- File system error

**Solution:**

- Check disk space
- Check file permissions
- Retry operation

**Example:**

```
Error:
status: error
error_code: MEMORY_STORAGE_ERROR
message: Cannot write to storage, insufficient disk space
```

## Frequently Asked Questions

### Q: Does memory auto-save?

A: Yes, all memory operations are immediately persisted to disk. No manual save is needed.

### Q: Is there a limit on the number of memories?

A: There's no strict limit, but it's recommended to keep the number of memories reasonable (less than 100 recommended).

### Q: Can other members see my memories?

A: No, memory is a personal memory tool, only the current agent can access it. If you need to share with team members, please use team_memory.

### Q: Will clear_memory delete all memories?

A: Yes, `clear_memory` will delete all personal memories, this operation is irreversible. Please use with caution.

### Q: Do memories expire?

A: No, memories are permanently saved until explicitly deleted.

### Q: How do I view all current memories?

A: The agent can access all personal memories during response generation. You can directly ask the agent what memories it currently has.
