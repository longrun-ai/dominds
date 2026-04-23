# mcp_admin 工具参考

## 模板（工具）

### 阅读方式

- "工具契约（Schema）" 为参数/返回的权威来源。

### 单工具字段顺序

1. 用途
2. 调用签名
3. 参数（参见 schema）
4. 前置条件
5. 成功信号
6. 失败/错误
7. 可直接执行示例
8. 常见误用

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

释放当前对话为某个 server 持有的 MCP 运行时实例。它会停止/释放底层 HTTP 连接或 stdio 进程，但不决定工具的全局注册或可见性。

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

- 已设置：直接返回环境变量值
- 未设置：返回 `(unset)`

### 4. env_set

设置 Dominds 服务进程的环境变量（与 os 工具集共享）。

**参数：**

- `key`（必需）：环境变量名称
- `value`（必需）：环境变量值

**返回：**

```yaml
ok: <环境变量名称>
prev: <之前的值或 (unset)>
next: <新的值>
```

### 5. env_unset

删除 Dominds 服务进程的环境变量（与 os 工具集共享）。

**参数：**

- `key`（必需）：环境变量名称

**返回：**

```yaml
ok: <环境变量名称>
prev: <之前的值或 (unset)>
next: (unset)
```

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

### 设置环境变量

```typescript
env_set({
  key: 'MCP_AUTH_TOKEN',
  value: 'local-token',
});
```

### 删除环境变量

```typescript
env_unset({
  key: 'MCP_AUTH_TOKEN',
});
```

## YAML 输出契约

`mcp_restart` / `mcp_release` 使用带 `status` 的 YAML 输出；环境变量工具使用各自工具小节描述的返回格式：

- `status`：操作状态，`ok` 表示成功，`error` 表示失败
- 其他字段：具体操作的附加信息

错误时返回：

```yaml
status: error
error_code: <错误代码>
message: <错误消息>
```
