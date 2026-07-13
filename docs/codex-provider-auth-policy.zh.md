# Codex Provider 认证策略

## 确定的产品边界

Dominds 内置 `apiType: codex` provider **只支持 ChatGPT 托管 OAuth 文件认证**。运行时最终只放行 `auth_mode: chatgpt`，并要求 `auth.json` 具有可刷新的 `id_token`、`access_token`、`refresh_token` 和 ChatGPT account ID。

这是有意窄于 `codex-rs` 的产品边界，不是尚未完成的自动兼容清单。`codex-auth` 可以继续识别 `codex-rs` 的完整认证契约，以便给出准确诊断；但识别某种认证方式，不代表 Dominds Codex provider 可以使用它发送请求。

当前处理如下：

| 检测到的认证方式                              | Dominds Codex provider 行为                  |
| --------------------------------------------- | -------------------------------------------- |
| 完整、可刷新的 `chatgpt` 托管 OAuth 文件认证  | 放行                                         |
| 临时认证仓中的 `chatgpt`                      | 拒绝                                         |
| 缺少必要 token 或 account ID 的 `chatgpt`     | 拒绝；要求重新执行 Codex ChatGPT 文件登录    |
| `chatgptAuthTokens`（无论能否刷新）           | 拒绝                                         |
| `apikey`                                      | 拒绝                                         |
| 外部 `headers`                                | 拒绝                                         |
| `agentIdentity`                               | 拒绝                                         |
| `personalAccessToken`                         | 拒绝                                         |
| `bedrockApiKey`                               | 拒绝                                         |
| `CODEX_ACCESS_TOKEN`（PAT 或 Agent Identity） | 拒绝；该变量会覆盖持久化认证，必须先取消设置 |

启动时检测到不支持的认证，会在创建请求客户端之前拒绝。运行期间若凭证在刷新或 401 恢复中变成其他模式、来自临时认证仓，或仍为 `chatgpt` 但已不完整，会在任何重试请求发出前再次拒绝。此类本地认证策略错误使用稳定错误码 `DOMINDS_CODEX_PROVIDER_AUTH_POLICY`，属于不可重试失败；不允许根据上游错误回退、反复重试同一认证路径，也不允许静默改用其他凭证。

## 需要其他认证方式时

如果目标服务提供 OpenAI Responses API，请配置自定义 `apiType: openai` provider，并使用它自己的认证环境变量。例如：

```yaml
providers:
  my_openai_responses:
    name: My OpenAI Responses API
    apiType: openai
    baseUrl: https://api.openai.com/v1
    apiKeyEnvVar: MY_OPENAI_API_KEY
    models:
      gpt-5.6-sol:
        name: GPT-5.6 Sol
        optimal_max_tokens: 600000
        critical_max_tokens: 922000
        caution_remediation_cadence_generations: 10
        context_length: 1050000
        input_length: 1050000
        output_length: 128000
        context_window: '1.05M'
```

如果 `apiType: openai` 不能覆盖所需认证流程，请在 [Dominds issues](https://github.com/longrun-ai/dominds/issues) 提交 feature request；不要把新认证方式顺手接入 Codex provider。

## 与 `codex-rs` 对齐时的默认规则

以后同步 `codex-rs` 认证契约时，默认必须保留本策略：

1. 更新 `codex-auth` 对新契约和新认证方式的解析、类型及诊断。
2. 在 Dominds Codex provider 的请求边界继续只放行完整、可刷新且来自文件的托管 `chatgpt` OAuth。
3. 对任何新认证方式在发送 HTTP 请求前响亮拒绝，并保留自定义 OpenAI Responses API provider / feature request 指引。
4. 同步更新代码注释、本文档和覆盖全部认证分支的回归测试。
5. 只有经过明确的 Dominds 产品决策，才能扩大 Codex provider 的认证范围；“上游已经支持”本身不是扩大范围的理由。
