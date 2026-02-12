# ws_mod 文本编辑工具手册

## 概述

ws_mod 是 Dominds 的文本编辑工具集，采用 **prepare-first + single apply** 架构：

- **prepare-first**：所有增量编辑先规划（输出可审阅 diff + evidence + hunk_id）
- **single apply**：所有计划类编辑仅通过 `apply_file_modification` 落盘
- **移除旧工具**：`append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace` 已彻底删除

## 快速导航

| Topic                         | 描述                                      |
| ----------------------------- | ----------------------------------------- |
| [principles](./principles.md) | 核心概念、工作流、并发约束、hunk 生命周期 |
| [tools](./tools.md)           | 完整工具列表与接口契约                    |
| [scenarios](./scenarios.md)   | 常见使用场景与示例（复制即用）            |
| [errors](./errors.md)         | 错误代码与解决方案                        |

## 状态

- 状态：已实现（breaking change：无旧工具兼容层）
- 主要实现文件：
  - 工具实现：`dominds/main/tools/txt.ts`
  - toolset 元信息：`dominds/main/tools/builtins.ts`、`dominds/main/tools/registry.ts`
