# 鞭策 — 设计文档

英文版：[English](./diligence-push.md)

## 概述

Dominds 主线对话旨在长期运行。主线对话"停止"（变为空闲）通常不是操作员想要的：他们希望智能体持续推进，直到：

- 合法地暂停等待人类决策（Q4H），或
- 没有其它本地可推进事项，只保留后台被诉请者事实（pending tellask/backfill）。

本文档指定两个相关但不同的运行时控制：

- **自动续推注入**：仅针对**主线对话**，当驱动程序即将停止、且没有 Q4H 或 pending active callee dispatch 时，运行时会自动发送一个简短的鞭策语（渲染为正常的用户气泡）并继续生成。pending tellask 是后台被诉请者事实，不是阻塞态；但在没有其它具体驱动来源时，它表示主线已经到达可 idle 的后台等待边界，不应靠鞭策语保持主线空转。
- **强制工具调用控制**：对于普通的主线/支线对话轮次，`鞭策` 勾选项控制本轮 provider 请求是否必须通过 Dominds 工具结束。勾选时，模型应通过 `askHuman`、`tellask*`、`replyTellask*` 或其他运行时函数完成这一轮，而不是用普通文本直接收尾。若确实没有其它实质工具应调用，`answerHuman` 就是该强制工具轮次的预期收口路径。等待 pending active callees 这类边界属于预期场景：模型应通过 `answerHuman` 说明当前等待状态，然后停止等待回贴到达，而不是继续调用普通工具空转。FBR 中间轮是刻意例外：它们可以处于无可调用工具状态；FBR 收口阶段则必须调用两个结论工具之一。

## 目标

- 防止主线对话停止，除非处于 Q4H 等真正等待用户输入的状态，或已自然没有本地可推进事项。
- 保持行为可预测和有界（无无限循环）。
- 使鞭策语文本可按 rtws（运行时工作区）和语言配置。
- 提供清晰的用户控制的"禁用"机制。

## 非目标

- 自动完成/自动将对话标记为完成。
- 将鞭策语注入应用于支线对话。支线对话应由普通业务事实继续推进，或向诉请者回贴；非本意的直接回复停止由 direct-reply fallback 与 caller 后续判断处理。

## 定义

- **主线对话**：`MainDialog`（`dlg.id.rootId === dlg.id.selfId`），主要对话线程。
- **支线对话**：`SideDialog`，为 tellask / 作用域工作创建。
- **Q4H**："Questions for Human"，通过 `askHuman()` 发起，暂停对话进度直到人类响应。

## 预期的"正常"完成路径（推荐）

当智能体需要人类决策来结束时（例如，确认选择或决定是否将对话标记为完成），正确的路径是：

1. 智能体发出 Q4H（`askHuman()`）并提供必要的上下文和明确的决策请求。
2. WebUI 清楚地呈现 Q4H。
3. 人类决定并：
   - 手动将主线对话标记为"完成"，或
   - 提供请求的信息以便对话继续。

这是"受控收敛"路径。diligence-push 机制不应覆盖合法的暂停状态。

## 鞭策行为（"自动继续"回退）

### 触发条件（必须全部满足）

- 对话是**主线对话**。
- 对话没有会合法停止自动续推的等待事实：
  - 没有待处理的 Q4H。
  - 没有 pending active callee dispatch。
- 驱动程序即将停止生成循环（即没有工具/函数输出需要另一次迭代）。

### provider 死锁恢复

某些 provider/API quirk 在识别到已知的 same-context deadlock，并停止沿用同一上下文自动重试后，
会请求一次性的鞭策恢复。这不是普通的“对话即将空转停止”路径，但仍必须遵守同一条后台等待边界：
鞭策恢复注入仅作用于主线对话，且 pending active callee dispatch 会否决这一次鞭策注入。active callee dispatch 是后台被诉请者事实，不是 caller 的阻塞态；它允许 caller 因其它具体事实继续推进，但不能单独成为“保持主线 drive”的理由。支线对话 retry-stopped 恢复不注入鞭策语；后续由普通业务事实、direct-reply fallback 或 caller 的下一步判断决定。

### 操作

运行时自动发送一个鞭策语（渲染为正常的用户气泡）并运行另一次生成迭代。

### 有界性

为避免无限循环，diligence-push 有一个按对话的预算（每个成员的 `diligence-push-max`），控制对于给定对话在当前预算内还能注入多少个自动继续的鞭策语；预算耗尽后，运行时会停止继续自动鞭策。

- 默认值：**99**
- 如果 `< 1`，则新建对话从 0 个自动鞭策预算开始
- 可通过 `.minds/team.yaml` 中的 `diligence-push-max` 按成员配置

重要：`diligence-push-max` 只是在创建或重置对话实例时使用的默认预算。运行时业务判断必须以具体对话自己的剩余预算
（`diligencePushRemainingBudget`）为准；因此即使团队默认值是 `0`，手工补充过预算的对话也应继续自动鞭策。

### Q4H 暂停

当对话因待处理的 Q4H（Questions for Human）而暂停时，鞭策会在该暂停期间停止。Q4H 不会重新套用成员默认预算；对话会保留自己的剩余预算，因此操作员调整过的预算能跨过暂停边界继续生效。

### 预算耗尽 → 停止继续自动鞭策当前预算

当 diligence-push 预算耗尽时，运行时会发出一条仅用于提示的 UI 信息，并停止继续自动鞭策当前预算。它不会仅因预算耗尽而自动创建 Q4H。

### 禁用开关

可以通过以下任一方式按 rtws 禁用 diligence-push：

- 如果选中的鞭策语文件存在但其内容为空/仅空白，则禁用 diligence-push（不注入）。

若要停止某个具体对话的自动续推，应将该对话的剩余预算设为 `0`，或使用该对话自己的鞭策禁用开关。

## 鞭策语解析

让 `<rtws>` 为当前运行时工作区（即 `process.cwd()`）。

解析顺序：

1. `<rtws>/.minds/diligence.<work-lang-id>.md`（例如，`diligence.zh.md`）
2. `<rtws>/.minds/diligence.md`（语言无关的回退）
3. 内置回退文本（硬编码的 i18n；`zh` 是规范的并嵌入在源代码中）

如果上述顺序中第一个存在的文件具有空/空白内容，则**禁用** diligence-push。

注意：鞭策语文件中的 YAML frontmatter 会被运行时忽略。如果存在，它被视为非内容元数据并从提示正文中剥离。

### 团队成员默认预算：`diligence-push-max`

每个团队成员可以选择通过 `.minds/team.yaml` 设置新建或重置对话的鞭策起始预算：

```yaml
members:
  alice:
    diligence-push-max: 10
```

规则：

- 如果缺失，`diligence-push-max` 对于该成员默认为 **99**。
- 如果 `diligence-push-max < 1`，则新建对话的剩余预算从 `0` 开始。
- 创建或重置之后，运行时业务逻辑以对话自己的剩余预算为准，而不是再次把 `diligence-push-max` 当作启停闸门。
- 内置影子成员 `fuxi` 和 `pangu` 默认为 `diligence-push-max: 0`，除非在 team.yaml 中显式覆盖。

## UX 备注

- Diligence-push 是一个仅运行时的提示，但它应该是**可见的**：鞭策语渲染为正常的用户消息气泡（由运行时自动发送），以便操作员理解为什么会出现额外的迭代。
- 用户应该观察到智能体在仅工具操作后继续简短的跟进。
- 当智能体真正需要用户干预时，它应该使用 Q4H。Diligence-push 不应试图"假装"完成。

## 实现（后端）

### 位置

在 kernel driver 循环中实现（`dominds/main/llm/kernel-driver/drive.ts`），作为迭代后的小检查：

1. 如果对话正在等待 Q4H，或仍有 pending active callee dispatch，则停止。active callee dispatch 是后台被诉请者事实，不是 caller 的阻塞态；但在没有其它具体驱动来源时，它是自然 idle 边界，不能触发鞭策注入。
2. 如果有任何工具反馈，则正常继续。
3. 否则尝试 diligence-push 自动继续：
   - 主线对话：按 rtws diligence 文件 / 内置回退文本解析并续推。
   - 支线对话：不注入鞭策语。
   - 如果禁用 → 正常停止。
   - 如果预算耗尽 → 发出一条仅用于提示的 UI 信息，并停止继续自动鞭策当前预算。
   - 否则 → 自动发送鞭策语并继续。

### 消息类型

我们将鞭策语作为自动发送的用户消息注入：

- 类型为 `prompting_msg`、角色为 `'user'` 的 `ChatMessage`

这确保了：

- 它存在于模型上下文中
- 它作为人类消息记录持久化
- 它在聊天时间线中渲染为正常的用户气泡（像任何其他用户消息一样）

## 可观察性

建议的后续步骤（初始实现不需要）：

- 当触发 diligence-push 时添加结构化日志行，包括：
  - 对话 id
  - 语言
  - 使用的鞭策语来源（语言特定/通用/内置/禁用）
- 为"diligence-push 触发"和"diligence-push 因空文件禁用"添加可选的指标计数器。

## 测试

回归测试应覆盖：

- 主线对话：仅工具输出 → 鞭策语注入 → 继续响应
- 主线对话：空助手输出 → 鞭策语注入 → 继续响应
- 主线对话：只派发 pending tellask / active callee dispatch → 无鞭策语注入，保留后台状态并自然 idle
- 支线对话：普通 idle 无鞭策语注入
- 支线对话：provider quirk recovery 无鞭策语注入；由 direct-reply fallback 或 caller 判断后续业务动作
- rtws 配置：
  - 当语言特定文件缺失时，`.minds/diligence.md` 被遵守
  - 空的鞭策语文件禁用 diligence-push
