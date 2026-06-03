# os Tool Reference

## Template (Tools)

### How to Read

- Function-tool definitions are the canonical source for parameters and returns; this manual only adds usage guidance.

### Per-Tool Fields (order)

1. Purpose
2. Call Signature
3. Parameters (summarize only when usage guidance is needed)
4. Preconditions
5. Success Signal
6. Failure/Errors
7. Copy-Ready Example
8. Common Misuse

## Tool List

### 1. shell_cmd

Execute Shell command.

**Parameters:**

- `command` (required): Command to execute
- `shell` (optional): Shell to use for execution (default: `bash` on Linux/macOS, `cmd.exe` on Windows)
- `scrollbackLines` (optional): Number of recent output lines to retain in scrollback
- `timeoutSeconds` (optional): Timeout in seconds before switching to daemon tracking

**Windows notes:**

- Use `shell` to choose the outer execution environment: `cmd.exe`, `powershell.exe`, or `pwsh`
- Pass a command that is native to the selected shell; do not nest `cmd /c` or `powershell -Command` inside another shell command
- With the default `cmd.exe` path, prefer no-space forward-slash paths such as `D:/path/to/file`
- Only very obvious nested-shell patterns may trigger a warning; the tool does not rewrite mixed shell syntax for you

**Returns:**

```yaml
status: ok|error
command: <executed command>
exit_code: <exit code>
stdout: <standard output>
stderr: <standard error>
executed_at: <execution timestamp>
```

### 2. stop_daemon

Stop daemon process.

**Parameters:**

- `pid` (required): Daemon process ID (number)
- `entire_pg` (optional): Whether to stop the entire process group/process tree (default: `true`; on Windows this stops the tracked shell process and its child processes)

**Returns:**

```yaml
status: ok|error
pid: <daemon process id>
stopped_at: <stop timestamp>
```

**Errors:**

- `DAEMON_NOT_FOUND`: Daemon process doesn't exist
- `DAEMON_NOT_RUNNING`: Daemon process not running

### 3. get_daemon_output

Get daemon process output.

**Parameters:**

- `pid` (required): Daemon process ID (number)
- `stdout` (optional): Whether to include stdout output (default: `true`)
- `stderr` (optional): Whether to include stderr output (default: `true`)
- `wait_for_new_output` (optional): Whether to wait until a requested stdout/stderr stream receives new output before returning (default: `false`; providing `timeout_ms` implies `true`)
- `timeout_ms` (optional): Maximum milliseconds to wait for new output, capped at `86400000` (24h); on timeout, returns the current snapshot with a timeout notice; cannot be combined with `wait_for_new_output:false`

**Returns:**

```yaml
stdout: <stdout output when requested>
stderr: <stderr output when requested>
```

### 4. env_get

Get environment variable.

**Parameters:**

- `key` (required): Environment variable name

**Returns:**

- Set: returns the environment variable value directly
- Unset: returns `(unset)`

### 5. env_set

Set environment variable.

**Parameters:**

- `key` (required): Environment variable name
- `value` (required): Environment variable value

**Returns:**

```yaml
ok: <environment variable name>
prev: <previous value or (unset)>
next: <new value>
```

### 6. env_unset

Delete environment variable.

**Parameters:**

- `key` (required): Environment variable name

**Returns:**

```yaml
ok: <environment variable name>
prev: <previous value or (unset)>
next: (unset)
```

## Usage Examples

### Execute Shell Command

```typescript
shell_cmd({
  command: 'ls -la /home/user',
  timeoutSeconds: 10,
});
```

### Stop Daemon Process

```typescript
stop_daemon({
  pid: 12345,
});

// Explicitly stop the whole process group/process tree
stop_daemon({
  pid: 12345,
  entire_pg: true,
});
```

### Get Daemon Process Output

```typescript
get_daemon_output({
  pid: 12345,
});

get_daemon_output({
  pid: 12345,
  stdout: true,
  stderr: false,
});
```

### Get Environment Variable

```typescript
env_get({
  key: 'PATH',
});
```

### Set Environment Variable

```typescript
env_set({
  key: 'MY_VAR',
  value: 'hello',
});
```

### Delete Environment Variable

```typescript
env_unset({
  key: 'MY_VAR',
});
```

## YAML Output Contract

All tool outputs use YAML format for programmatic processing:

- `status`: Operation status, `ok` for success, `error` for failure
- Other fields: Additional information for specific operations

On error, returns:

```yaml
status: error
error_code: <error code>
message: <error message>
```
