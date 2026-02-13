# codex_style_tools Codex 风格工具手册

## 模板（概述）
### 一句话定位
- <该工具集用途，一句话描述>
### 工具清单
- <列出核心工具，或指向 Tools/Schema 章节>
### 30 秒上手
1) <调用 ...>
2) <观察 ...>
3) <下一步 ...>
### 导航
- principles / tools / scenarios / errors
### 与其他工具集的边界
- <何时用本工具集、何时用相邻工具集>

codex_style_tools 是 Dominds 的 **Codex 风格工具集**，提供与 Codex 兼容的工具：

- **应用补丁**：应用代码补丁
- **只读 Shell**：安全执行只读命令
- **更新计划**：更新任务计划

## 快速导航

| 主题                          | 描述                             |
| ----------------------------- | -------------------------------- |
| [principles](./principles.md) | 核心概念、Codex 兼容性、最佳实践 |
| [tools](./tools.md)           | 完整工具列表与接口契约           |
| [scenarios](./scenarios.md)   | 常见使用场景与示例（复制即用）   |
| [errors](./errors.md)         | 错误代码与解决方案               |

## 状态

- 状态：已实现
- 主要实现文件：
  - 工具实现：`dominds/main/tools/codex-style.ts`
  - toolset 元信息：`dominds/main/tools/builtins.ts`、`dominds/main/tools/registry.ts`

## 设计目标

Codex 风格工具集的设计目标是与 Codex provider 兼容，提供一致的工具调用体验。

## 与其他工具的区别

| 工具集            | 特点                 |
| ----------------- | -------------------- |
| codex_style_tools | Codex 兼容，只读优先 |
| os                | 完整 Shell 支持      |
| ws_mod            | 完整文件操作         |
