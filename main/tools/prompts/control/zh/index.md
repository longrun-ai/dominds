# control 对话控制工具手册

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

control 是 Dominds 的**对话控制工具集**，用于管理对话状态、提醒和差遣牒：

- **提醒管理**：临时提醒，在当前对话中有效
- **差遣牒操作**：更新任务契约（goals/constraints/progress）
- **上下文维护**：管理对话过程中的临时状态

## 快速导航

| 主题                          | 描述                               |
| ----------------------------- | ---------------------------------- |
| [principles](./principles.md) | 核心概念、提醒生命周期、差遣牒结构 |
| [tools](./tools.md)           | 完整工具列表与接口契约             |
| [scenarios](./scenarios.md)   | 常见使用场景与示例（复制即用）     |
| [errors](./errors.md)         | 错误代码与解决方案                 |

## 状态

- 状态：已实现
- 主要实现文件：
  - 工具实现：`dominds/main/tools/ctrl.ts`
  - toolset 元信息：`dominds/main/tools/builtins.ts`、`dominds/main/tools/registry.ts`

## 核心概念

### 提醒（Reminder）

提醒是**会话级别**的临时信息，用于：

- 标记待处理事项
- 追踪当前任务进度
- 记录阻塞问题

### 差遣牒（Taskdoc）

差遣牒是**任务契约**，包含：

- **goals**：任务目标
- **constraints**：约束条件
- **progress**：进度状态
