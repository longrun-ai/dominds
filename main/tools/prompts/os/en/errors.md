# os Error Handling

## Template (Errors)

### Error Chain (required)

1. Trigger Condition
2. Detection Signal
3. Recovery Steps
4. Success Criteria
5. Escalation Path (optional)

## Error Codes

### SHELL_COMMAND_FAILED

**Description:** Shell command execution failed.

**Cause:**

- Command doesn't exist
- Insufficient permissions
- Command execution timeout

**Solution:**

- Check if command exists
- Check execution permissions
- Increase timeout

### DAEMON_NOT_FOUND

**Description:** Daemon process doesn't exist.

**Cause:**

- Specified daemon ID doesn't exist
- Daemon process has been deleted

**Solution:**

- Check if daemon ID is correct
- Confirm if daemon is started

### DAEMON_NOT_RUNNING

**Description:** Daemon process is not running.

**Cause:**

- Daemon process has stopped
- Daemon process crashed

**Solution:**

- Restart daemon process
- Check daemon process logs

### ENV_NOT_FOUND

**Description:** Environment variable doesn't exist.

**Cause:**

- Environment variable not set
- Environment variable has been deleted

**Solution:**

- Use `env_set` to set environment variable
- Check if environment variable name is correct

### ENV_PERMISSION_DENIED

**Description:** Insufficient permissions for environment variable operation.

**Cause:**

- Some environment variables require root permissions
- System-protected environment variables

**Solution:**

- Use sudo to elevate permissions
- Avoid modifying system-protected environment variables

## Frequently Asked Questions

### Q: What security risks does shell command execution have?

A: Shell command execution may pose the following risks:

- Command injection attacks
- Accidentally executing destructive commands (e.g., rm -rf)
- Privilege escalation attacks

Recommendation: Validate all input, use parameterized commands, avoid dynamic command concatenation.

### Q: How to avoid destructive commands?

A:

- Verify commands before execution
- Use commands like `ls` to first view targets
- Use `-i` parameter to enable interactive confirmation

### Q: Why are environment variable modifications ineffective?

A: Environment variable modifications are only effective for the current process and its child processes, they don't affect the system-wide environment. To modify permanently, you need to set it in shell configuration files (e.g., .bashrc).

### Q: What's the difference between daemon processes and regular processes?

A: Daemon processes run in the background, usually without terminal control and without direct user interaction. Regular processes are usually associated with a terminal and can receive user input.

### Q: How to view command output?

A: Shell command output is returned through `stdout` and `stderr` fields. `stdout` is standard output, `stderr` is standard error output.
