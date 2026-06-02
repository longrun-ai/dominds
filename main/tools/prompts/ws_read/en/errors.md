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

### INVALID_FORMAT

**Description:** The `read_file` input looks like mixed tool-call text or another unsupported format.

**Cause:**

- Function tool call text was pasted into `path` or `range`
- Multiple tool calls were combined into one `read_file` invocation

**Solution:**

- Split each tool call into its own function call
- Pass only structured `read_file({ path, range, max_lines, show_linenos })` arguments

### ACCESS_DENIED

**Description:** Access to a reserved rtws path is hard-denied.

**Cause:**

- `.minds/**` is reserved for team configuration, memory, and assets
- `.dialogs/**` at the rtws root is reserved dialog/runtime persistence
- `*.tsk/` is an encapsulated Taskdoc path

**Solution:**

- For `.minds/**`, use `team_mgmt_*` tools when that toolset is configured
- For Dominds dialog debugging, reproduce under a nested rtws such as `ux-rtws/.dialogs/**`
- Do not read or search `*.tsk/` packages through generic ws_read tools

### SEARCH_FAILED

**Description:** Search failed.

**Cause:**

- Search pattern syntax error
- Search path doesn't exist

**Solution:**

- Check if search pattern is correct
- Check if search path exists

### DISALLOWED_ARG

**Description:** A raw ripgrep argument is not allowed.

**Cause:**

- The argument would bypass the tool's safety policy
- The argument is not supported by the wrapped `ripgrep_*` tool

**Solution:**

- Remove the disallowed raw argument
- Use the structured tool parameters (`pattern`, `globs`, `path`, etc.) instead

### FAILED

**Description:** The read/search operation failed after validation.

**Cause:**

- Underlying filesystem or ripgrep execution failed
- OS-level permissions blocked the read/search operation
- The path or search configuration became invalid at runtime

**Solution:**

- Re-read or re-list the target path
- Retry with a narrower path/pattern
- Fix filesystem permissions when the error text points to permission failure
- If the failure repeats, report the exact tool output and path/pattern

### Frequently Asked Questions

### Q: Why can't I read the file?

A: Possible reasons:

1. Incorrect file path
2. File doesn't exist
3. Filesystem permissions or another runtime failure

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
3. Filesystem permissions or another runtime failure

### Q: How to search specific types of files?

A: Use `globs` parameter to specify file types, for example:

```typescript
ripgrep_files({
  pattern: 'TODO',
  globs: ['*.ts', '*.tsx'],
});
```
