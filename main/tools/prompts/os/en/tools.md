# os Tool Reference

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

### 1. shell_cmd

Execute Shell command.

**Parameters:**

- `command` (required): Command to execute
- `shell` (optional): Shell to use for execution (default: `bash`)
- `bufferSize` (optional): Maximum number of lines to keep in scrolling buffer
- `timeoutSeconds` (optional): Timeout in seconds before switching to daemon tracking

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

**Returns:**

```yaml
status: ok|error
pid: <daemon process id>
output: <process output>
retrieved_at: <retrieval timestamp>
```

### 4. env_get

Get environment variable.

**Parameters:**

- `key` (required): Environment variable name

**Returns:**

```yaml
status: ok|error
key: <environment variable name>
value: <environment variable value>
retrieved_at: <retrieval timestamp>
```

**Errors:**

- `ENV_NOT_FOUND`: Environment variable doesn't exist

### 5. env_set

Set environment variable.

**Parameters:**

- `key` (required): Environment variable name
- `value` (required): Environment variable value

**Returns:**

```yaml
status: ok|error
key: <environment variable name>
value: <environment variable value>
set_at: <set timestamp>
```

### 6. env_unset

Delete environment variable.

**Parameters:**

- `key` (required): Environment variable name

**Returns:**

```yaml
status: ok|error
key: <environment variable name>
unset_at: <deletion timestamp>
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
```

### Get Daemon Process Output

```typescript
get_daemon_output({
  pid: 12345,
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
