# team_memory Error Handling

## Error Codes

### SHARED_MEMORY_ALREADY_EXISTS

**Description:** Path already exists, cannot use `add_shared_memory` to create new memory.

**Cause:**

- The path you're trying to add is already occupied by another shared memory

**Solution:**

- Use `replace_shared_memory` to update existing memory
- Or use a different path to create new memory

### SHARED_MEMORY_NOT_FOUND

**Description:** Path does not exist, cannot perform operation.

**Cause:**

- The shared memory path you're trying to access doesn't exist
- The path was deleted or never created

**Solution:**

- For update/delete operations, first use `add_shared_memory` to create
- Check if the path is correct

### SHARED_MEMORY_PATH_INVALID

**Description:** Path format is invalid.

**Cause:**

- Path contains illegal characters
- Path length exceeds limit

**Solution:**

- Ensure path only contains letters, numbers, underscores, slashes
- Path length should not exceed 255 characters

### SHARED_MEMORY_CONTENT_TOO_LARGE

**Description:** Memory content is too large.

**Cause:**

- Single memory content exceeds 1MB limit

**Solution:**

- Compress content
- Split into multiple memories
- Use external storage (e.g., files)

### SHARED_MEMORY_STORAGE_ERROR

**Description:** Storage error.

**Cause:**

- Insufficient disk space
- Permission issues
- File system error

**Solution:**

- Check disk space
- Check file permissions
- Retry operation

## Frequently Asked Questions

### Q: What's the difference between shared memory and personal memory?

A: Shared memory (team_memory) is visible to all team members, while personal memory (memory) is only visible to the current agent.

### Q: Who can modify shared memory?

A: All team members can read and modify shared memory. Please operate with caution to avoid overwriting important information from others.

### Q: How to avoid conflicts?

A: It's recommended to read existing content first before modifying, confirm there are no conflicts, then update. You can also include version numbers or dates in the path to distinguish.

### Q: Will clear_shared_memory affect other members?

A: Yes, `clear_shared_memory` will delete all shared memory, affecting all team members. This operation is irreversible, please use with caution.

### Q: Is there a limit on the number of shared memories?

A: There's no strict limit, but it's recommended to keep the number of memories reasonable (less than 100 recommended).

### Q: How do I view all team shared memories?

A: The agent can access all shared memories during response generation. You can directly ask the agent what shared memories the team currently has.
