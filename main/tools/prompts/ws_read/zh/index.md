# ws_read 运行时工作区只读工具手册

## 概述

ws_read 是 Dominds 的**运行时工作区只读工具集**，用于读取和搜索运行时工作区（rtws）中的文件和内容：

- **目录查看**：列出目录内容
- **文件读取**：读取文件内容
- **内容搜索**：使用 ripgrep 搜索文件和内容

## 快速导航

| Topic                         | 描述                           |
| ----------------------------- | ------------------------------ |
| [principles](./principles.md) | 核心概念、只读原则、最佳实践   |
| [tools](./tools.md)           | 完整工具列表与接口契约         |
| [scenarios](./scenarios.md)   | 常见使用场景与示例（复制即用） |
| [errors](./errors.md)         | 错误代码与解决方案             |

## 状态

- 状态：已实现
- 主要实现文件：
  - 工具实现：`dominds/main/tools/fs.ts`、`dominds/main/tools/ripgrep.ts`
  - toolset 元信息：`dominds/main/tools/builtins.ts`、`dominds/main/tools/registry.ts`

## 与 ws_mod 的区别

ws_read 是 ws_mod 的只读子集，仅提供读取功能，不提供写入功能。

| 功能 | ws_read | ws_mod |
| ---- | ------- | ------ |
| 读取 | ✓       | ✓      |
| 写入 | ✗       | ✓      |
| 删除 | ✗       | ✓      |
| 移动 | ✗       | ✓      |
