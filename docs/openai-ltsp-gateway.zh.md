# LTSP OpenAI 网关联测与模型配置

2026-10-31，Dominds 与 LTSP 网关规划聊天联合验证 ltspc16。接入地址为 `http://172.16.100.254:8080/openai`，`apiType` 使用 `openai`，由 Dominds 的 Responses adapter 构造请求。无需再补 `/v1`；`openai-compatible` 的 Chat Completions 不是本次接入方式。

## 模型目录与静态规格

网关 `/openai/models` 当次返回130项，包含聊天、图像、音频、embedding等不同用途，不能把整个目录当成 Dominds 执行智能体可用的聊天模型清单。目录表示当时可见的ID，不能证明账号实际余额、RPM/TPM、每种模态或所有调用均可用。

本次为内置 OpenAI provider 补齐以下五个文本/工具工作流模型，保留旧模型兼容；没有修改独立 Codex provider。官方 API 使用无前缀ID，网关实例使用表中带 `openai/` 的wire ID。

| 官方模型ID      | 网关wire ID            | 总上下文  | 最大输出 | 推理effort                               |
| --------------- | ---------------------- | --------- | -------- | ---------------------------------------- |
| `gpt-6.1-sol`   | `openai/gpt-6.1-sol`   | 1,050,000 | 128,000  | low / medium / high / xhigh / max        |
| `gpt-6.1-terra` | `openai/gpt-6.1-terra` | 1,050,000 | 128,000  | none / low / medium / high / xhigh / max |
| `gpt-6-astra`   | `openai/gpt-6-astra`   | 1,050,000 | 128,000  | low / medium / high / xhigh / max        |
| `gpt-6-luna`    | `openai/gpt-6-luna`    | 1,050,000 | 128,000  | none / low / medium / high / xhigh / max |
| `gpt-6-sol`     | `openai/gpt-6-sol`     | 1,050,000 | 128,000  | none / low / medium / high / xhigh / max |

规格依据各官方页：[6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra)、[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、[6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)。五者均声明支持图片输入；本次没有进行真实图像理解或视觉质量验收。

输入、输出及reasoning共享总上下文，不能把1.05M输入再加128K输出。本次不单列未经官方独立说明的 `input_length`。`optimal_max_tokens: 600000`、`critical_max_tokens: 922000` 与10代保全提醒节奏沿用已有1.05M模型的 Dominds harness 策略；922K为总窗口减去128K输出余量，是应用预算，不是新测出的供应商max-input。没有做百万token压力测试，也没有实际生成128K输出。

Bifrost聚合元数据曾对Terra分别给出922K/1.05M输入，并带有与本次Responses+low工具往返不一致的泛化能力标记。静态规格以官方API资料为准，具体可用性由所述实测建立；不把聚合字段直接拷贝成全局能力或外推到其它API。

## 在rtws接入

将[完整无密钥样例](./examples/ltsp-openai.llm.yaml)的 `providers.ltsp-openai` 合入已有 `.minds/llm.yaml`，保留其它provider。`LlmConfig`按provider键替换配置，不会自动把新provider的模型表与内置OpenAI表深度合并。

为 Dominds 进程注入 `LTSP_OPENAI_API_KEY`，值应为部署方批准的网关 Virtual Key；不要使用dummy值，也不要将实际Key写入Git。样例只引用变量名，不包含凭据，不改变内置OpenAI的官方baseURL。

团队成员显式选择网关provider和wire ID，例如：

```yaml
members:
  executor:
    name: Executor
    provider: ltsp-openai
    model: openai/gpt-6.1-terra
    model_params:
      openai:
        reasoning_effort: low
        verbosity: low
```

这是低量连通测试参数，不是质量或成本最优档位的结论。使用者应按实际任务评估effort；Astra与6.1 Sol不接受none，旧模型的minimal选项不适用于本表。启用reasoning时省略 `temperature`、`top_p` 等不兼容采样参数；工具调用使用Responses。详见[官方GPT-6接入指导](https://developers.openai.com/api/docs/guides/latest-model)。provider参数提示中的选项是按模型适用的并集，不是对每个模型的统一支持承诺。

本轮只验证带provider前缀的推理请求。裸ID的模型元数据读取成功不等于裸ID推理路由已验证；不要只凭 `/openai` URL 假定网关会自动选择provider。

## Pro 模式与 rtws 选择

GPT-6 的 Pro 是 Responses 执行模式，使用真实模型 ID 加 `reasoning.mode: pro`，与 `reasoning.effort` 独立；`max` effort 不会自动开启 Pro。Pro 会执行更多模型工作，并增加 token 使用和延迟，按所选模型的 token 费率计费。见[官方 reasoning mode](https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode)。

截至2026-11-02，官方说明支持该模式的**当前 Dominds 内置通用 OpenAI 模型**如下：

| 系列    | 模型 ID                                                               |
| ------- | --------------------------------------------------------------------- |
| GPT-6.1 | `gpt-6.1-sol`、`gpt-6.1-terra`                                        |
| GPT-6   | `gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`                              |
| GPT-5.6 | `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`；`gpt-5.6` 是 Sol 别名 |

依据[官方模式支持范围](https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode)与[型号/别名说明](https://developers.openai.com/api/docs/guides/latest-model)。网关使用相应的 `openai/` 前缀 ID。2026-11-02 实测中，表内8个规范型号的 standard/pro × high 全部通过流式工具往返；官方别名 `openai/gpt-5.6` 的两个模式均被当前网关 Virtual Key 以403拒绝，应在此网关使用已验证的 `openai/gpt-5.6-sol`。别名是官方支持与当前网关实际可用性的差异，不能据此删除官方 provider 中的合法别名。详见下述本轮矩阵。

该范围适用于 OpenAI Responses，不外推到 Codex 或 Chat Completions。旧 `gpt-5.5-pro` 等仍是独立模型 ID，沿用各自行为和计费；不要向其它旧模型通用添加此开关。Astra 支持 Pro，effort 支持 low / medium / high / xhigh / max，Pro 下 effort 仍有效；当前 high 的两个模式均已实测。

Dominds 使用 `.minds/team.yaml` 的 `model_params.openai.reasoning_mode: standard | pro`，模型目录继续使用原始 wire ID。例如让普通执行成员使用标准模式、审查成员显式使用 Pro：

```yaml
member_defaults:
  provider: ltsp-openai
  model: openai/gpt-6.1-sol
  model_params:
    openai:
      reasoning_mode: standard
      reasoning_effort: medium
      verbosity: medium
members:
  executor:
    name: Executor
  reviewer:
    name: Reviewer
    model_params:
      openai:
        reasoning_mode: pro
        reasoning_effort: high
        verbosity: medium
```

`model_params` 是团队成员的运行配置；`.minds/llm.yaml` 的 `model_param_options` 提供配置提示。上面的[完整网关样例](./examples/ltsp-openai.llm.yaml)包含模式、effort 和 verbosity 的选项，因此这个自定义 provider 也能在 `/setup` 显示对应控件，并在 generation 模型标识/tooltip 中显示已配置的模式。成员自己的 `model_params` 替换整个继承参数块，示例为 reviewer 明确写出其所需参数。

已有团队应在原 `.minds/team.yaml` 的 `member_defaults` 或具体 `members.<id>.model_params.openai` 下定点修改模式，保留现有成员、权限及其它配置。`/setup` 是初始化入口，保存的是仅含 `member_defaults` 的最小团队文件；确认覆盖会替换整份 `team.yaml`，不能把它当成已有团队的成员编辑器。

初始化时，在 `/setup` 先选 provider 与模型，再独立选择 `reasoning_mode` 和 effort，检查生成的 `member_defaults` 预览后保存。重新加载 setup 会读回已保存的参数；手动更改的选择不会被随后状态刷新重置。模式控件没有预选默认值，省略 mode 保持既有请求不发送该字段；官方默认采用 standard。仅对支持该参数的 GPT-5.6/GPT-6 选择 standard/pro，切换到不支持的旧模型时保持未设置。已有旧 rtws 不会被自动切换为 Pro。配置显示的是选择，不是上游执行结果的证明。

无需添加 `gpt-6-pro` 或 `gpt-6.1-sol-pro` 模型条目。当前配置中的模型键直接用于请求，`name` 仅为显示名称，不会把本地虚构 ID 映射为另一个上游模型。

### 本轮流式 high 矩阵

2026-11-02 经实际隔离 rtws、`Team.load()` 和原生 `OpenAiGen.genToReceiver()`，尝试上述8个规范 ID 及别名的 standard/pro 两格，共18格。每个成功格均进行流式函数调用及流式工具结果续轮：给定 nonce 原样传入，独立生成的 receipt 只经工具结果提供，续轮 JSON 完整返回；没有执行真实工具。

- 8个规范 ID 的16格通过，共32个实际请求。每个原始 `response.completed` 都回显预期型号、对应 mode、high effort 和 completed 状态，且无额外 SDK 请求。
- `openai/gpt-5.6` 的2格各发出1个请求并收到403，工具结果续轮未执行；失败原样保留。整个18格矩阵返回失败，不能称为全绿。
- 该次共34个请求，完整请求/响应、失败及源码见[本轮矩阵验收记录](../tests/audits/2026-11-02-openai-high-matrix.json)。它验证协议可用性，不证明 Pro 质量收益、所有 effort、长上下文、吞吐或缓存收益。

今后按[模型可用性矩阵约定](./testing-strategy.md#模型与-pro-的真实可用性矩阵)覆盖声明支持的全部型号及模式，统一 high、流式。非流式和其它 effort 可以跳过；不再用单一型号的 Pro 成功代替其余型号。HTTP200、费用及 reasoning token 数均不作为模式生效的替代证据；网关日志若没有 mode 列，应保留原始上游 completed 回显。

前一轮2026-11-01的 [Pro 专项](../tests/audits/2026-11-01-openai-pro.json)保留4次 Sol/low 请求、部分非流式路径和真实 Chromium setup 配置体验的独立范围，不能作为本轮 high 矩阵的替代。

## 前一轮基础联测范围

五个模型均通过 Dominds 原生 `OpenAiGen` 的短请求：Terra流式，另外四个batch；返回的真实model标识一致，usage可用。Terra还通过一次流式函数调用与工具结果batch续轮：给定nonce完整传入，独立随机receipt仅经工具结果提供，续轮结构化JSON完整返回；没有执行真实工具。检查的是机器数据与协议，不以回答措辞判断语义质量。

客户端未发送缓存TTL时，响应回显 `prompt_cache_options.ttl: 12h`，证实该网关采用了部署方默认值。另一次直接原生SDK请求显式传入 `prompt_cache_options.ttl: 30m` 并得到30m回显，没有被网关默认覆盖。后者只建立SDK/网关字段保全，不表示当前 Dominds 团队参数已开放TTL或输出token override。

OpenAI官方默认是30m，12h是此网关策略；两种设置的cache-write费率不同。小于1,024可见输入token的请求不会因此证明缓存命中；本次没有发送长prompt测试cache-write、命中率或节费。见[官方prompt caching文档](https://developers.openai.com/api/docs/guides/prompt-caching)。

LTSP侧按网关request ID独立读回日志，确认实际provider/model、usage、成功状态、无retry/fallback及正文隐藏。完整目录快照、请求/响应、初次夹具错误与执行范围保存在[联合验收记录](../tests/audits/2026-10-31-ltsp-openai.json)。记录中的短请求不证明长上下文、长期缓存保留、模型回答质量、所有130模型或吞吐限额。
