# ws_mod 文本编辑工具手册

## 模板（概述）

### 一句话定位

- <该工具集用途，一句话描述>

### 工具清单

- <列出核心工具，或指向工具章节>

### 30 秒上手

1. <调用 ...>
2. <观察 ...>
3. <下一步 ...>

### 导航

- principles / tools / scenarios / errors

### 与其他工具集的边界

- <何时用本工具集、何时用相邻工具集>

ws_mod 是 Dominds 的文本编辑工具集，采用 **direct edit + pad source** 架构：

- **direct range edit**：精确行号范围优先用 `file_range_edit` 一步写入
- **direct single-block edit**：末尾追加、锚点插入、锚点块替换用 `file_append`、`file_insert_*`、`file_block_replace`
- **preview as display option**：需要审阅时显式 `preview/show_diff`
- **移除旧工具**：`append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace` 已彻底删除

## 快速导航

| 主题                          | 描述                                 |
| ----------------------------- | ------------------------------------ |
| [principles](./principles.md) | 核心概念、工作流、并发约束、预览行为 |
| [tools](./tools.md)           | 使用指导、编辑边界与流程注意         |
| [scenarios](./scenarios.md)   | 常见使用场景与示例（复制即用）       |
| [errors](./errors.md)         | 错误代码与解决方案                   |

## 状态

- 状态：已实现（breaking change：无旧工具兼容层）
- 主要实现文件：
  - 工具实现：`dominds/main/tools/txt.ts`
  - toolset 元信息：`dominds/main/tools/builtins.ts`、`dominds/main/tools/registry.ts`
