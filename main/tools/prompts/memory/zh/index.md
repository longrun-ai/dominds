# memory 个人记忆工具手册

## 概述

memory 是 Dominds 的**个人记忆工具集**，用于管理智能体的私有记忆：

- **私有性**：记忆仅对当前智能体可见，不会共享给其他成员
- **持久化**：记忆会持久化到磁盘，在对话重启后仍然保留
- **结构化**：支持按路径组织记忆，便于分类和检索

## 快速导航

| Topic                         | 描述                             |
| ----------------------------- | -------------------------------- |
| [principles](./principles.md) | 核心概念、记忆生命周期、最佳实践 |
| [tools](./tools.md)           | 完整工具列表与接口契约           |
| [scenarios](./scenarios.md)   | 常见使用场景与示例（复制即用）   |
| [errors](./errors.md)         | 错误代码与解决方案               |

## 状态

- 状态：已实现
- 主要实现文件：
  - 工具实现：`dominds/main/tools/mem.ts`
  - toolset 元信息：`dominds/main/tools/builtins.ts`、`dominds/main/tools/registry.ts`
