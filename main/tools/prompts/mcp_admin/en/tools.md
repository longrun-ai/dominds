# mcp_admin Tool Reference

## Template (Tools)

### How to Read

- The schema-generated "Tool Contract (Schema)" section is canonical for parameters/returns.

### Per-Tool Fields (order)

1. Purpose
2. Call Signature
3. Parameters (refer to schema)
4. Preconditions
5. Success Signal
6. Failure/Errors
7. Copy-Ready Example
8. Common Misuse

## Tool List

### 1. mcp_restart

Enable and rebuild an MCP service using the current `.minds/mcp.yaml` config. If the target server is currently `enabled: false`, this writes `enabled: true` before trying to start it. After a successful restart, Dominds replaces the global MCP runtime/tool registration and clears all dialog leases held on the old runtime. If restart fails, the old runtime/leases are kept so troubleshooting does not tear down a still-working connection.

**Parameters:**

- `serverId` (required): MCP service identifier

**Returns:**

```yaml
ok: restarted <MCP service identifier>
```

**Errors:**

- `MCP_NOT_FOUND`: MCP service doesn't exist

### 2. mcp_release

Release the current dialog's leased MCP runtime instance for a server. This stops/releases the underlying HTTP connection or stdio process, but does not define global tool registration/visibility.

**Parameters:**

- `serverId` (required): MCP service identifier

**Returns:**

```yaml
ok: released <MCP service identifier> for dialog <dialog identifier>
```

If the current dialog has no releasable lease, returns:

```yaml
ok: no active lease for <MCP service identifier> (or server is truely-stateless)
```

**Errors:**

- `MCP_NOT_FOUND`: MCP service doesn't exist
- `MCP_NOT_RUNNING`: MCP service not running

### 3. mcp_disable

Disable an MCP service and write `enabled: false` for that server in `.minds/mcp.yaml`. This does not wait for a replacement service to become available: it unconditionally clears the loaded runtime/leases. The disabled server remains visible as a zero-tool MCP toolset, with its manual clearly marked disabled.

**Parameters:**

- `serverId` (required): MCP service identifier

**Returns:**

```yaml
ok: disabled <MCP service identifier> and set enabled=false
```

### 4. env_get

Get environment variable (shared with os toolset).

**Parameters:**

- `key` (required): Environment variable name

**Returns:**

- Set: returns the environment variable value directly
- Unset: returns `(unset)`

### 5. env_set

Set an environment variable in the Dominds server process (shared with os toolset).

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

Delete an environment variable from the Dominds server process (shared with os toolset).

**Parameters:**

- `key` (required): Environment variable name

**Returns:**

```yaml
ok: <environment variable name>
prev: <previous value or (unset)>
next: (unset)
```

## Usage Examples

### Restart MCP Service

```typescript
mcp_restart({
  serverId: 'browser',
});
```

### Release MCP Lease

```typescript
mcp_release({
  serverId: 'browser',
});
```

### Disable MCP Service

```typescript
mcp_disable({
  serverId: 'browser',
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
  key: 'MCP_AUTH_TOKEN',
  value: 'local-token',
});
```

### Delete Environment Variable

```typescript
env_unset({
  key: 'MCP_AUTH_TOKEN',
});
```

## Output Contract

These tools use the short text return formats described in their own sections:

- Success: starts with `ok:`
- Failure: starts with `error:`

On error, returns:

```yaml
error: <error message>
```
