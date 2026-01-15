## 团队定义（Team Definition）

团队定义位于 `.minds/team.yaml`。该文件配置工作区的团队组成、每位成员的角色、LLM 的 provider/model、工具集（toolsets）、以及所有智能体的访问权限（读写白/黑名单等）。

### 结构概览

`team.yaml` 主要包含三部分：

```yaml
member_defaults: { ... } # 应用于所有成员的默认设置
default_responder: name # 默认响应成员（未指定 agentId 时由谁处理）
members: { ... } # 各成员的个性化配置
```

### 成员配置属性

每个成员支持如下属性：

| 属性            | 类型    | 说明                                                             |
| --------------- | ------- | ---------------------------------------------------------------- |
| `name`          | string  | 成员显示名                                                       |
| `icon`          | string  | UI 展示用标识                                                    |
| `gofor`         | list    | 该成员负责的职责/工作重点                                        |
| `provider`      | string  | `.minds/llm.yaml` 中定义的 provider key                          |
| `model`         | string  | provider 下的 model 名称                                         |
| `toolsets`      | list    | 能力组：`memory`, `ws_read`, `ws_mod`, `team_memory`             |
| `tools`         | list    | 具体工具：`shell_cmd`, `git`, `stop_daemon`, `get_daemon_output` |
| `streaming`     | boolean | 是否启用 streaming（某些工具/输出边界依赖 streaming）            |
| `read_dirs`     | list    | 允许读取的目录（glob patterns）                                  |
| `no_read_dirs`  | list    | 显式禁止读取的目录（优先级更高）                                 |
| `write_dirs`    | list    | 允许写入的目录（glob patterns）                                  |
| `no_write_dirs` | list    | 显式禁止写入的目录（优先级更高）                                 |

## LLM 配置（LLM Configuration）

### 内置默认值（Builtin Defaults）

项目内已经提供了一些常见 provider/model 的默认示例：

```yaml
providers:
  codex:
    name: Codex (ChatGPT)
    apiType: codex
    baseUrl: https://chatgpt.com/backend-api/
    apiKeyEnvVar: CODEX_HOME
    tech_spec_url: https://platform.openai.com/docs/api-reference/responses
    api_mgmt_url: https://chatgpt.com/
    models:
      gpt-5.2-codex:
        name: GPT-5.2 Codex
        context_length: 272000
        input_length: 272000
        output_length: 32768
        context_window: '272K'
      gpt-5.2:
        name: GPT-5.2
        context_length: 272000
        input_length: 272000
        output_length: 32768
        context_window: '272K'
  minimaxi.com-coding-plan:
    name: MiniMax CN Coding Plan
    apiType: anthropic
    baseUrl: https://api.minimaxi.com/anthropic
    apiKeyEnvVar: MINIMAX_CN_CP_API_KEY
    tech_spec_url: https://platform.minimaxi.com/document/guides
    api_mgmt_url: https://platform.minimaxi.com/
    models:
      MiniMax-M2.1:
        name: MiniMax M2.1
        context_length: 204800
        input_length: 204800
        output_length: 8192
        context_window: '204K'
      MiniMax-M2:
        name: MiniMax M2
        context_length: 204800
        input_length: 204800
        output_length: 8192
        context_window: '204K'
  minimaxi.com:
    name: MiniMax CN
    apiType: anthropic
    baseUrl: https://api.minimaxi.com/anthropic
    apiKeyEnvVar: MINIMAX_CN_API_KEY
    tech_spec_url: https://platform.minimaxi.com/document/guides
    api_mgmt_url: https://platform.minimaxi.com/
    models:
      MiniMax-M2.1:
        name: MiniMax M2.1
        context_length: 204800
        input_length: 204800
        output_length: 8192
        context_window: '204K'
      MiniMax-M2:
        name: MiniMax M2 Stable
        context_length: 204800
        input_length: 204800
        output_length: 8192
        context_window: '204K'
  minimax.io-coding-plan:
    name: MiniMax International Coding Plan
    apiType: anthropic
    baseUrl: https://api.minimax.io/anthropic
    apiKeyEnvVar: MINIMAX_CP_API_KEY
    tech_spec_url: https://platform.minimax.io/docs/api-reference
    api_mgmt_url: https://platform.minimax.io/
    models:
      MiniMax-M2.1:
        name: MiniMax M2.1
        context_length: 204800
        input_length: 204800
        output_length: 8192
        context_window: '204K'
      MiniMax-M2:
        name: MiniMax M2
        context_length: 204800
        input_length: 204800
        output_length: 8192
        context_window: '204K'
  minimax.io:
    name: MiniMax International
    apiType: anthropic
    baseUrl: https://api.minimax.io/anthropic
    apiKeyEnvVar: MINIMAX_API_KEY
    tech_spec_url: https://platform.minimax.io/docs/api-reference
    api_mgmt_url: https://platform.minimax.io/
    models:
      MiniMax-M2.1:
        name: MiniMax M2.1
        context_length: 204800
        input_length: 204800
        output_length: 8192
        context_window: '204K'
      MiniMax-M2:
        name: MiniMax M2 Stable
        context_length: 204800
        input_length: 204800
        output_length: 8192
        context_window: '204K'
  bigmodel:
    name: BigModel
    apiType: anthropic
    baseUrl: https://open.bigmodel.cn/api/anthropic
    apiKeyEnvVar: ZHIPUAI_API_KEY
    tech_spec_url: https://docs.bigmodel.cn/
    api_mgmt_url: https://open.bigmodel.cn/usercenter/apikeys
    models:
      glm-4.7:
        name: GLM-4.7
        context_length: 200000
        input_length: 200000
        output_length: 8192
        context_window: '200K'
      glm-4.6:
        name: GLM-4.6
        context_length: 200000
        input_length: 200000
        output_length: 8192
        context_window: '200K'
      glm-4.5:
        name: GLM-4.5
        context_length: 128000
        input_length: 128000
        output_length: 8192
        context_window: '128K'
      glm-4.5-air:
        name: GLM-4.5-Air
        context_length: 128000
        input_length: 128000
        output_length: 8192
        context_window: '128K'
  ark-coding-plan:
    name: Ark Coding Plan
    apiType: anthropic
    baseUrl: https://ark.cn-beijing.volces.com/api/coding
    apiKeyEnvVar: ARK_API_KEY
    tech_spec_url: https://api.volcengine.com/api-docs/view?serviceCode=ark&version=2024-01-01
    api_mgmt_url: https://console.volcengine.com/ark
    models:
      doubao-seed-code-preview-latest:
        name: Doubao Seed Code Preview
        context_length: 256000
        input_length: 256000
        output_length: 8192
        context_window: '256K'
        optimization: 专为Agentic Coding任务优化
  ark:
    name: Ark
    apiType: openai
    baseUrl: https://ark.cn-beijing.volces.com/api/v3
    apiKeyEnvVar: ARK_API_KEY
    tech_spec_url: https://api.volcengine.com/api-docs/view?serviceCode=ark&version=2024-01-01
    api_mgmt_url: https://console.volcengine.com/ark
    models:
      deepseek-v3-2-251201:
        name: DeepSeek-V3.2
        context_length: 128000
        input_length: 96000
        output_length: 8192
        context_window: '128K'
  openai:
    name: OpenAI
    apiType: openai
    baseUrl: https://api.openai.com/v1
    apiKeyEnvVar: OPENAI_API_KEY
    tech_spec_url: https://platform.openai.com/docs
    api_mgmt_url: https://platform.openai.com/api-keys
    models:
      gpt-5.2:
        name: GPT-5.2
        context_length: 272000
        input_length: 272000
        output_length: 32768
        context_window: '272K'
      gpt-5.2-codex:
        name: GPT-5.2 Codex
        context_length: 272000
        input_length: 272000
        output_length: 32768
        context_window: '272K'
```

你也可以在 `.minds/llm.yaml` 中用同样的格式配置更多自定义的 LLM providers。
