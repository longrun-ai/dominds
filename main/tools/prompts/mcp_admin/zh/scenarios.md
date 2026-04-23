# mcp_admin 使用场景

## 模板（场景）

### 场景格式

- 目标
- 前置条件
- 步骤
- 期望信号
- 失败分支处理
- 完成判据

## 场景 1：重启 MCP 服务

### 场景描述

当 MCP 服务出现故障、需要刷新连接，或当前被 `enabled: false` 禁用时，启用并重启 MCP 服务。

`mcp_restart` 会把 `enabled: false` 写回 `enabled: true` 后尝试启动；成功后会清理旧 runtime 的全部对话 lease，不需要先 `mcp_release`。

### 示例

```typescript
mcp_restart({
  serverId: 'browser',
});
```

## 场景 2：释放 MCP 租约

### 场景描述

不再使用 MCP 服务时，释放租约以释放资源。

### 示例

```typescript
mcp_release({
  serverId: 'browser',
});
```

## 场景 3：环境变量检查

### 场景描述

检查 MCP 相关的环境变量。

### 示例

```typescript
env_get({
  key: 'MCP_CONFIG_PATH',
});
```

## 场景 4：禁用 MCP 服务

### 场景描述

当某个 MCP server 不应继续提供工具，或排障时需要强制下线它，禁用该 server 并写入 `enabled: false`。禁用后的 server 仍会作为 0 工具 toolset 暴露，手册会明确标记已禁用。

### 示例

```typescript
mcp_disable({
  serverId: 'filesystem',
});
```

## 场景 5：MCP 连接故障处理

### 场景描述

当 MCP 连接出现故障时，尝试重启恢复。

### 示例

```typescript
// 检测到连接故障
// 尝试重启 MCP 服务
mcp_restart({
  serverId: 'filesystem',
});
```

## 场景 6：资源清理

### 场景描述

完成任务后清理 MCP 资源。

### 示例

```typescript
// 任务完成
// 释放 MCP 租约
mcp_release({
  serverId: 'browser',
});
```
