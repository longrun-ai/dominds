# mcp_admin 工具参考

## 模板（工具）

### 阅读方式

- 工具函数定义是参数/返回的权威来源；本手册只补充使用指导。

### 单工具字段顺序

1. 用途
2. 调用签名
3. 参数（仅在需要补充用法指导时摘要说明）
4. 前置条件
5. 成功信号
6. 失败/错误
7. 可直接执行示例
8. 常见误用

## 工具列表

### 1. mcp_restart

按当前 `.minds/mcp.yaml` 配置启用并重建 MCP 服务。如果目标 server 当前是 `enabled: false`，会先写回 `enabled: true` 再尝试启动。重启成功后会替换全局 MCP runtime/tool 注册，并清理旧 runtime 上所有对话持有的 lease；重启失败时保留旧 runtime/lease，避免排障过程中把仍可用的连接拆掉。

**参数：**

- `serverId`（必需）：MCP 服务标识符

**返回：**

```yaml
ok: restarted <MCP 服务标识符>
```

**错误：**

- `MCP_NOT_FOUND`：MCP 服务不存在

### 2. mcp_release

释放当前对话为某个 server 持有的 MCP 运行时实例。它会停止/释放底层 HTTP 连接或 stdio 进程，但不决定工具的全局注册或可见性。

**参数：**

- `serverId`（必需）：MCP 服务标识符

**返回：**

```yaml
ok: released <MCP 服务标识符> for dialog <对话标识符>
```

如果当前对话没有可释放的 lease，返回：

```yaml
ok: no active lease for <MCP 服务标识符> (or server is truely-stateless)
```

**错误：**

- `MCP_NOT_FOUND`：MCP 服务不存在
- `MCP_NOT_RUNNING`：MCP 服务未运行

### 3. mcp_disable

禁用 MCP 服务并将 `.minds/mcp.yaml` 中对应 server 写为 `enabled: false`。该操作不等待新服务可用：会无条件清理已加载 runtime/lease。禁用后的 server 仍作为 0 工具 MCP toolset 可见，并在手册中明确标记为 disabled。

**参数：**

- `serverId`（必需）：MCP 服务标识符

**返回：**

```yaml
ok: disabled <MCP 服务标识符> and set enabled=false
```

### 4. env_get

获取环境变量（与 os 工具集共享）。

**参数：**

- `key`（必需）：环境变量名称

**返回：**

- 已设置：直接返回环境变量值
- 未设置：返回 `(unset)`

### 5. env_set

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

### 6. env_unset

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

### 禁用 MCP 服务

```typescript
mcp_disable({
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

## 输出契约

这些工具使用各自工具小节描述的简短文本返回格式：

- 成功：以 `ok:` 开头
- 失败：以 `error:` 开头

错误时返回：

```yaml
error: <错误消息>
```
