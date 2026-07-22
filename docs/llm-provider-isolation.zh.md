# LLM Provider 隔离原则

## 原则

Dominds 把每个 LLM provider wrapper 视为独立的协议适配器，而不是某种“大一统 OpenAI-like 抽象”的一个变体。

这意味着：

- `apiType: codex` 只负责 Codex 原生的请求字段、流事件、工具语义和默认行为。
- `apiType: openai` 只负责 OpenAI Responses 原生的请求字段、流事件、工具语义和默认行为。
- `apiType: openai-compatible` 负责 Chat Completions 语义，包括 `model_params.openai-compatible.*` 命名空间，不是 Codex，也不是 Responses。
- `apiType: anthropic` 只负责 Anthropic 官方 Messages 语义，包括 object 形态的 `model_params.anthropic.thinking`。
- `apiType: anthropic-compatible` 负责 Anthropic 兼容网关语义，包括 boolean 形态的 `model_params.anthropic-compatible.thinking`，并映射为 provider 请求里的 `enabled` / `disabled` object。

某些 provider / API 路径虽然暴露相似 endpoint 或模型能力，但仍可能需要明确的 provider quirk profile。内置 Codex (ChatGPT) provider 默认启用 `codex-anti-early-finalization`，只在 Codex provider 的 `instructions` 里按当前工作语言追加推理完成检查提示，用于规避 ChatGPT/Codex 路径疑似思考过早截断/提前收尾的问题；这个 quirk 不应用到 `apiType: openai`。火山方舟 Coding Plan 现在走 OpenAI-compatible Chat Completions 形态，并使用专属 `/api/coding/v3` endpoint；历史 Anthropic-compatible 火山工具调用 quirk 已取消。Kimi Code 也走 OpenAI-compatible Chat Completions 形态，但必须使用内置 `kimi-code` provider 的专属 `/coding/v1` endpoint、带 Dominds 版本的 `KimiCLI/Dominds/<version>` User-Agent、`prompt_cache_key` 和 Kimi 专用 `thinking`/`reasoning_effort` 请求整形。火山迁移设计记录见 [`volcengine-coding-plan-openai-compatible.zh.md`](./volcengine-coding-plan-openai-compatible.zh.md)。

不同 wrapper 下看起来同名的字段，不代表它们可以互相兼容。比如 `reasoning_effort`、`verbosity`、`parallel_tool_calls`、web search 相关开关，名字可能相似，但可接受值、请求载荷形状、流事件生命周期、校验规则和运行时含义都可能不同。

内置 Codex provider 的 `reasoning_effort` 最高支持 `max`。Codex 客户端里的 Ultra 不是一个可以独立复刻的 inference effort：当前 codex-rs 在请求边界发送 `max`，同时通过客户端自己的多智能体模式另行开启主动委派。Dominds 不接受 `model_params.codex.reasoning_effort: ultra`，也不会把它静默映射为 `max`，否则会让用户误以为 Codex 的整套 Ultra 行为已经复刻。Dominds 的 `tellask` / 支线对话是 provider 无关的持久化团队协作机制，与这个 provider 参数相互独立；如果以后需要增加主动程度档位，也应设计成明确的 Dominds 产品级协作策略。

## 强约束

- wrapper 构造请求时，只能读取自己的 provider 参数命名空间。
- wrapper 解析流事件时，只能解释自己的 provider 原生事件。
- wrapper 内禁止静默 fallback 到别的 provider 参数、别名或事件假设。
- 只有在 driver / storage / UI 边界，才允许把 provider-native 事件投影成更窄的共享形态，而且前提是 wrapper 侧已经先完成了 provider-native 解码。

## 为什么

这样做是为了让 provider 集成保持诚实：

- 减少“碰巧兼容”带来的隐式行为
- 在 provider 分叉时更容易排查问题
- 降低 wrapper 之间的隐藏耦合
- 在官方 API 各自演化时，升级更安全

## 当前边界

目前后端在 wrapper 内保留 provider-specific 的 web search 事件类型，再在 `main/llm/kernel-driver/drive.ts` 投影成较窄的 dialog 事件形态。

这个投影层是有意设计的，它就是兼容边界。边界两侧的 wrapper 代码都应继续保持 provider-native。
