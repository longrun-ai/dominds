# 火山方舟 Coding Plan OpenAI-Compatible 接入记录

本文记录 Dominds 将火山方舟 Coding Plan 从 Anthropic-compatible 协议切换到 OpenAI-compatible 协议的调研结论、设计边界和实施记录。

调研日期：2026-05-06

## 背景

Dominds 现有火山方舟 Coding Plan 接入主要围绕 Anthropic-compatible 协议推进。实际使用中暴露出较多 provider 兼容层问题，例如工具调用块缺失、工具调用被渲染成文本、空对象工具参数流式拼接异常等。这些问题已经需要若干 Anthropic-compatible quirk 支持。

火山官方 Coding Plan 文档同时提供 OpenAI-compatible 接入方式：

- Anthropic-compatible Base URL：`https://ark.cn-beijing.volces.com/api/coding`
- OpenAI-compatible Base URL：`https://ark.cn-beijing.volces.com/api/coding/v3`

官方明确提醒：Coding Plan 不应使用普通数据面 `https://ark.cn-beijing.volces.com/api/v3`，否则不会消耗 Coding Plan 额度，可能产生额外 API 调用费用。

结论：Dominds 最终取消火山方舟 Coding Plan + Anthropic-compatible 组合，内置 `volcano-engine-coding-plan` 改用 OpenAI-compatible 路线，以降低工具调用、流式输出、thinking/saying 顺序与多模型支持上的兼容成本。

## 资料来源

官方资料：

- 火山方舟 Coding Plan 套餐概览：`https://www.volcengine.com/docs/82379/1925114`
- 火山方舟 Coding Plan 快速开始：`https://www.volcengine.com/docs/82379/1928261`
- 火山方舟 OpenCode 接入：`https://www.volcengine.com/docs/82379/2188958`
- 火山方舟其他 OpenAI-compatible 工具接入：`https://www.volcengine.com/docs/82379/2188959`
- 火山方舟 Chat API：`https://www.volcengine.com/docs/82379/1494384`
- 火山方舟流式输出：`https://www.volcengine.com/docs/82379/2123275`
- 火山方舟 Function Calling：`https://www.volcengine.com/docs/82379/1262342`
- 火山方舟深度思考：`https://www.volcengine.com/docs/82379/1449737`
- 火山方舟错误码：`https://www.volcengine.com/docs/82379/1299023`

社区与上游讨论：

- OpenCode + 火山 Coding Plan WSL 无响应：`https://github.com/anomalyco/opencode/issues/17501`
- OpenCode custom OpenAI-compatible provider 请求完成但 UI 无文本：`https://github.com/anomalyco/opencode/issues/5210`
- OpenCode MiniMax M2 thinking 流式兼容问题：`https://github.com/anomalyco/opencode/issues/3555`
- models.dev 添加 Volcengine / ModelArk Coding Plan provider 的未合入 PR：`https://github.com/anomalyco/models.dev/pull/1215`
- Qwen Code 工具历史 `messages.tool_calls.type` 非 `function` 报错：`https://github.com/QwenLM/qwen-code/issues/3553`
- Roo Code `thinking` 参数缺失 / `reasoning_effort` 与 `thinking` 组合冲突：`https://github.com/RooCodeInc/Roo-Code/issues/11395`、`https://github.com/RooCodeInc/Roo-Code/issues/11001`

## 非目标

本轮不把火山方舟 Coding Plan 的行为泛化成新的通用 OpenAI-compatible 语义。

明确不做：

- 不支持 `ark-code-latest` 作为 Dominds 内置可选模型。
- 不支持通过控制台 Auto 模式改变 Dominds 当前模型语义。
- 不把火山特有 `thinking`、`reasoning_content`、工具调用交替、`<think>` 兼容等行为扩散到普通 `apiType: openai-compatible`。
- 不引入 Anthropic-compatible 与 OpenAI-compatible 双协议兼容层或自动回退路径。
- 不吞掉 provider 返回的不合理结构。能确定为 provider/client mismatch 的场景应显式报错或产生日志，而不是静默降级。

## 总体设计决策

### Provider Profile

当前内置 provider profile：

```yaml
providers:
  volcano-engine-coding-plan:
    name: Volcano Ark Coding Plan
    apiType: openai-compatible
    apiQuirks:
      - same-context-empty-response
      - volcengine-invalid-parameter-aggressive-retry
    baseUrl: https://ark.cn-beijing.volces.com/api/coding/v3
    apiKeyEnvVar: ARK_API_KEY
```

`apiType: openai-compatible` 表示底层 HTTP endpoint、Chat Completions 请求形态和 SSE 基础形态接近 OpenAI Chat Completions。历史上用于火山 Anthropic-compatible 文本 tool_use / 空对象参数拼接的专项 quirks 已删除；当前内置保留 `same-context-empty-response` 这类通用 provider 重试/诊断 quirk，并增加 `volcengine-invalid-parameter-aggressive-retry`，用于火山方舟 Coding Plan 偶发 `400 InvalidParameter` 但同 payload 可重放成功的场景，将其归类为 aggressive 策略重试。

### 具体模型优先

Dominds 只声明具体模型，不声明 `ark-code-latest`。原因：

- 具体模型可稳定复现问题。
- 能力表可以绑定模型，而不是绑定控制台上的动态选择。
- 日志、测试、上下文健康、模型提示都能保持一致。
- 避免控制台 3-5 分钟延迟生效导致运行时行为漂移。

### Quirk 隔离

实现应参考 `@ai-sdk/openai-compatible` 的 provider 配置思路，但不是直接复制其抽象。

建议边界：

- 通用 OpenAI-compatible wrapper 保持 Chat Completions 标准假设。
- 火山 Coding Plan request shaping 以 OpenAI-compatible Chat Completions 形态为基准。
- 火山 Coding Plan stream delta 解释以 OpenAI-compatible SSE 形态为基准。
- 火山 Coding Plan 工具调用历史必须满足 Chat Completions 的 tool_calls / tool result 关联要求。
- driver/storage/UI 只接收 Dominds 已解码后的 thinking/saying/calling 投影事件。

## 支持模型与能力草案

以下模型来自火山官方 Coding Plan 文档。不同区域与账号实际可见模型以控制台为准，但 Dominds 内置配置应保持明确、可测、可复现。

| 模型 key               | 官方说明摘要                             | 输入        | 上下文 | 输出/思维链约束                                           | 风险                                                     |
| ---------------------- | ---------------------------------------- | ----------- | ------ | --------------------------------------------------------- | -------------------------------------------------------- |
| `doubao-seed-2.0-code` | 代码能力强化，支持视觉理解               | text, image | 256k   | 官方 OpenCode 示例 output 4096；套餐概览称思维链可到 128k | 需要验证工具调用流式与图片输入                           |
| `doubao-seed-2.0-pro`  | 通用旗舰，复杂推理与长链路任务           | text, image | 256k   | 思维链可到 128k                                           | 可能返回较长 reasoning，需限流/截断策略                  |
| `doubao-seed-2.0-lite` | 通用生产级，速度与质量平衡               | text, image | 256k   | 思维链可到 128k                                           | 推荐作为高峰期回退候选，但不能自动 fallback              |
| `doubao-seed-code`     | 豆包编程模型，支持视觉理解               | text, image | 256k   | 文档示例 output 4096                                      | 旧模型行为需单测确认                                     |
| `minimax-m2.7`         | 对应 MiniMax-M2.7                        | text        | 200k   | 最大输入 192k；最大输出含思维链 128k；最大思维链 128k     | 高额度消耗；社区有 thinking 流格式差异                   |
| `glm-5.1`              | 复杂工程优化、长程自主执行               | text        | 200k   | 最大输出含思维链 128k；最大思维链 128k                    | 资源有限，易限流；高额度消耗                             |
| `glm-4.7`              | 代码生成、调试、全链路理解               | text        | 200k   | 普通模型列表显示最大回答可到 128k                         | Cursor 社区存在名称冲突写法问题，但 Dominds 可用官方 key |
| `deepseek-v3.2`        | 推理模型，日常 Agent 与轻量代码稳定      | text        | 128k   | 最大回答 32k                                              | 需要专项验证思考与工具调用交替                           |
| `kimi-k2.6`            | 强思考、多步工具调用与推理，支持视觉理解 | text, image | 256k   | 最大输入 224k；最大输出含思维链 32k；最大思维链 32k       | 尝鲜体验版，易限流；高额度消耗                           |
| `kimi-k2.5`            | 前端代码质量和设计表现力，支持视觉理解   | text, image | 256k   | 最大输入 224k；最大输出含思维链 32k；最大思维链 32k       | 需验证工具调用历史字段严格性                             |

实现时可以先配置保守 `output_length: 4096`，再根据实测对支持长输出的模型逐步放开。长输出与长 reasoning 不应仅凭普通模型 API 文档直接开放到 Coding Plan，必须实测。

## Request Shaping 要求

### Base URL

必须使用：

```text
https://ark.cn-beijing.volces.com/api/coding/v3
```

Dominds 内置 provider 不应提供 `https://ark.cn-beijing.volces.com/api/v3` 的 Coding Plan 示例。

### 模型字段

请求 `model` 必须是具体模型 key，例如：

```json
{ "model": "kimi-k2.6" }
```

不允许：

```json
{ "model": "ark-code-latest" }
```

### Thinking 控制

火山 Chat API 支持 `thinking` 对象与 `reasoning_effort` 字段，但社区反馈显示组合不当会触发错误，例如 `reasoning_effort=medium` 与 `thinking.type=disabled` 组合冲突。

建议：

- 在 `model_params.openai-compatible` 里不要为火山复用通用 `reasoning_effort` 默认值。
- 为火山 quirk 增加 provider-specific 参数解释。
- 如果用户显式配置 `thinking.type=disabled`，不要自动补 `reasoning_effort`。
- 如果用户显式配置 `reasoning_effort`，必须明确 `thinking.type=enabled` 或保持 provider 默认；不要与 disabled 混用。
- 所有组合冲突都应在请求前 fail fast，错误信息带 provider/model/参数字段。

### 工具调用历史

火山 Chat API 文档要求历史消息中 `messages.tool_calls.type` 必须为 `function`。社区已有 `type` 为空导致报错的案例。

要求：

- Dominds 投影 assistant tool call history 时，`tool_calls[].type` 必须稳定写成 `function`。
- `tool_calls[].function.name` 必须存在。
- `tool_calls[].function.arguments` 必须是 JSON string，不能是 object。
- 发现 call id 重复、缺失、类型不匹配时 fail fast，不做静默修复。

## Stream Decoding 要求

火山 OpenAI-compatible Chat API 流式响应遵循 SSE `data: ...` 与 `data: [DONE]` 基础形态，但 delta 内容存在 provider/model 差异。

Dominds quirk 层必须至少识别：

- `choices[].delta.content`
- `choices[].delta.reasoning_content`
- `choices[].delta.tool_calls`
- `choices[].finish_reason`
- 可选 `usage`

### Thinking / Saying 顺序

Dominds 的 UI/存储约束是：同一 generation 内 thinking 和 saying 可以交替多段，但段不能重叠。火山模型可能出现：

```text
reasoning_content* -> tool_calls* -> tool_result -> reasoning_content* -> content*
```

这要求 quirk 解码后投影为有序子流：

- reasoning delta 开启/延续 thinking 子流。
- content delta 开启/延续 saying/markdown 子流。
- tool call delta 结束当前 active text-like 子流，再进入 calling。
- tool result 回填后允许下一轮继续 reasoning 或 saying。

如果 provider 在同一 delta 中同时返回 `reasoning_content` 与 `content`，应按到达字段顺序或明确规则拆成相邻事件，不允许 UI 层重排。

### 工具调用流式拼接

OpenAI Chat Completions 风格下，`delta.tool_calls` 可能按 index 分块返回：

- 第一个 chunk 给 `id`、`type`、`function.name`
- 后续 chunk 追加 `function.arguments`

要求：

- 用 index + call id 建立单个 generation 内的工具调用组装状态。
- 同一 index 出现不同 call id 时 fail fast。
- arguments 必须最终解析为 JSON object；解析失败时产生 loud error。
- 允许模型在 thinking 后发工具调用，也允许工具调用后继续 thinking。

### `<think>` 兼容

社区反馈显示部分 OpenAI-compatible 模型或网关会把 thinking 包在 `delta.content` 的 `<think>...</think>` 中，而不是使用 `delta.reasoning_content`。这不是通用 OpenAI-compatible 行为。

火山 quirk 可以专项支持：

- 对指定模型启用 `<think>` tokenizer。
- `<think>` 内映射为 thinking 子流。
- `</think>` 后恢复 content/saying 子流。
- 如果标签跨 chunk，必须用状态机处理。
- 标签嵌套、未闭合或与 `reasoning_content` 混用时 fail fast 或发 stream error，不静默猜测。

该兼容必须是模型级能力开关，不能默认影响所有 OpenAI-compatible provider。

## 错误处理策略

遵循 Dominds loud-by-default 原则：

- Provider 返回结构不合约：fail fast。
- 工具调用 call id 重复或关联冲突：fail fast。
- 流式子流重叠：发送 `stream_error_evt` 并结构化日志。
- 请求参数冲突：请求前报错，不发送到 provider。
- 限流和暂时性服务错误：由既有 retry 机制处理，但日志要包含 provider/model/request id。

日志字段建议包含：

- `provider`
- `model`
- `apiQuirks`
- `rootId`
- `selfId`
- `course`
- `genseq`
- `callId`
- `streamChoiceIndex`
- provider request id，如响应中可得

## OpenCode 调研结论

火山官方 OpenCode 文档使用如下配置形态：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "volcengine-plan/kimi-k2.6",
  "provider": {
    "volcengine-plan": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Volcano Engine",
      "options": {
        "baseURL": "https://ark.cn-beijing.volces.com/api/coding/v3",
        "apiKey": "<ARK_API_KEY>"
      },
      "models": {
        "kimi-k2.6": {
          "name": "kimi-k2.6",
          "limit": {
            "context": 256000,
            "output": 4096
          },
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          }
        }
      }
    }
  }
}
```

可借鉴点：

- provider 使用 `@ai-sdk/openai-compatible`。
- baseURL 使用 Coding Plan 专属 `/api/coding/v3`。
- 模型配置里显式写上下文、输出和 modalities。
- thinking 可放在模型级 `options` 中。

不能照搬点：

- OpenCode models.dev 的 Volcengine / ModelArk Coding Plan provider PR 尚未合入，上游模型元数据不是稳定事实来源。
- OpenCode 曾出现 custom OpenAI-compatible provider 请求完成但 UI 无文本的问题。Dominds 不能假设第三方 SDK 会正确解释所有 delta。
- OpenCode issue 说明 WSL 下火山 Coding Plan 可能出现无响应，Dominds 需要独立诊断网络、SSE 和 delta 解码，而不是只复用 UI 行为。

## 实施计划

### Phase 1：文档与配置边界

- 新增本文档。
- 更新 provider 隔离文档，注明火山 Coding Plan 使用 OpenAI-compatible + 专属 endpoint，不再支持 Anthropic-compatible 火山工具 quirks。
- 在 defaults 中将 `volcano-engine-coding-plan` 调整为 OpenAI-compatible profile，仅列具体模型。
- 不提供 `ark-code-latest`。

### Phase 2：请求构造

- 使用 OpenAI-compatible wrapper 的标准工具调用与流式解析路径。
- 增加火山模型能力表。
- 为火山 provider 增加 `thinking` / `reasoning_effort` 参数冲突校验。
- 确保 tool call history 满足 `type: function`、arguments string 等要求。

### Phase 3：流式解析

- 支持 `reasoning_content` 子流。
- 支持 `delta.tool_calls` 增量拼接。
- 支持 thinking -> tool call -> thinking/content 交替。
- 对选定模型支持 `<think>` content 解析。
- 对非法重叠、非法 call id、非法 JSON arguments 产生 loud diagnostics。

### Phase 4：回归测试

最小测试集：

- 普通 content-only 流。
- reasoning-only 后 content。
- reasoning 后 tool call。
- tool call 后继续 reasoning。
- tool call arguments 多 chunk 拼接。
- `tool_calls.type` 缺失/错误时 fail fast。
- `thinking.disabled + reasoning_effort` 参数冲突时 fail fast。
- `<think>` 跨 chunk 解析。
- `<think>` 未闭合时报错。
- 不允许 `ark-code-latest` 被内置 provider 接受。

### Phase 5：实测矩阵

初始计划需要人工或带密钥环境验证。2026-05-06 已完成的 live smoke 结果见后文“实测记录”，此表保留为覆盖维度清单。

| 模型                   | 短问答 | 工具调用 | thinking | 工具后继续 thinking | 图片输入 | 长输出 |
| ---------------------- | ------ | -------- | -------- | ------------------- | -------- | ------ |
| `doubao-seed-2.0-code` | 待测   | 待测     | 待测     | 待测                | 待测     | 待测   |
| `doubao-seed-2.0-pro`  | 待测   | 待测     | 待测     | 待测                | 待测     | 待测   |
| `doubao-seed-2.0-lite` | 待测   | 待测     | 待测     | 待测                | 待测     | 待测   |
| `doubao-seed-code`     | 待测   | 待测     | 待测     | 待测                | 待测     | 待测   |
| `minimax-m2.7`         | 待测   | 待测     | 待测     | 待测                | 不支持   | 待测   |
| `glm-5.1`              | 待测   | 待测     | 待测     | 待测                | 不支持   | 待测   |
| `glm-4.7`              | 待测   | 待测     | 待测     | 待测                | 不支持   | 待测   |
| `deepseek-v3.2`        | 待测   | 待测     | 待测     | 待测                | 不支持   | 待测   |
| `kimi-k2.6`            | 待测   | 待测     | 待测     | 待测                | 待测     | 待测   |
| `kimi-k2.5`            | 待测   | 待测     | 待测     | 待测                | 待测     | 待测   |

## 开放问题

- 火山 Coding Plan 的 `/api/coding/v3` 是否完整支持普通 Chat API 文档中的所有 `thinking` 字段组合，还是存在 Coding Plan 专属裁剪。
- 除 `minimax-m2.7` 与 `deepseek-v3.2` 外，其他模型在更复杂 prompting 下是否返回 `reasoning_content` 或 `<think>` 包裹内容。
- 长输出上限在 Coding Plan 编程工具场景是否与普通模型 API 一致。
- 图片输入在所有官方标注支持视觉的 Coding Plan 模型上是否通过 OpenAI-compatible Chat Completions 格式稳定可用。
- WSL 无响应是否源于 OpenCode UI 事件处理、SSE 解析、网络/TLS，还是火山 endpoint 对特定客户端行为敏感。

## 2026-05-06 实测记录

使用环境变量 `ARK_API_KEY` 对内置 `volcano-engine-coding-plan` 的 `/api/coding/v3` 做 live smoke。测试脚本：

```bash
pnpm -C dominds/tests run provider-volcengine-coding-plan-live-smoke
pnpm -C dominds/tests run provider-volcengine-coding-plan-live-smoke -- --model minimax-m2.7 --reasoning-model minimax-m2.7
pnpm -C dominds/tests run provider-volcengine-coding-plan-reasoning-live
```

最小矩阵结果：

| 模型                   | 短答 | 工具调用 | reasoning delta | 备注                                                                          |
| ---------------------- | ---- | -------- | --------------- | ----------------------------------------------------------------------------- |
| `doubao-seed-2.0-code` | 通过 | 通过     | 未出现          | 工具参数 JSON object 正常                                                     |
| `doubao-seed-2.0-pro`  | 通过 | 通过     | 未出现          | 延迟明显高于 lite/code                                                        |
| `doubao-seed-2.0-lite` | 通过 | 通过     | 未出现          | 先行单模型 smoke 通过                                                         |
| `doubao-seed-code`     | 通过 | 通过     | 未出现          | 工具调用正常                                                                  |
| `minimax-m2.7`         | 通过 | 通过     | 出现            | `thinking=false` 时仍可能返回 `reasoning_content`；`thinking=true` 单测也通过 |
| `glm-5.1`              | 通过 | 通过     | 未出现          | 工具调用前可能输出一小段正文，协议层仍能收集 tool call                        |
| `glm-4.7`              | 通过 | 通过     | 未出现          | 工具调用正常                                                                  |
| `deepseek-v3.2`        | 通过 | 通过     | 未出现          | 工具调用正常                                                                  |
| `kimi-k2.6`            | 通过 | 通过     | 未出现          | 工具调用 id 形如 `tool_echo:0`                                                |
| `kimi-k2.5`            | 通过 | 通过     | 未出现          | 工具调用 id 形如 `tool_echo:0`                                                |

实测结论：

- OpenAI-compatible Coding Plan 路线在最小短答与单工具调用场景下覆盖所有内置具体模型。
- MiniMax 具体模型 key 使用 `minimax-m2.7`。实测 `minimax-m2.7` 与 `MiniMax-M2.7` 可用，`minimax-2.7` 返回 404 “does not support the coding plan feature”；因此内置配置不使用 `minimax-2.7` 或 `minimax-latest`。
- `minimax-m2.7` 即使显式 `thinking=false`，仍可能返回 `reasoning_content`，因此 quirk 下必须始终识别 reasoning delta，不能以请求参数推断没有 thinking 子流。
- `glm-5.1` 可能在工具调用前输出正文；Dominds 应按事件到达顺序保留正文段，再收集工具调用，不应把它当作协议错误。
- `deepseek-v3.2` 在 `thinking=true` 下多次真实返回非空 `reasoning_content`，然后正常转入正文 `DEEPSEEK_DONE`，无 stream error。
- `minimax-m2.7` 已通过两回合交替链路：第一回合 `thinking -> tool_call`，写入工具结果后第二回合 `thinking -> content`，无 stream error。
- 本轮尚未验证图片输入、长输出、多工具并发。
