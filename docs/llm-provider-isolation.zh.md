# LLM Provider 隔离原则

## 原则

Dominds 把每个 LLM provider wrapper 视为独立的协议适配器，而不是某种“大一统 OpenAI-like 抽象”的一个变体。

这意味着：

- `apiType: codex` 只负责 Codex 原生的请求字段、流事件、工具语义和默认行为。
- `apiType: openai` 只负责 OpenAI Responses 原生的请求字段、流事件、工具语义和默认行为。
- `apiType: openai-compatible` 虽然复用 `model_params.openai.*` 命名空间，但它负责的是 Chat Completions 语义，不是 Codex，也不是 Responses。

不同 wrapper 下看起来同名的字段，不代表它们可以互相兼容。比如 `reasoning_effort`、`verbosity`、`parallel_tool_calls`、web search 相关开关，名字可能相似，但可接受值、请求载荷形状、流事件生命周期、校验规则和运行时含义都可能不同。

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
