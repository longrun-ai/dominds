# control 对话控制工具手册

## 模板（概述）

### 一句话定位

- <该工具集用途，一句话描述>

### 工具清单

- <列出核心工具，或指向 Tools/Schema 章节>

### 30 秒上手

1. <调用 ...>
2. <观察 ...>
3. <下一步 ...>

### 导航

- principles / tools / scenarios / errors

### 与其他工具集的边界

- <何时用本工具集、何时用相邻工具集>

control 是 Dominds 的**对话控制工具集**，用于管理对话状态、提醒、差遣牒，以及跨对话回复收口语义：

- **提醒管理**：提醒分 `dialog` / `personal` 两个 scope；默认保持对话内工作集，只有职责相关且在所有由你主理的后续对话里也应继续看到的提醒才用 `personal`
- **差遣牒操作**：追加、替换或删除任务契约章节（goals/constraints/progress）；其中 `progress` 是全队共享、准实时、可扫读的任务公告牌
- **上下文维护**：在不丢关键恢复线索的前提下降低认知负载
- **回复路由**：在支线/回问语境下，区分 `tellaskBack`、`replyTellask*` 与普通文本的职责边界

## 快速导航

| 主题                          | 描述                                                   |
| ----------------------------- | ------------------------------------------------------ |
| [principles](./principles.md) | 核心概念、提醒生命周期、差遣牒结构、reply 路由心智模型 |
| [tools](./tools.md)           | 完整工具列表、最小接口契约、reply 速查表               |
| [scenarios](./scenarios.md)   | 常见使用场景与示例（复制即用）                         |
| [errors](./errors.md)         | 错误代码与解决方案                                     |

## 状态

- 状态：已实现
- 主要实现文件：
  - 工具实现：`dominds/main/tools/ctrl.ts`
  - toolset 元信息：`dominds/main/tools/builtins.ts`、`dominds/main/tools/registry.ts`

## 核心概念

### 提醒（Reminder）

提醒是临时工作集，用于：

- 标记待处理事项
- 追踪当前下一步/阻塞
- 记录阻塞问题
- 在 `clear_mind` 前承载接续包；若当前程已被系统置于吃紧/告急处置态，可先带多条粗略提醒项过桥

scope 规则：

- `dialog`：当前对话工作集
- `personal`：在所有由你主理的后续对话里也应继续看到的职责相关提醒

### 差遣牒

差遣牒是**任务契约**，包含：

- **goals**：任务目标
- **constraints**：约束条件
- **progress**：面向全队同步的准实时任务公告牌 / 当前有效状态快照
