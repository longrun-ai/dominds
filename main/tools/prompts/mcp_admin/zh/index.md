# mcp_admin MCP 管理工具手册

## 概述

mcp_admin 是 Dominds 的 **MCP 管理工具集**，用于管理 MCP（Model Context Protocol）连接和资源：

- **MCP 重启**：重启 MCP 服务
- **MCP 释放**：释放 MCP 租约
- **环境变量**：读取环境变量

## 快速导航

| Topic                         | 描述                           |
| ----------------------------- | ------------------------------ |
| [principles](./principles.md) | 核心概念、连接管理、最佳实践   |
| [tools](./tools.md)           | 完整工具列表与接口契约         |
| [scenarios](./scenarios.md)   | 常见使用场景与示例（复制即用） |
| [errors](./errors.md)         | 错误代码与解决方案             |

## 状态

- 状态：已实现
- 主要实现文件：
  - 工具实现：`dominds/main/tools/mcp-admin.ts`
  - toolset 元信息：`dominds/main/tools/builtins.ts`、`dominds/main/tools/registry.ts`

## 核心概念

### MCP（Model Context Protocol）

MCP 是用于连接外部服务和工具的协议，允许智能体调用外部工具和服务。

### MCP 租约

MCP 连接使用租约机制管理，确保资源合理分配和释放。
