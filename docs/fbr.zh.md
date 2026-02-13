# 扪心自问（FBR）——机制规格

英文版：[English](./fbr.md)

> 本文是 **FBR 规范**（以本文为准）。实现细节见：[`fbr-implementation.zh.md`](./fbr-implementation.zh.md)。

## 1. 这是什么

**扪心自问（FBR, Fresh Boots Reasoning）** 是 Dominds 的一种工作机制：在诉请者对话推进过程中，智能体可以把一个边界清晰的子问题“拆出去”，以 **更干净的上下文** 重新推理一次，然后把结论回贴到诉请者对话中。

在 Dominds 里，FBR 通过专用函数工具 `freshBootsReasoning({ tellaskContent: "..." })` 触发；FBR 的核心是运行时对该支线对话施加的一组强制约束与并发语义。

## 2. 设计原则与取舍（为什么这样做）

### 2.1 可预期优先：FBR 必须“无工具”

FBR 的价值来自“把推理拉回文本”：让被诉请者只围绕诉请正文进行独立推理，而不是在工具、环境、副作用里游走。为此，FBR 支线对话必须满足：

- **技术上 0 工具**（不是“提示词里说别用工具”）
- **上下文以诉请正文为权威**（不是“默认继承诉请者对话历史”）

这两点让 FBR 更像一个可控的“推理试算器”，而不是另一个会自行探索环境的智能体。

### 2.2 不搞隐式魔法：禁用就要明确失败

如果团队配置禁用了 FBR（例如 `fbr-effort: 0`），运行时必须 **对用户可见且清晰地拒绝** `freshBootsReasoning({ tellaskContent: "..." })`，避免“看起来发了诉请、实际上被静默忽略”的隐性失败。

### 2.3 多样本推理，而不是“多代理协作”

`fbr-effort` 的并发语义并不是让多条支线相互对话或协作，而是 **并行产生多个互相独立的推理样本**，由诉请者对话负责综合提炼。

## 3. 用户语法

### 3.1 触发语法

触发 FBR 的语法只有一种：

- `freshBootsReasoning({ tellaskContent: "..." })`

说明：

- FBR 不使用 `targetAgentId`、`sessionSlug`、`mentionList`。
- `tellaskContent` 是 FBR 支线的权威任务上下文。

### 3.2 作用域

本文档只定义 **FBR 机制**，并说明其通过 `freshBootsReasoning({ tellaskContent: "..." })` 触发的行为契约。一般的队友诉请（`tellaskSessionless({ targetAgentId: "<teammate>", tellaskContent: "..." })`）仍按 [`dialog-system.zh.md`](./dialog-system.zh.md) 的 Tellask 分类与能力模型执行。

如果你需要“同人设但可用工具”的支线对话，请使用一般队友诉请路径，并显式指定队友身份。

## 4. 运行时契约（必须做到什么）

本节使用“必须/不得/应/可”描述运行时的强制要求。

### 4.1 隔离与上下文

当运行时驱动由 `freshBootsReasoning({ tellaskContent: "..." })` 创建的 FBR 支线对话时，必须强制满足：

- **不依赖诉请者对话上下文**：
- 被诉请者不得假设能访问**诉请者对话**历史
  - 被诉请者必须把诉请正文当作主要且权威的任务上下文
- **不得通过工具补上下文**：
  - 不得读文件/跑命令/浏览
  - 不得读取 Memory 或 rtws（运行时工作区）状态

直觉上：FBR 的“初心”不是“忘掉一切系统规则”，而是“相对诉请者对话不继承历史”。运行时仍可能无条件注入基础规则（安全、格式、少量只读摘要等），但 **推理依据必须以诉请正文为主**。

### 4.2 无工具（提示词 + 技术强制）

FBR 的无工具约束必须同时满足两类要求：

1. **提示词契约**：运行时必须把“无工具”约束表达得明确无歧义。
2. **API/传输层契约**：运行时必须在技术上强制执行“0 工具”。

#### 4.2.1 system prompt 的要求（不得包含工具说明）

FBR 支线对话的 system prompt 必须明确包含（措辞可不同，但语义必须到位）：

- 这是一次 FBR 支线对话，诉请正文是主要任务上下文
- 不要假设能访问诉请者对话历史
- 若诉请正文缺少关键上下文，需要列出缺失信息与阻塞原因
- 不得发起任何诉请（包括 `tellaskBack` 或 `askHuman`）

同时，**system prompt 本体不得包含任何工具说明**（不得出现“有哪些工具/如何用工具/例子命令/白名单”等）。

#### 4.2.2 附加“无工具提示”（唯一允许的工具相关文本）

关于工具可用性的所有表达必须收敛到单独附加的一段“无工具提示”，并且：

- 该提示必须 **简短、固定、不可扩展**
- 必须明确声明：
  - 没有任何工具，不能调用工具
  - 不能访问 rtws / 文件 / 浏览器 / shell
- 不得包含任何工具清单、允许列表、示例命令或执行指导

如果提供方集成通常会注入工具提示（或工具结构），那么对 FBR 必须二选一：

- 完全不注入工具提示，或
- 仅注入与“无工具提示”**完全一致**的文本

无论如何，FBR 支线对话都不应看到任何工具定义。

#### 4.2.3 LLM 请求必须是“0 工具”

发起 `freshBootsReasoning` FBR 支线对话的 LLM 请求必须做到 **0 个可用工具**：

- 请求 payload 中不得包含任何 tool/function 定义（有效工具列表必须为空）
- 不得启用提供方支持的任何“工具调用模式 / 工具选择 / 函数调用”开关

并且：如果模型仍尝试发出 tool/function call，运行时必须视为违规并硬拒绝（见 4.5）。

### 4.3 诉请限制：一律禁止

FBR 支线对话不得发起任何队友诉请（包括 `tellaskBack({ tellaskContent: "..." })` 或 `askHuman({ tellaskContent: "..." })`）。
若关键上下文缺失，应**列出缺口与阻塞原因**，然后直接回贴。

### 4.4 输出契约（便于诉请者对话综合）

FBR 支线对话应产出一份便于诉请者整合的简明推理结果。推荐结构（不强制）：

1. **结论 / 建议**
2. **推理过程**（仅基于诉请正文）
3. **前提假设**（明确标注来源：诉请正文/会话历史）
4. **未知与缺口**（如果有）
5. **给诉请者对话的下一步**（诉请者对话可能有工具/队友，可在诉请者对话执行）

### 4.5 违规与报错（必须“响亮可调试”）

- 若 FBR 支线对话尝试发起任意队友诉请，或尝试 tool/function call，运行时必须硬拒绝该次驱动。
- 反馈必须 **对用户可见、语义清晰**，并且日志/事件中应包含可检索的错误原因字符串，避免静默吞掉。

## 5. 并发语义：`fbr-effort`

`fbr-effort` 是 **按队友成员（member）配置** 的整数参数，也可以放在 `member_defaults` 里作为 rtws 默认值。

- 类型：整数
- 默认：`3`
- `0`：禁用该成员的 `freshBootsReasoning({ tellaskContent: "..." })` FBR（必须明确报错拒绝）
- `1..100`：每次 `freshBootsReasoning({ tellaskContent: "..." })` 并发创建 N 条 FBR 支线对话
- `> 100` / 非整数 / 负数：配置错误（直接报错，不做 clamp）

当 `fbr-effort = N`：

- 运行时必须把一条 `freshBootsReasoning({ tellaskContent: "..." })` 扩展为 **N 条并行的无工具 FBR 支线对话**
- 每条支线接收相同的诉请正文与相同的 FBR 提示词约束
- 诉请者对话必须接收全部 N 条回贴；**不应依赖固定顺序**（可按完成顺序回贴）

## 6. 模型参数覆盖：`fbr_model_params`

`fbr_model_params` 用于只在驱动 FBR 支线对话时覆盖模型参数：

- 结构：与 `model_params` 完全一致（参考 `dominds/main/llm/defaults.yaml` 的 `model_param_options`）
- 作用域：仅对 `freshBootsReasoning({ tellaskContent: "..." })` FBR 生效
- 合并：建议在成员的有效 `model_params` 之上做深合并覆盖（便于只改少数字段，如 `temperature`）
- `max_tokens` 允许写成顶层 `max_tokens`，也允许写成 `general.max_tokens`；二选一，禁止同时设置

## 7. 配置示例

### 7.1 诉请正文必须自给自足

坏例（依赖外部上下文与工具）：

```text
freshBootsReasoning({ tellaskContent: "把 bug 找出来并修掉。" })
```

好例（把关键上下文写进正文）：

```text
freshBootsReasoning({ tellaskContent: "你正在做无工具的 FBR。请只使用下方文本推理。\n\n目标：判断最可能的根因，并给出 2–3 个可行修复方向。\n\n现象：\n- 点击 \"Run\" 偶发卡死 ~10 秒。\n\n约束：\n- 不能改后端协议。\n\n线索（日志/片段）：\n<粘贴相关日志或代码片段>" })
```

### 7.2 `.minds/team.yaml`

```yaml
member_defaults:
  # 默认每次 `freshBootsReasoning({ tellaskContent: "..." })` 并发创建 3 条无工具 FBR 支线对话。
  fbr-effort: 3

members:
  ux:
    # 每次 `freshBootsReasoning({ tellaskContent: "..." })` 并发创建 5 条独立推理样本。
    fbr-effort: 5

    # 让 FBR 更“发散”，但不影响诉请者对话风格。
    fbr_model_params:
      codex:
        temperature: 0.9
        reasoning_effort: medium
      general:
        max_tokens: 1200
```

## 8. 与一般支线对话的关系（避免混用）

- `freshBootsReasoning({ tellaskContent: "..." })` 的 FBR 支线对话是 **特例**：无工具、正文优先、诉请受限、可并发扩展。
- 一般的 `tellaskSessionless({ targetAgentId: "<teammate>", tellaskContent: "..." })` 支线对话仍是“完整能力”的（可按配置拥有工具与工具集）。
- 若你需要“同人设 + 可用工具”的支线，请使用显式队友身份（`tellask` / `tellaskSessionless`）。

## 9. 验收清单（实现检查点）

- `freshBootsReasoning({ tellaskContent: "..." })` 触发 FBR：支线对话必须无工具，并且在 API 层确认为“0 工具”请求。
- system prompt 本体不含工具说明；工具相关文本只能来自独立、固定的“无工具提示”。
- FBR 支线对话不得发起队友诉请（包括 `tellaskBack`）。
- `fbr-effort` 默认 `3`，接受 `0..100`，禁用时明确报错拒绝。
- `fbr_model_params` 仅对 FBR 生效，且与 `model_params` 同结构、按深合并覆盖。
