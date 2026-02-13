# os Usage Scenarios

## Template (Scenarios)
### Scenario Format
- Goal
- Preconditions
- Steps
- Expected Signal
- Failure Branch
- Completion Criteria

## Scenario 1: File Operations

### Scenario Description

Use Shell commands for file operations.

### Example

```typescript
// List directory contents
shell_cmd({
  command: 'ls -la',
});

// Create directory
shell_cmd({
  command: 'mkdir -p /path/to/directory',
});

// View file contents
shell_cmd({
  command: 'cat /path/to/file',
});
```

## Scenario 2: Git Operations

### Scenario Description

Use Git for version control operations.

### Example

```typescript
// View Git status
shell_cmd({
  command: 'git status',
});

// Create commit
shell_cmd({
  command: "git add -A && git commit -m 'Update docs'",
});

// View commit history
shell_cmd({
  command: 'git log --oneline -10',
});
```

## Scenario 3: Process Management

### Scenario Description

Manage long-running processes.

### Example

```typescript
// View running processes
shell_cmd({
  command: 'ps aux | grep node',
});

// Stop specific process
shell_cmd({
  command: 'kill -TERM <pid>',
});
```

## Scenario 4: Environment Variable Operations

### Scenario Description

Manage environment variables.

### Example

```typescript
// View all environment variables
env_get({
  key: 'PATH',
});

// Set project environment variable
env_set({
  key: 'NODE_ENV',
  value: 'production',
});

// Delete environment variable
env_unset({
  key: 'DEBUG',
});
```

## Scenario 5: Build and Test

### Scenario Description

Execute project build and test.

### Example

```typescript
// Install dependencies
shell_cmd({
  command: 'pnpm install',
});

// Run build
shell_cmd({
  command: 'pnpm build',
});

// Run tests
shell_cmd({
  command: 'pnpm test',
});
```

## Scenario 6: Daemon Process Management

### Scenario Description

Start and manage daemon processes.

### Example

```typescript
// Note: Daemon process management requires specific interface
// Get daemon process status
get_daemon_output({
  pid: 12345,
});

// Stop daemon process
stop_daemon({
  pid: 12345,
});
```

## Scenario 7: System Information

### Scenario Description

Get system information.

### Example

```typescript
// View system version
shell_cmd({
  command: 'uname -a',
});

// View disk space
shell_cmd({
  command: 'df -h',
});

// View memory usage
shell_cmd({
  command: 'free -m',
});
```
