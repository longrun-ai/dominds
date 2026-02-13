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

当 MCP 服务出现故障或需要刷新连接时，重启 MCP 服务。

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

## 场景 4：MCP 连接故障处理

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

## 场景 5：资源清理

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
