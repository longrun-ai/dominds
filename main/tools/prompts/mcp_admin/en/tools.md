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

Restart MCP service.

**Parameters:**

- `serverId` (required): MCP service identifier

**Returns:**

```yaml
status: ok|error
serverId: <MCP service identifier>
restarted_at: <restart timestamp>
```

**Errors:**

- `MCP_NOT_FOUND`: MCP service doesn't exist

### 2. mcp_release

Release the current dialog's leased MCP runtime instance for a server. This stops/releases the underlying HTTP connection or stdio process, but does not define global tool registration/visibility.

**Parameters:**

- `serverId` (required): MCP service identifier

**Returns:**

```yaml
status: ok|error
serverId: <MCP service identifier>
released_at: <release timestamp>
```

**Errors:**

- `MCP_NOT_FOUND`: MCP service doesn't exist
- `MCP_NOT_RUNNING`: MCP service not running

### 3. env_get

Get environment variable (shared with os toolset).

**Parameters:**

- `key` (required): Environment variable name

**Returns:**

- Set: returns the environment variable value directly
- Unset: returns `(unset)`

### 4. env_set

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

### 5. env_unset

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

## YAML Output Contract

`mcp_restart` / `mcp_release` use YAML output with `status`; environment variable tools use the return format described in their own sections:

- `status`: Operation status, `ok` for success, `error` for failure
- Other fields: Additional information for specific operations

On error, returns:

```yaml
status: error
error_code: <error code>
message: <error message>
```
