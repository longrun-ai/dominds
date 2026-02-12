# mcp_admin Usage Scenarios

## Scenario 1: Restart MCP Service

### Scenario Description

When MCP service has issues or needs to refresh the connection, restart the MCP service.

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

## Scenario 4: MCP Connection Failure Handling

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

## Scenario 5: Resource Cleanup

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
