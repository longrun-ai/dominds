### Error Codes

### FILE_NOT_FOUND

**Description:** File does not exist.

**Cause:**

- Incorrect file path
- File has been deleted
- Insufficient permissions

**Solution:**

- Check if file path is correct
- Use `list_dir` to view directory structure
- Check file permissions

### DIRECTORY_NOT_FOUND

**Description:** Directory does not exist.

**Cause:**

- Incorrect directory path
- Directory has been deleted

**Solution:**

- Check if directory path is correct
- Use `list_dir` to view accessible directories

### PERMISSION_DENIED

**Description:** Insufficient permissions.

**Cause:**

- Current user doesn't have read permission
- File/directory permissions are too restrictive

**Solution:**

- Check file/directory permissions
- Contact administrator for permissions

### SEARCH_FAILED

**Description:** Search failed.

**Cause:**

- Search pattern syntax error
- Search path doesn't exist

**Solution:**

- Check if search pattern is correct
- Check if search path exists

### Frequently Asked Questions

### Q: Why can't I read the file?

A: Possible reasons:

1. Incorrect file path
2. File doesn't exist
3. Insufficient permissions

### Q: Why can't I find any results?

A: Possible reasons:

1. Incorrect search pattern
2. Incorrect search path
3. No matching content

### Q: Can I read files outside rtws?

A: No, ws_read can only read files within rtws (runtime workspace).

### Q: Why does list_dir return empty?

A: Possible reasons:

1. Directory is empty
2. Directory doesn't exist
3. Insufficient permissions

### Q: How to search specific types of files?

A: Use `globs` parameter to specify file types, for example:

```typescript
ripgrep_files({
  pattern: 'TODO',
  globs: ['*.ts', '*.tsx'],
});
```
