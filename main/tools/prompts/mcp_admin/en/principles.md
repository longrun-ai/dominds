# mcp_admin Principles and Core Concepts

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

### 1. MCP Connection Management

MCP (Model Context Protocol) is a protocol for connecting to external services.

**Functions:**

- Start MCP service
- Restart MCP connection
- Release MCP resources

### 2. MCP Lease

MCP uses a lease mechanism to manage runtime resources such as HTTP connections and stdio processes. Lease ownership is about who holds a runtime instance; it does not define global MCP tool registration or visibility.

**Lifecycle:**

- **Acquire lease**: Establish or hold a runtime instance
- **Hold lease**: Keep using that runtime instance
- **Release lease**: Stop/disconnect and release resources

### 3. Environment Variables

Shared with os toolset for environment variable functionality.

## Tool Overview

| Tool        | Function                 |
| ----------- | ------------------------ |
| mcp_restart | Restart MCP service      |
| mcp_release | Release MCP lease        |
| env_get     | Get environment variable |

## Best Practices

### 1. MCP Connection Management

- **Release timely**: Release lease when MCP is no longer used
- **Monitor status**: Regularly check MCP connection status
- **Error handling**: Handle connection failures

### 2. Resource Management

- **Avoid leaks**: Ensure all acquired leases are released
- **Retry mechanism**: Implement retry logic for temporary failures

## Limitations and Notes

1. MCP connections may require specific configuration
2. Leases have validity period limits
3. Some MCP services may require authentication
