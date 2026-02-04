# Q4H（Questions for Human / 向人类的诉请）——设计文档

英文版：[English](./q4h.md)

## 摘要

Q4H 是 Dominds 的运行时机制：在任何对话中通过向 `@human` 发起诉请（`!?@human ...`），把一个“必须由人类决策/澄清/确认”的问题抛给人类，并**合法暂停**对话推进，直到人类回应。

本文档指定一次 WebUI 增强：

1. 支持 **外链 deep link（URL）**：打开后可直达某个 Q4H 的“提问点”（call site，即对话中出现 `!?@human` 的位置），并在条件允许时让输入框进入“回答模式”。
2. 统一并增强 **call site 行为** 的 UI：同一处功能提供
   - **内链**（同一 tab 内导航）与
   - **外链**（新 tab/窗口打开）
     两个图标按钮。

## 目标

- 让人类可以打开一个 URL，并自动完成：
  - 切换到提问来源对话（必要时）
  - 切换到正确 course
  - 滚动并高亮提问点（call site）
  - 聚焦输入框
  - 若问题仍处于“待回答”，自动选中该问题，使输入框进入“回答模式”（下一次发送即回答该问题）
- 提供紧凑、可发现的 UI affordance：
  - 内链：在当前 WebUI tab 内完成上述导航
  - 外链：在新 tab/窗口打开 deep link 并完成上述导航
- 对既有持久化 Q4H 状态（`q4h.yaml`）保持兼容。

## 非目标

- 为 deep link 设计“可分享的权限模型”（鉴权独立处理，见 `docs/auth.md`）。
- 引入前端路由框架；WebUI 仍保持简单 SPA（无路由库）。
- 改写 Q4H 语义或挂起/恢复规则（本文档只覆盖导航 + UX）。

## 定义（使用者语境）

- **主线对话 / 支线对话**：对外术语，用于描述主要推进线程与临时工作线程。
- **提问点（call site）**：对话中发起诉请的具体位置；对 Q4H 即 `!?@human` 出现的位置。
- **回答模式（answer mode）**：输入框绑定到某个待处理 Q4H 问题，`Send` 的语义变为“回答该问题”。

## UX / 产品需求

### A. 内链导航（同一 tab）

从 Q4H 列表（底部面板）或其他 call-site affordance 出发：

- 若当前对话不是提问来源对话：切换到来源对话。
- 切换到目标 course。
- 滚动到提问点并短暂高亮。
- 聚焦输入框。
- 若该 Q4H 仍处于待处理状态：自动选中该问题进入回答模式。

### B. 外链导航（新 tab/窗口）

从“外链”图标按钮出发：

- 打开新 tab/窗口（deep link URL）。
- 新打开的 WebUI 应自动定位到提问点，并准备好输入框（待处理时进入回答模式）。

### C. 气泡标题中的 call-site 操作

当某条消息气泡存在“call site ↔ 结果/回应”的导航意义时（例如可从回应回跳到对应 call site）：

- 操作入口放到气泡标题区域（bubble title）并靠右对齐。
- 渲染两个图标按钮：
  - **内链**：在当前 WebUI tab 内导航（必要时切换对话 + 滚动定位）
  - **外链**：新 tab/窗口打开 deep link

## Deep Link 契约（WebUI）

### Query 参数约定

WebUI 通过 `window.location.search` 识别 deep link 参数。

通用参数：

- `dl`：deep link 类型（`q4h` | `callsite`）

#### `dl=q4h`（Q4H 提问点 deep link）

必需：

- `qid`：Q4H 问题 id（`q4h-...`）

推荐（可选，但能降低对全局 Q4H 状态到达时机的依赖）：

- `rootId`：根对话 id
- `selfId`：来源对话 id（主线或支线）
- `course`：course 编号（1-based）
- `msg`：messageIndex（仅用于 best-effort 回退定位）
- `callId`：当该 Q4H 来源于 `!?@human` 诉请块时，对应的 tellask `callId`（更精确的定位方式）

行为：

- WebUI 切换到来源对话 + course，并定位/高亮提问点。
- 若该 Q4H 仍待处理：输入框选中 `qid`（回答模式）并聚焦。
- 若该 Q4H 已不再待处理（已回答/已清理）：仍定位/高亮提问点，但**不进入回答模式**（不选中问题）；可提示“已不再待处理”。

#### `dl=callsite`（通用 tellask call site deep link）

必需：

- `rootId`
- `selfId`
- `course`
- `callId`

行为：

- WebUI 切换到目标对话 + course，并滚动到 `data-call-id=callId` 对应的 calling section。
- 输入框聚焦（普通消息模式）。

#### `dl=genseq`（生成气泡 deep link）

必需：

- `rootId`
- `selfId`
- `course`
- `genseq`

行为：

- WebUI 切换到目标对话 + course，并滚动定位到 `data-seq=genseq` 的生成气泡（generation bubble）。
- 气泡会短暂高亮，以便用户确认已定位。

### URL 示例

```text
/?dl=q4h&qid=q4h-abc123&rootId=R1&selfId=S2&course=3&callId=call-xyz&msg=12

/?dl=callsite&rootId=R1&selfId=R1&course=1&callId=call-xyz
```

说明：

- 若采用 URL 鉴权（`?auth=...`），deep link 参数与 `auth` 共存于 query string。
- 若鉴权来自 localStorage，通常不应把 `auth` 写进可分享 URL，以避免密钥泄露。

## 数据模型 / 持久化

### 每对话 `q4h.yaml`

既有 Q4H 持久化字段：

- `id`, `tellaskHead`, `bodyContent`, `askedAt`
- `callSiteRef: { course, messageIndex }`

增强：

- 为由 `!?@human` 诉请块产生的 Q4H 问题增加可选字段 `callId?: string`。
  - 使前端可通过 `data-call-id` 精确滚动定位。
  - 对于非诉请块产生的系统型 Q4H，允许没有 `callId`。

向后兼容：

- 旧版 `q4h.yaml`（无 `callId`）仍合法。

## 前端落地要点

- `dominds-q4h-panel`：
  - 保留内链“去提问点”。
  - 增加外链图标按钮：打开 `dl=q4h` deep link（新 tab/窗口）。
- `dominds-app`：
  - 启动时解析 deep link，并保存“待执行导航意图”。
  - 在 dialogs / Q4H state 到齐后尝试执行意图。
  - Q4H 待处理时：选中问题并聚焦输入框进入回答模式。
- `dominds-dialog-container`：
  - 支持事件驱动的滚动定位（必要时延迟重试）：
    - `scroll-to-call-site`（course + messageIndex/callId）
    - `scroll-to-call-id`（course + callId）
  - 在气泡标题中提供内链/外链两个图标按钮。

## 边界情况

- deep link 指向的对话在列表中不可见（被删除或未加载）：
  - toast 提示，避免崩溃。
- deep link 指向的 Q4H 已不再待处理：
  - 仍定位/高亮提问点；不进入回答模式。
- course replay 的时序：
  - 滚动请求可能先于 DOM 渲染到达；对话容器需要 best-effort 重试/延后应用。

## 测试清单

- Q4H 面板：
  - “去提问点”可滚动并高亮提问点。
  - 外链按钮可打开新 tab 并落在同一提问点。
- deep link：
  - 待处理 Q4H：自动选中问题并聚焦输入框（回答模式）。
  - 已处理 Q4H：能定位但不选中问题；输入框仍可用。
- 队友回应气泡（teammate response bubble）：
  - 内链图标：同 tab 内定位 call site。
  - 外链图标：新 tab 打开并定位到同一 call site。
