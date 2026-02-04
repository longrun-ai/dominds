# 上下文健康监控器

英文版：[English](./context-health.md)

本文档为 Dominds 指定了一个**上下文健康监控器**特性：一个常驻的小型信号，帮助智能体（和用户）在对话的提示词/上下文相对于模型的上下文窗口变得过大时避免性能下降。

## 当前代码现状（截至 2026-01-28）

Dominds 已具备以下功能：

- LLM 包装器的**提供商使用统计**路径（每次生成）。
- 每次生成后计算并持久化的**上下文健康快照**（从使用情况 + 每个模型的元数据派生）。
- 消耗对话上下文健康状态的最小**UI 指示器**表面。

## 目标

- 从 LLM 提供商包装器收集每次生成后的 **token 使用统计**。
- 从提供商统计 + 模型元数据计算简单的**上下文健康**信号。
- 当对话上下文"过大"时，执行简短的、可执行的、可回归测试的 **v3 恢复**工作流：
  - 在 **caution（警告）** 级别，记录一条自动插入的 **role=user prompt** 作为正常的、持久化的用户消息（UI 可见并渲染为正常的用户指令）。
  - 在 **critical（严重）** 级别，通过**倒计时恢复**（最多 5 轮）强制执行稳定性：
    - 每轮注入一条**记录的角色为 user 的 prompt**（UI 可见为用户 prompt），指示智能体整理提醒项（`update_reminder`/`add_reminder`），然后执行 `clear_mind`。
    - prompt 包含倒计时信号（在进行自动 `clear_mind` 之前还剩多少轮）。
    - 当倒计时归零时，Dominds **自动**执行 `clear_mind`（无需 Q4H；无需暂停）以保持长期运行的自主性。

## 非目标

- 在提供商不报告 token 时估计 token（宁愿返回"未知"也不猜测）。
- 引入外部/本地分词器进行 token 计数（例如 tiktoken 风格的估算器）。上下文健康只能依赖 LLM 提供商 API 使用统计。
- 构建完整的"token 核算"系统用于成本报告（这是健康信号，不是计费）。
- 完美的跨提供商可比性（提供商报告使用情况的方式不同；只规范化明确且安全的部分）。

## 定义

- **模型上下文窗口**：模型提示词/上下文可容纳的最大 token 数（如提供商模型元数据中所配置）。
- **提示词 token**：发送给模型进行生成的输入提示词中的 token。
- **补全 token**：模型为该生成产生的 token。
- **总 token**：提示词 token + 补全 token（如果提供商报告）。
- **最优最大 token**：可选的每个模型"软上限"用于提示词/上下文大小。
  - 如果显式配置，Dominds 直接使用。
  - 如果未配置，Dominds 默认为 **100,000** token。
- **关键最大 token**：可选的每个模型"关键上限"用于提示词/上下文大小。
  - 如果显式配置，Dominds 直接使用。
  - 如果未配置，Dominds 默认为**模型硬上下文限制的 90%**（`floor(modelContextLimitTokens * 0.9)`）。
- **警告恢复节奏生成次数**：可选的每个模型警告恢复指导节奏。
  - 如果显式配置，Dominds 直接使用。
  - 如果未配置，Dominds 默认为 **10** 次生成。

注意：

- 对于**上下文健康**，最有用的指标通常是**提示词 token**（输入有多大），而不是补全大小。

## 数据要求（提供商 → Dominds）

提供商包装器必须为**每次成功生成**返回使用统计：

- `promptTokens`：数字
- `completionTokens`：数字
- `totalTokens`：数字（如果提供商未提供则为可选；否则为 `prompt + completion`）
- `modelContextLimitTokens`：数字（来自模型元数据/配置；不推断）

如果提供商无法提供使用情况：

- 返回表示**使用情况不可用**的变体（不要返回零）。
- UI 应为该轮显示"未知"上下文健康。
- Dominds 不得尝试使用外部分词器"填充"缺失的计数。

### 当前 Dominds 中模型限制的来源

模型元数据位于 `dominds/main/llm/defaults.yaml`（可以通过 `.minds/llm.yaml` 覆盖），并由 `LlmConfig`（`dominds/main/llm/client.ts`）加载。

对于上下文健康，限制应来源于：

1. `context_length`（如果存在）
2. 否则使用 `input_length`（作为提示词大小监控的保守回退）

## 健康计算

Dominds 计算比率：

- `hardUtil = promptTokens / modelContextLimitTokens`
- `optimalUtil = promptTokens / effectiveOptimalMaxTokens`

其中：

- `effectiveOptimalMaxTokens = optimal_max_tokens ?? 100_000`
- `effectiveCriticalMaxTokens = critical_max_tokens ?? floor(modelContextLimitTokens * 0.9)`

### 级别

级别从两个阈值派生：

- **健康（绿色）**：`promptTokens <= effectiveOptimalMaxTokens`
- **警告（黄色）**：`promptTokens > effectiveOptimalMaxTokens`
- **严重（红色）**：`promptTokens > effectiveCriticalMaxTokens`

## v3 恢复语义（驱动程序强制执行）

### 接续包（Continuation Package）

恢复工作流围绕一个**接续包**（一个可扫描的、可操作的上下文束）展开，该束在新一程对话中存活。

推荐结构（多行；按任务规模缩放；聚焦于任务文档中未涵盖的细节）：

- 第一个可操作步骤
- 关键指针（文件/符号/搜索词）
- 运行/验证（命令、端口、环境变量）
- 容易丢失的临时细节（路径/ID/URL/示例输入）

### 警告（黄色）

当 `level === 'caution'` 时，驱动程序在**下一个** LLM 生成轮次自动插入一条 **role=user** 指导提示，并**将其持久化为普通用户消息**，以便 UI 将其渲染为正常的用户指令。

当前行为：

- 进入 `caution` 时，Dominds 插入一次提示（入口注入）。
- 保持在 `caution` 状态时，Dominds 按节奏重新插入（默认：每 **10** 次生成；可按模型配置）。
- 每次插入的提示都要求智能体**整理提醒项**（至少一次调用）：
  - `update_reminder`（首选）/ `add_reminder`
  - 在提醒项内维护接续包草稿
  - 当可扫描/可操作时执行 `clear_mind`

### 严重（红色）

当 `level === 'critical'` 时，驱动程序进入**倒计时恢复**（最多 **5** 轮）：

- 每轮，驱动程序记录一条 **role=user prompt**（持久化为用户消息），在 UI 中作为用户 prompt 可见。此提示告诉智能体：
  - 通过 `update_reminder` / `add_reminder` 整理提醒项（尽力而为的接续包），然后调用 `clear_mind` 开始新一程。
- 提示包含倒计时：经过 **N** 轮后系统将自动清空。
- 当倒计时归零时，驱动程序**自动调用** `clear_mind`（带空参数；不要求 `reminder_content`），开始新一程且无需暂停。

理由：

- `caution` 已经在提醒项中尽力推动接续包草稿的编写。
- 在 `critical` 状态下，我们更倾向于保持对话长期运行而无需人工干预。

## UI（Webapp）预期

### "上下文健康"指示器（高优先级）

在对话 UI 中显示一个小型、始终可见的指示器，包括：

- 上一轮的提示词 token 数（或"未知"）
- 模型上下文限制（`context_length`）的百分比

建议的视觉状态：

- **健康**（绿色）
- **警告**（黄色）
- **严重**（红色）
- **未知**（灰色）

注意（中文 UI 文案）：

- `caution` → "吃紧"
- `critical` → "告急"

## 实现大纲

1. 重构 LLM 提供商包装器以在每次生成后返回 token 统计（包括提供商报告时的提示词 token 计数）。
2. 将使用统计传入对话状态（与每程对话一起持久化）。
3. 实现上下文健康监控计算并每次生成持久化。
4. 实现 v3 恢复（持久化的 role=user 提示插入 + 警告提醒整理节奏 + 严重倒计时 + 自动 clear_mind）。
5. 为 v3 行为添加最小回归防护（类型 + 门控）。

## 验收标准

- 每次 LLM 生成后，Dominds 记录 token 使用统计（或"不可用"）并与该轮次关联。
- 上下文健康阈值：
  - 未配置时 `optimal_max_tokens` 默认为 `100_000`。
  - 未配置时 `critical_max_tokens` 默认为 `floor(modelContextLimitTokens * 0.9)`。
- v3 恢复：
  - `caution`：驱动程序插入持久化的 role=user prompt（UI 可见的用户指令）。进入 `caution` 时插入一次；保持在 `caution` 状态时按节奏重新插入（默认：每 10 次生成；可按模型配置）。每次智能体必须至少调用 `update_reminder` / `add_reminder` 之一并维护接续包草稿，然后在就绪时执行 `clear_mind`。
  - `critical`：驱动程序使用**记录的角色为 user 的 prompt** 运行倒计时恢复（最多 5 轮）。每次提示包含倒计时并指示提醒整理 + `clear_mind`。当倒计时归零时，驱动程序自动执行 `clear_mind` 并开始新一程（无 Q4H，无暂停）。
- UI 显示上下文健康状态：绿色/黄色/红色（以及使用情况不可用时的"未知"处理）。
