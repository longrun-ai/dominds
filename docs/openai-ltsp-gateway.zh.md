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

Pro 专项已通过一次原生 SDK 调用，以及由实际 rtws 配置和 `Team.load()` 取得成员的 Dominds 流式调用、流式函数调用及工具结果 batch 续轮，共4次 Sol 请求。原始非流式响应和流式 completed 事件均明确回显 `reasoning.mode: pro`；HTTP200、费用升高或 reasoning token 数均不作为 Pro 生效的替代证据。网关日志独立核对 ID、模型及 usage，但其日志没有独立 mode 列。完整证据见[Pro 专项验收](../tests/audits/2026-11-01-openai-pro.json)。本次使用 low effort 验证传输与给定 JSON 数据往返，没有测量 Pro 的任务质量收益，也没有逐个验收所有模型/effort 组合。

## 前一轮基础联测范围

五个模型均通过 Dominds 原生 `OpenAiGen` 的短请求：Terra流式，另外四个batch；返回的真实model标识一致，usage可用。Terra还通过一次流式函数调用与工具结果batch续轮：给定nonce完整传入，独立随机receipt仅经工具结果提供，续轮结构化JSON完整返回；没有执行真实工具。检查的是机器数据与协议，不以回答措辞判断语义质量。

客户端未发送缓存TTL时，响应回显 `prompt_cache_options.ttl: 12h`，证实该网关采用了部署方默认值。另一次直接原生SDK请求显式传入 `prompt_cache_options.ttl: 30m` 并得到30m回显，没有被网关默认覆盖。后者只建立SDK/网关字段保全，不表示当前 Dominds 团队参数已开放TTL或输出token override。

OpenAI官方默认是30m，12h是此网关策略；两种设置的cache-write费率不同。小于1,024可见输入token的请求不会因此证明缓存命中；本次没有发送长prompt测试cache-write、命中率或节费。见[官方prompt caching文档](https://developers.openai.com/api/docs/guides/prompt-caching)。

LTSP侧按网关request ID独立读回日志，确认实际provider/model、usage、成功状态、无retry/fallback及正文隐藏。完整目录快照、请求/响应、初次夹具错误与执行范围保存在[联合验收记录](../tests/audits/2026-10-31-ltsp-openai.json)。记录中的短请求不证明长上下文、长期缓存保留、模型回答质量、所有130模型或吞吐限额。
