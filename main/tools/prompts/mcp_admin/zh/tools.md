# mcp_admin 工具参考

## 工具列表

### 1. mcp_restart

重启 MCP 服务。

**参数：**

- `serverId`（必需）：MCP 服务标识符

**返回：**

```yaml
status: ok|error
serverId: <MCP 服务标识符>
restarted_at: <重启时间戳>
```

**错误：**

- `MCP_NOT_FOUND`：MCP 服务不存在

### 2. mcp_release

释放 MCP 租约。

**参数：**

- `serverId`（必需）：MCP 服务标识符

**返回：**

```yaml
status: ok|error
serverId: <MCP 服务标识符>
released_at: <释放时间戳>
```

**错误：**

- `MCP_NOT_FOUND`：MCP 服务不存在
- `MCP_NOT_RUNNING`：MCP 服务未运行

### 3. env_get

获取环境变量（与 os 工具集共享）。

**参数：**

- `key`（必需）：环境变量名称

**返回：**

```yaml
status: ok|error
key: <环境变量名称>
value: <环境变量值>
retrieved_at: <获取时间戳>
```

**错误：**

- `ENV_NOT_FOUND`：环境变量不存在

## 使用示例

### 重启 MCP 服务

```typescript
mcp_restart({
  serverId: 'browser',
});
```

### 释放 MCP 租约

```typescript
mcp_release({
  serverId: 'browser',
});
```

### 获取环境变量

```typescript
env_get({
  key: 'PATH',
});
```

## YAML 输出契约

所有工具的输出都使用 YAML 格式，便于程序化处理：

- `status`：操作状态，`ok` 表示成功，`error` 表示失败
- 其他字段：具体操作的附加信息

错误时返回：

```yaml
status: error
error_code: <错误代码>
message: <错误消息>
```
