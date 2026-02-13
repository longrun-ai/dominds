# os Principles and Core Concepts

## Template (Principles)

### Design Goals

- <Goal 1>
- <Goal 2>

### Contract Principles

- <Input/Output contract rules>

### Safety & Boundaries

- <Access constraints / guardrails>

### Failure & Recovery

- <What to do when a call fails>

### Glossary

- <Toolset-specific terms>

## Core Concepts

### 1. Shell Command Execution

Shell command execution allows the agent to run system commands to complete various tasks.

**Characteristics:**

- Synchronous execution: Returns output after command completes
- Error handling: Returns exit code and error information
- Output capture: Captures stdout and stderr

### 2. Daemon Process Management

Daemon processes are processes that run continuously in the background.

**Operations:**

- Start daemon process
- Stop daemon process
- Get daemon process output

### 3. Environment Variable Management

Environment variables are system variables that affect process behavior.

**Operations:**

- Read environment variable
- Set environment variable
- Delete environment variable

## Tool Overview

| Tool              | Function                    |
| ----------------- | --------------------------- |
| shell_cmd         | Execute Shell command       |
| stop_daemon       | Stop daemon process         |
| get_daemon_output | Get daemon process output   |
| env_get           | Get environment variable    |
| env_set           | Set environment variable    |
| env_unset         | Delete environment variable |

## Best Practices

### 1. Shell Command Security

- **Validate input**: Use parameterized commands to avoid injection
- **Use absolute paths**: Avoid relative path ambiguity
- **Check permissions**: Ensure sufficient permissions to execute commands

### 2. Process Management

- **Record PID**: Save process ID for management
- **Graceful stop**: Use SIGTERM instead of SIGKILL
- **Monitor output**: Regularly check daemon process output

### 3. Environment Variables

- **Sensitive information**: Don't store passwords in environment variables
- **Prefix convention**: Use project-specific prefixes to avoid conflicts
- **Document**: Document important environment variables' purposes

## Limitations and Notes

1. Shell command execution may have security risks, please operate with caution
2. Some system commands may require specific permissions
3. Environment variable modifications are only effective for the current process
