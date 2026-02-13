# codex_style_tools Error Handling

## Template (Errors)
### Error Chain (required)
1) Trigger Condition
2) Detection Signal
3) Recovery Steps
4) Success Criteria
5) Escalation Path (optional)

## Error Codes

### PATCH_INVALID

**Description:** Invalid patch format.

**Cause:**

- Patch format doesn't conform to unified diff format
- Patch cannot be applied to target file

**Solution:**

- Check if patch format is correct
- Ensure patch matches target file

### FILE_NOT_FOUND

**Description:** Target file doesn't exist.

**Cause:**

- Incorrect file path
- File has been deleted

**Solution:**

- Check if file path is correct
- Confirm if file exists

### COMMAND_NOT_ALLOWED

**Description:** Command not allowed to execute.

**Cause:**

- Command is identified as a modification operation
- Command is not in the allowed list

**Solution:**

- Use read-only commands
- Check if command is in the whitelist

## Frequently Asked Questions

### Q: What to do if apply_patch fails?

A: Check the following:

1. Is patch format correct?
2. Does target file exist?
3. Does patch match file content?

### Q: What commands can readonly_shell execute?

A: Read-only commands such as:

- ls, cat, grep
- git status, git log
- find, which

### Q: What are the limitations of update_plan?

A: update_plan is primarily incremental updates, recommended:

- Keep plans concise
- Update regularly

### Q: Why was my command rejected?

A: Possible reasons:

1. Command is identified as a modification operation
2. Command is not in the allowed list
3. Command has security risks

### Q: How to view available read-only commands?

A: Common read-only commands include:

- File viewing: ls, cat, head, tail
- Search: grep, find
- Git status: git status, git log, git diff
