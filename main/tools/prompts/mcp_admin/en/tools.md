# mcp_admin Tool Reference

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

Release MCP lease.

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

```yaml
status: ok|error
key: <environment variable name>
value: <environment variable value>
retrieved_at: <retrieval timestamp>
```

**Errors:**

- `ENV_NOT_FOUND`: Environment variable doesn't exist

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
