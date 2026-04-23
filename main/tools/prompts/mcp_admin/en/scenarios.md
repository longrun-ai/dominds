# mcp_admin Usage Scenarios

## Template (Scenarios)

### Scenario Format

- Goal
- Preconditions
- Steps
- Expected Signal
- Failure Branch
- Completion Criteria

## Scenario 1: Restart MCP Service

### Scenario Description

When an MCP service has issues, needs to refresh the connection, or is currently disabled with `enabled: false`, enable and restart the MCP service.

`mcp_restart` writes `enabled: true` when the server is currently `enabled: false`, then tries to start it. After it succeeds, it clears every dialog lease on the old runtime; you do not need to call `mcp_release` first.

### Example

```typescript
mcp_restart({
  serverId: 'browser',
});
```

## Scenario 2: Release MCP Lease

### Scenario Description

When MCP service is no longer needed, release the lease to free resources.

### Example

```typescript
mcp_release({
  serverId: 'browser',
});
```

## Scenario 3: Environment Variable Check

### Scenario Description

Check MCP-related environment variables.

### Example

```typescript
env_get({
  key: 'MCP_CONFIG_PATH',
});
```

## Scenario 4: Disable MCP Service

### Scenario Description

When an MCP server should stop providing tools, or troubleshooting needs to force it offline, disable that server and write `enabled: false`. A disabled server is still exposed as a zero-tool toolset, and its manual clearly marks it as disabled.

### Example

```typescript
mcp_disable({
  serverId: 'filesystem',
});
```

## Scenario 5: MCP Connection Failure Handling

### Scenario Description

When MCP connection fails, try to restart and recover.

### Example

```typescript
// Detected connection failure
// Try to restart MCP service
mcp_restart({
  serverId: 'filesystem',
});
```

## Scenario 6: Resource Cleanup

### Scenario Description

Clean up MCP resources after completing tasks.

### Example

```typescript
// Task completed
// Release MCP lease
mcp_release({
  serverId: 'browser',
});
```
