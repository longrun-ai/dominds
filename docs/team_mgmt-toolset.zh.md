# 团队管理工具集（`team_mgmt`）

英文版：[English](./team_mgmt-toolset.md)

本文档指定了一个专用的**团队管理工具集**，其唯一职责是管理 rtws（运行时工作区）`.minds/` 下的"心智"配置文件（团队名单、LLM 提供商和智能体心智文件），而不授予广泛的运行时工作区访问权限。

> 历史说明：运行时/手册入口现已统一为
> `man({ "toolsetId": "team_mgmt" })`，它才是当前权威的团队管理手册入口。

外部仓库根目录是 **rtws**（运行时工作区）。以下所有路径均相对于 rtws 根目录。

## 动机

我们希望有一种安全的方式让"团队管理者"智能体（通常是影子成员 `fuxi`）能够：

- 创建/更新 `.minds/team.yaml`（团队名单 + 权限 + 工具集）
- 创建/更新 `.minds/llm.yaml`（覆盖默认值的 LLM 提供商定义）
- 创建/更新 `.minds/mcp.yaml`（注册动态工具集的 MCP 服务器定义）
- 创建/更新 `.minds/team/<member>/{persona,knowhow,pitfalls}.md`（智能体心智）

同时，我们**不希望**赋予该智能体完整的 rtws 读写权限（例如 `ws_mod` 工具集 + 无限制的 `read_dirs`/`write_dirs`），因为：

- 编辑 `.minds/team.yaml` 本质上是一个**权限提升面**（它控制工具可用性和目录权限）
- 编辑 `.minds/llm.yaml` 可以更改网络目标和模型/提供商行为
- "引导"团队管理者应该能够在无法更改产品代码、`.dialogs/` 等的情况下配置团队

## 迁移计划（替换传统的内置团队管理者知识）

本文档是新的 `team_mgmt` 工具集的**设计规范**。这不是我们应该在运行时让智能体"查阅"的内容。

相反，运行时团队管理的"单一事实来源"应该是 `man({ "toolsetId": "team_mgmt" })` 的输出。

历史上，部分指导内容位于 `dominds/` 源代码树中的传统内置"团队管理者"心智集中。该传统内置内容正在被移除。运行时的"单一事实来源"应该是 `man({ "toolsetId": "team_mgmt" })` 的输出。

计划变更：

- 通过通用 `man` 工具的 `man({ "toolsetId": "team_mgmt" })` 入口承载团队管理主题（文件格式、工作流、安全性）
- 移除传统的内置指导以避免重复。如果保留任何存根，必须指向 `man({ "toolsetId": "team_mgmt" })`（而不是本文档）

理由：

- 该手册与工具行为版本化，因此保持准确
- 框架源代码树不应是团队配置格式被解释的"主要"地方。每个 rtws 可能具有不同的策略和默认值

### 本文档的粒度边界（重要）

- 本文档只负责说明稳定的设计目标、概念边界、职责划分，以及为什么这样设计。
- 本文档**不应**承载过细的运行时规格，例如精确的注入顺序、当前回退规则、完整 topic 列表、动态枚举结果、逐字段渲染细节、或会随实现演进而频繁变化的 authoring 细则。
- 这类“当前实现到底怎么做”的信息，应统一以下列入口为准：
  - `man({ "toolsetId": "team_mgmt" })`
  - 对应实现代码与运行时校验
- 如果设计文档与运行时手册在“当前行为”上发生冲突，应默认以运行时手册为准，并回头修正文档，而不是让读者继续把设计文档当成运行时规格书。

## 当前问题陈述

在典型部署中，我们通过通用 rtws 文件工具拒绝直接的 `.minds/` 访问：

- `fs` / `txt`（`list_dir`、`read_file`、`overwrite_entire_file`，……）

这对于"普通"智能体来说是合理的，但它阻止了团队管理者完成其工作。

## 目标 / 非目标

**目标**

- 启用受信任的团队管理者仅管理 `.minds/` 配置面
- 提供一个单一的"手册"工具来教授正确的文件格式和安全的最佳实践
- 保持工具行为可预测并将路径静态作用域限制为 `.minds/`（不在该子树之外进行智能自动发现）

**非目标**

- 替换现有的 `ws_read` / `ws_mod` 工具集
- 提供跨仓库的通用文件编辑
- 默认让 `.minds/` 可广泛写入

## 提议的 `team_mgmt` 工具集

`team_mgmt` 工具集镜像 `fs`/`txt` 的最小子集，但**硬作用域**所有操作到 `.minds/` 并拒绝任何外部操作。

### 命名约定（人类 / UI）

- **工具**使用 `snake_case`（下划线分隔）作为工具 ID（例如 `team_mgmt_validate_team_cfg`）。避免为工具 ID 使用 `kebab-case` 别名；如果 UX 需要更友好的标签，将其视为仅展示层。
- **队友**使用 `kebab-case`（连字符分隔）或"互联网名称"（点分隔）。
- 这只是文档/UI/可读性的约定；不要通过验证或其他技术机制强制执行。

### 工具

推荐工具（名称是建议；使用 `snake_case` 以匹配现有工具）：

| 工具名称                               | 基于  | 用途                                                        | 默认白名单作用域 |
| -------------------------------------- | ----- | ----------------------------------------------------------- | ---------------- |
| `team_mgmt_list_dir`                   | `fs`  | 列出 `.minds/` 下的目录/文件                                | `.minds/**`      |
| `team_mgmt_read_file`                  | `txt` | 读取 `.minds/` 下的文本文件                                 | `.minds/**`      |
| `team_mgmt_create_new_file`            | `txt` | 在 `.minds/` 下创建新文件（允许空内容；拒绝覆写）           | `.minds/**`      |
| `team_mgmt_overwrite_entire_file`      | `txt` | 覆写 `.minds/` 下的现有文件（受保护的异常路径）             | `.minds/**`      |
| `team_mgmt_prepare_file_range_edit`    | `txt` | 准备在 `.minds/` 下进行单文件行范围编辑（返回差异 hunk id） | `.minds/**`      |
| `team_mgmt_prepare_file_append`        | `txt` | 准备在 `.minds/` 下进行追加到 EOF 编辑（返回差异 hunk id）  | `.minds/**`      |
| `team_mgmt_prepare_file_insert_after`  | `txt` | 准备在 `.minds/` 下的锚点后插入（返回差异 hunk id）         | `.minds/**`      |
| `team_mgmt_prepare_file_insert_before` | `txt` | 准备在 `.minds/` 下的锚点前插入（返回差异 hunk id）         | `.minds/**`      |
| `team_mgmt_prepare_file_block_replace` | `txt` | 准备在 `.minds/` 下的锚点之间进行块替换（返回差异 hunk id） | `.minds/**`      |
| `team_mgmt_apply_file_modification`    | `txt` | 通过 hunk id 在 `.minds/` 下应用计划的修改                  | `.minds/**`      |
| `team_mgmt_mk_dir`                     | `fs`  | 在 `.minds/` 下创建目录                                     | `.minds/**`      |
| `team_mgmt_move_file`                  | `fs`  | 移动/重命名 `.minds/` 下的文件                              | `.minds/**`      |
| `team_mgmt_move_dir`                   | `fs`  | 移动/重命名 `.minds/` 下的目录                              | `.minds/**`      |
| `team_mgmt_rm_file`                    | `fs`  | 删除 `.minds/` 下的文件                                     | `.minds/**`      |
| `team_mgmt_rm_dir`                     | `fs`  | 删除 `.minds/` 下的目录                                     | `.minds/**`      |
| `team_mgmt_validate_priming_scripts`   | 新建  | 校验 `.minds/priming/**.md` 的路径约束与脚本格式            | `.minds/**`      |
| `team_mgmt_validate_team_cfg`          | 新建  | 验证 `.minds/team.yaml` 并将问题发布到问题面板              | `.minds/**`      |
| `man({ "toolsetId": "team_mgmt" })`    | 内置  | `team_mgmt` 工具集的手册入口（见下文）                      | N/A              |

注意：

- 包括完整的 `.minds/` 生命周期（创建、更新、重命名/移动、删除）。团队管理者必须能够纠正错误并从意外损坏中恢复（包括其他工具引入的损坏）
- 对 `.minds/priming/**` 进行任何更改后，团队管理者应运行 `team_mgmt_validate_priming_scripts({})`，确保启动脚本路径和格式都可被系统解析
- 对 `.minds/team.yaml` 进行任何更改后，团队管理者应运行 `team_mgmt_validate_team_cfg({})` 以确保检测并暴露所有错误（并避免静默忽略损坏的成员配置）
- 路径处理应该严格：
  - 拒绝绝对路径
  - 拒绝包含 `..` 的路径
  - 拒绝规范化后解析到 `.minds/` 之外的任何路径
- 优先使用显式白名单而非" rtws 中的任何内容"
- 对于 `team_mgmt`，该显式白名单是 `.minds/**`（包括 `.minds/memory/**`），以便团队管理者可以修复其他工具造成的意外损坏（即使 `.minds/memory/**` 已有专用的 `personal_memory` / `team_memory` 工具供正常使用）
- 反过来，普通通用文件工具对 `.minds/**` / `*.tsk/**` 的拒绝是**系统内置硬约束**，不是需要在 `team.yaml` 里重复书写的常规 deny 项。只有额外业务约束才需要显式写入 `no_read_dirs` / `no_write_dirs`
- 需要显式的 `.minds/...` 路径并验证它们；不支持像 `team.yaml` 这样的"隐式作用域"路径

### 为什么需要专用工具集（而不是仅 `read_dirs` / `write_dirs`）？

`read_dirs` / `write_dirs` 仍然很有价值，但它们配置在 `.minds/team.yaml` 中，在引导期间可能不存在。专用的 `team_mgmt` 工具集：

- 让团队管理者能够从"零状态"安全地创建 `.minds/team.yaml`
- 即使成员的目录允许/拒绝列表为空，也保持作用域边界
- 便于授予临时智能体仅团队管理能力而无需完整的 rtws 访问

## 通过 `man({ "toolsetId": "team_mgmt" })` 查看团队手册

我们需要单一的聊天内手册工具，以便团队管理者能够可靠地自助指导，而无需阅读源代码。

### 命令形状

- `man({ "toolsetId": "team_mgmt" })` → 显示简短索引（主题）
- `man({ "toolsetId": "team_mgmt", "topics": ["topics"] })` → 列出主题
- `man({ "toolsetId": "team_mgmt", "topics": ["llm"] })` → 如何管理 `.minds/llm.yaml`（+ 模板）
- `man({ "toolsetId": "team_mgmt", "topics": ["llm", "builtin-defaults"] })` → 显示内置提供商/模型（来自默认值）
- `man({ "toolsetId": "team_mgmt", "topics": ["mcp"] })` → 如何管理 `.minds/mcp.yaml`（+ 模板）
- `man({ "toolsetId": "team_mgmt", "topics": ["mcp"] })` → 如何管理 `.minds/mcp.yaml`（传输、env/headers、工具白名单/黑名单、命名转换、热重载、租赁）
- `man({ "toolsetId": "team_mgmt", "topics": ["mcp", "troubleshooting"] })` → 常见 MCP 故障模式及如何恢复
- `man({ "toolsetId": "team_mgmt", "topics": ["team"] })` → 如何管理 `.minds/team.yaml`（+ 模板）
- `man({ "toolsetId": "team_mgmt", "topics": ["team", "member-properties"] })` → 列出支持的成员字段及其含义
- `man({ "toolsetId": "team_mgmt", "topics": ["minds"] })` → 如何管理 `.minds/team/<id>/*.md`（persona/knowhow/pitfalls）
- `man({ "toolsetId": "team_mgmt", "topics": ["skills"] })` → 如何管理 `.minds/skills/*`（skills 的注入位置、口吻、标题层级、迁移边界）
- `man({ "toolsetId": "team_mgmt", "topics": ["priming"] })` → 如何管理 `.minds/priming/*` 启动脚本（格式、维护、复用）
- `man({ "toolsetId": "team_mgmt", "topics": ["env"] })` → 如何管理 `.minds/env.*.md`（运行环境提示的注入位置、口吻、标题层级）
- `man({ "toolsetId": "team_mgmt", "topics": ["toolsets"] })` → 查看当前安装/rtws 下实际可见的 toolsets 及常见授权模式
- `man({ "toolsetId": "team_mgmt", "topics": ["permissions"] })` → `read_dirs`/`write_dirs` 和拒绝列表如何工作
- `man({ "toolsetId": "team_mgmt", "topics": ["troubleshooting"] })` → 常见故障模式及如何恢复

该手册应接受**多个**`topics` 条目（简单的主题"路径"）；工具应选择最具体的匹配，并在需要时回退到最近的父主题。

如果 UX 需要比 `man` 更友好的标签，将其视为仅展示层；规范的运行时入口保持为 `man({ "toolsetId": "team_mgmt" })`。

## 手册覆盖要求（传统覆盖）

作为从传统内置团队管理者知识文件迁移的一部分，手册必须至少涵盖以前驻留在那里的信息：

- `!team`：
  - 解释 `member_defaults`、`default_responder` 和 `members`（结构概述）
  - 通过 `!team !member-properties` 包含显式的"成员配置属性"参考（字段表）：
    - `name`、`icon`、`gofor`、`provider`、`model`、`toolsets`、`tools`、`streaming`、`hidden`
    - `read_dirs`、`no_read_dirs`、`write_dirs`、`no_write_dirs`
- `!llm`：
  - 解释 `.minds/llm.yaml` 使用的提供商映射结构及其与 `.minds/team.yaml`（`provider` + `model` 键）的关系
  - 通过 `!llm !builtin-defaults` 提供"内置默认值"视图
    - 实现指导：在运行时从 `dominds/main/llm/defaults.yaml` 渲染此内容（或通过共享助手），而不是将静态块复制粘贴到代码中，这样它不会漂移
- `!mcp`：
  - 解释 `.minds/mcp.yaml` 作为动态 MCP 工具集的来源
  - 解释 MCP 服务器如何映射到工具集（`<serverId>`）以及如何通过 `.minds/team.yaml` 授予这些工具集
  - 解释工具暴露控制（白名单/黑名单）和命名转换（前缀/后缀）
  - 解释密钥/env 接线模式和问题排查（问题 + 日志、重启、热重载语义）
- `!skills`：
  - 解释 `.minds/skills/*` 属于可复用的团队技能资产
  - 解释 skill 的职责边界：它是提示/指导资产，不是权限系统
  - 解释何时应继续保留为 skill，何时应升级为 app / toolset / teammates contract
- `!env`：
  - 解释 `.minds/env.*.md` 用于描述当前 rtws 的运行环境，而不是定义人格或复制仓库总规范
  - 解释它与 `persona/knowhow/pitfalls`、skills、priming 的分工边界
- `!toolsets`：
  - 解释当前可见 toolsets 包含内建 toolsets、已安装 apps 暴露的 toolsets、以及由 `.minds/mcp.yaml` 动态注册的 MCP toolsets
  - 解释为什么该主题必须以运行时动态视图为准，而不是在设计文档里维护一份静态名单

## 从 Dominds 安装动态加载（运行时资源）

在适当的情况下，手册应**动态加载**其"参考"内容自运行的 `dominds` 安装（即随附的后端交付的文件和注册表），而不是在以下位置复制该内容：

- `.minds/*`（rtws 保留状态），或
- 文档，或
- 工具实现中的硬编码字符串

这使手册在框架更改时保持准确，并避免文档漂移。

按主题推荐的来源：

- `man({ "toolsetId": "team_mgmt", "topics": ["llm", "builtin-defaults"] })`
  - 从运行时用于默认值的同一安装资源加载：`dominds/main/llm/defaults.yaml`（通过后端构建输出中的 `__dirname` 解析）
  - 优先重用 `LlmConfig.load()` 并格式化其合并视图，或添加一个返回"仅默认值"和"合并"提供商映射的助手
- `man({ "toolsetId": "team_mgmt", "topics": ["toolsets"] })`
  - 在运行时从内存中注册表加载（`dominds/main/tools/registry.ts` 中的 `listToolsets()` / `listTools()`），而不是维护单独的列表

### 为什么 `toolsets` 必须是动态主题

- `toolsets` 不是一份稳定、可写死在设计文档里的清单。
- 当前可见的 toolsets 由三部分共同决定：
  - 框架内建 toolsets
  - 当前安装的 Dominds apps 所暴露的 toolsets
  - `.minds/mcp.yaml` 中 `servers.<serverId>` 在运行时映射出来的 MCP toolsets
- 其中 MCP 部分天然是**动态的**：团队可以按 rtws 需要增删 server、调整命名、控制工具暴露；因此 toolset 集合会随当前安装状态与当前 rtws 配置而变化。
- 这样设计的原因，是把“能力发现”绑定到当前实际运行环境，而不是绑定到一份很快过时的静态文档：
  - 避免设计文档维护一份注定漂移的 toolset 名单
  - 避免读者误以为某个 MCP toolset 是框架内建常量
  - 让团队管理者面对的始终是“此刻这个安装与这个 rtws 真实可用的能力”
- 因此，设计文档只需要解释机制与原因；“当前有哪些 toolsets”应由运行时 `man(...topics:[\"toolsets\"])` 动态呈现。

将这些保持为**静态/手册文本**（而非动态加载）：

- 高级解释、最佳实践和"为什么"部分
- 模式摘要（例如成员字段表）。这些可以作为稳定的契约创作并在代码审查中验证；TypeScript 类型的运行时自省在构建后不可靠

## 管理 `.minds/priming/*`（启动脚本）

启动脚本目录：

- 个人：`.minds/priming/individual/<member-id>/<slug>.md`
- 团队共享：`.minds/priming/team_shared/<slug>.md`

核心原则：

- 启动脚本会映射为真实对话历史；它不是只读日志，而是可编辑的启动引导剧本。
- 其运行时语义不是 system prompt，而是“创建对话时先恢复 reminders，再把 records 尽可能回放成对话历史消息”。
- 因此内容口吻必须跟着 record 类型走：`human_text_record` 写成用户/诉请者对智能体说的话；`agent_words_record` 写成智能体已经说出口的话；`agent_thought_record` 仅适合非常克制地承载内部推理痕迹。
- `ui_only_markdown_record` 等部分技术 record 不会变成喂给模型的 chat message，因此不能拿它们充当主要行为引导。
- 外层结构应是“顶层 frontmatter + 多个 `### record <type>` 块”；不要再包一层 `# 启动脚本` / `## 历史` 这类装饰标题。
- 团队管理者应鼓励按业务场景维护脚本，并可直接增删改 assistant/user 消息内容。
- 允许完全重写脚本以匹配新的协作模式、质量标准和语言风格。

推荐格式：

- frontmatter（可选但推荐）：`title`、`applicableMemberIds` 等元数据。
- record 块（必填）：使用 `### record <type>`；具体内容放在对应的 markdown/json block 中。

维护建议：

- 用 slug 分层组织脚本（如 `release/webui/smoke-v1`），避免平铺和无语义命名。
- WebUI 导出的“当前 course 历史脚本”只作为起点，后续应由团队管理者审阅并重写成稳定剧本。

## 管理 `.minds/llm.yaml`

### 它做什么

`dominds` 从 `dominds/main/llm/defaults.yaml` 加载内置提供商定义，然后合并来自 `.minds/llm.yaml` 的 rtws 覆盖（rtws 键覆盖默认值）。见：

- `dominds/main/llm/client.ts`（`LlmConfig.load()`）
- `dominds/main/llm/defaults.yaml`（内置提供商目录）

### 文件格式（模板）

`.minds/llm.yaml` 必须包含一个 `providers` 对象。每个提供商由一个短标识符键入，用于 `.minds/team.yaml` 成员配置。

`apiType` 说明（常见值）：

- `openai`：使用 OpenAI **Responses API**（适用于 OpenAI 官方；需要 `/v1` 语义的 `responses` 端点）
- `openai-compatible`：使用 OpenAI **Chat Completions API**（适用于多数“OpenAI 兼容”第三方/代理；例如 Volcano Engine Ark `.../api/v3`）
  - **识图支持**：如果该 provider/model 支持 Chat Completions 的多模态输入，Dominds 会把工具输出里的图片（`func_result_msg.contentItems[].type=input_image`，来自 MCP 等工具）读取 artifact 后作为 `image_url` 形式喂给模型；不支持的 mimeType 会降级成文本提示。

```yaml
providers:
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
        context_window: 272K
```

最佳实践：

- 在 `.minds/llm.yaml` 中**不存储任何密钥**。使用 `apiKeyEnvVar` 和环境变量
- 只添加你真正需要的提供商。大多数设置应该依赖 `defaults.yaml`
- 保持模型键稳定；它们成为 `.minds/team.yaml` 中使用的 `model` 值

## 管理 `.minds/mcp.yaml`（MCP 服务器）

### 它做什么

`.minds/mcp.yaml` 将 MCP（模型上下文协议）服务器配置为一级工具来源。每个配置的服务器注册一个 Dominds **工具集**，名为 `<serverId>`，以及该工具集下的一组工具。

此文件在运行时**热重载**（无需服务器重启）。如果文件不存在，MCP 支持被禁用（不会注册动态 MCP 工具集）。

参考规范：

- MCP 行为和语义：[`mcp-support.zh.md`](./mcp-support.zh.md)

### 映射：服务器 → 工具集（以及如何授予）

- 服务器 ID `sdk_http` 注册工具集 `sdk_http`
- 要允许队友使用 MCP 工具，在 `.minds/team.yaml` 中授予工具集：

```yaml
members:
  alice:
    toolsets:
      - ws_read
      - sdk_http
```

注意：

- MCP 工具名称在所有工具集（内置 + MCP）中是全局的。冲突导致工具被跳过，应通过问题 + 日志暴露
- `mcp_admin` 是一个内置工具集，包含 `mcp_restart`（每个服务器最佳努力重启）
- 可选手册：可在 `.minds/mcp.yaml` 的 `servers.<serverId>.manual` 提供手册相关信息：
  - `contentFile`：正式 runtime 手册的 topic 文件目录前缀；`man({ "toolsetId": "<serverId>" })` 最终给 LLM 看的正文从这里加载
  - `content` / `sections`：补充给 `team_mgmt` MCP 章节看的 inline 团队管理说明（`sections` 支持 `[{ title, content }]` 或 `{ "<title>": "<content>" }`）
- 没有手册 **不代表** 该 toolset 不可用；这只表示团队管理文档覆盖不足。智能体应继续依据每个工具自身的 description/参数来使用。
- 建议团队管理者在 MCP 配置验证通过后：先精读该 server 暴露的每个工具说明，再与人类用户讨论本 rtws 的使用意图，然后把正式手册沉淀到 `manual.contentFile`；如仍需额外写团队管理层解释，再补 inline `content + sections`。
- 章节组织建议采用“半结构化”：可优先考虑 `何时使用`、`安全边界`、`不可用时业务处置` 这类高价值章节，但不要求所有 toolset 都照抄同一模板。应从真实业务目标出发，决定哪些章节需要展开、哪些只需一句话、哪些可以合并或改名成更贴切的标题。
- 对每个 MCP toolset，建议刻意写明“不可用时业务处置规约”，至少回答：
  - 当前 toolset 暂不可达时，是否必须找协调者/专员接手
  - 是否允许采用人工流程或其他工具链作为临时降级路径
  - 哪些业务动作在该 toolset 恢复前必须暂停，不能擅自继续

### 文件格式（模板）

```yaml
version: 1
servers:
  <serverId>:
    # 传输：stdio
    transport: stdio
    command: npx
    args: ['-y', '@playwright/mcp@latest']
    cwd: '.' # 可选；默认是 Dominds 进程 cwd
    env: {}

    # 传输：streamable_http
    # transport: streamable_http
    # url: http://127.0.0.1:3000/mcp
    # headers: {}
    # sessionId: '' # 可选

    # 工具暴露控制
    tools:
      whitelist: [] # 可选
      blacklist: [] # 可选

    # 工具名称转换
    transform: [] # 可选

    # 可选：手册相关信息
    manual:
      contentFile: ".minds/manuals/<serverId>" # 正式 runtime 手册（供 man({ "toolsetId": "<serverId>" }) 读取）
      content: "该 MCP toolset 的用途说明"
      sections:
        - title: "何时使用"
          content: "当 ... 时使用"
        Guardrails: "避免 ..."
        UnavailablePolicy: "若暂不可达：先找 @coordinator 判断是否改走降级路径；只有 ... 可替代，涉及 ... 必须暂停等待恢复。"
```

### 工具暴露控制（白名单 / 黑名单）

使用 `tools.whitelist` / `tools.blacklist` 来减少暴露的工具表面并避免 UI 混乱。模式使用 `*` 通配符并应用于**原始 MCP 工具名称**（在转换之前），因此过滤器即使以后命名转换更改也保持稳定。

### 命名转换（前缀 / 后缀）

MCP 服务器通常导出简短/常见的工具名称（`open`、`search`、`list`，……）。使用转换来避免全局冲突并使工具名称可识别：

```yaml
transform:
  - prefix: 'playwright_'
  - suffix: '_mcp'
```

### Env 和 headers 接线

对于 secrets，优先从主机环境复制：

```yaml
env:
  MCP_TOKEN:
    env: MY_LOCAL_MCP_TOKEN
```

对于 `streamable_http`，`headers` 支持字面量字符串、env 映射，以及带前缀的 env 映射：

```yaml
headers:
  Authorization:
    prefix: 'Bearer '
    env: MY_LOCAL_MCP_TOKEN
```

### 操作行为（热重载 + 最近已知良好状态）

- 配置编辑应无需重启即可应用
- 如果服务器更新失败（生成/连接/模式/名称冲突等），系统应保持该服务器的**最近已知良好**工具集注册，并暴露描述失败的问题
- 删除 `.minds/mcp.yaml` 应取消注册所有 MCP 派生的工具集/工具并自动清除相关的 MCP 问题

## 管理 `.minds/team.yaml`

### 它做什么

`.minds/team.yaml` 定义：

- 团队名单（`members`）
- 应用于所有成员的默认值（`member_defaults`）
- 工具可用性（`toolsets` / `tools`）
- rtws 文件工具的目录访问控制（`read_dirs`、`write_dirs`、`no_*`）

该文件由 `dominds/main/team.ts` 中的 `Team.load()` 加载。如果文件不存在，运行时引导默认团队（今天它创建影子成员 `fuxi` + `pangu`）。

### 文件格式（模板）

```yaml
member_defaults:
  provider: codex
  model: gpt-5.2
  toolsets:
    - ws_read
    - personal_memory

default_responder: fuxi

members:

说明：上面的普通成员默认示例**不要**再额外写 `no_read_dirs` / `no_write_dirs` 去重复声明 `.minds/**` 拒绝。那是运行时内置边界，不是常规样板；只有要表达超出内置边界的额外 deny 规则时，才应显式写这些字段。
  # 示例显在成员（推荐）：至少定义一个非隐藏的响应者用于日常工作
  dev:
    name: Dev
    icon: '🧑‍💻'
    toolsets:
      - ws_mod
      - os
    streaming: true
```

重要说明：

- `member_defaults.provider` 和 `member_defaults.model` 是必需的（见 `dominds/main/team.ts` 中的验证和 `dominds/main/server/api-routes.ts` 中的服务器错误消息）
- 成员对象使用**原型回退**到 `member_defaults`（见 `dominds/main/team.ts` 中的 `Object.setPrototypeOf`）。省略的属性自动继承默认值
- 目录模式由 `dominds/main/access-control.ts` 中的 `matchesPattern()` 评估：
  - 模式表现为"目录作用域"，并支持 `*` 和 `**`
  - 拒绝列表（`no_*`）在允许列表（`*_dirs`）之前检查

最佳实践：

- 使 `member_defaults` 保守。按成员授予额外的工具/目录
- 优先使用工具集而不是单独枚举工具，除非你需要一次性工具
- 平台说明：Windows 运行时不会注册 `codex_inspect_and_patch_tools`；在 Windows 主机上的 `.minds/team.yaml` 中不要授予该工具集
- 保持 `.minds/team.yaml` 的所有权严格；只有团队管理者应该能够编辑它
- 避免在 `team.yaml` 中重复内置约束：
  - `*.tsk/**`（封装的差遣牒任务包）对所有通用文件工具被硬性拒绝
  - `.minds/**` 对通用文件工具被硬性拒绝；只有专用的 `team_mgmt` 工具集可以访问它
    - 只有当你需要额外的显式性时才将这些放入 `no_*`；无论如何都会强制执行

## 管理 `.minds/team/<member>/*.md`（智能体心智）

运行时在每次对话开始时会读取该成员的 `persona.*.md` / `knowhow.*.md` / `pitfalls.*.md` 资产。

- 具体语言文件选择、回退规则、注入顺序与其它 authoring 细则，请以 `man({ "toolsetId": "team_mgmt", "topics": ["minds"] })` 为准。

见 `dominds/main/minds/load.ts`（`readAgentMind()`）。

写法约束（重要）：

- `persona.*.md` 会被拼进该成员的 `role=system` 提示，因此默认应该直接写给“这个成员智能体本人”。
- 也就是说，`persona.*.md` 应优先使用第二人称“你”来规定职责边界、工作方式与交付标准。
- 不要把 `persona.*.md` 写成第三人称人物简介，不要把它当成给团队管理员/人类读者的说明书，也不要使用“祂”这类旁白口吻。
- `knowhow.*.md` / `pitfalls.*.md` 也同样会进入该成员的系统提示，分别落在 `## 经验知识` / `## 避坑指南`。`knowhow` 应偏向正向的知识与经验沉淀，例如稳定事实、索引、约定、判断依据、已验证有效的方法；`pitfalls` 应偏向负向的教训与避坑规则，例如哪些坑不要再踩、哪些信号意味着风险、遇到 X 时先做 Y 不要做 Z。两者都应以“帮助该成员当下工作”为目标，而不是面向旁观者写注释。
- 迁移规则：rtws 成员文件现已优先读取 `knowhow/pitfalls`，只有在新文件名不存在时，才回退兼容旧的 `knowledge/lessons`。一旦新文件名存在，就只注入新文件内容，旧文件内容会被忽略。builtin mind 只认 canonical 文件名，不读取旧别名。请尽快完成改名迁移；过渡期之后，未来版本将不再识别 `knowledge/lessons`。
- 标题层级也要按 system prompt 模板来写：系统外层已经自动提供 `## 角色设定` / `## 经验知识` / `## 避坑指南`，所以正文通常应从 `###` 或普通 bullet 开始，不要再写 `#` / `##`，也不要把文件名或这些章节名重复当标题。

建议的结构：

```
.minds/
  team.yaml
  llm.yaml
  team/
    fuxi/
      persona.md
      knowhow.md
      pitfalls.md
    pangu/
      persona.md
      knowhow.md
      pitfalls.md
```

## 管理 `.minds/skills/*`（技能资产）

设计层面的定位：

- `.minds/skills/*` 用来承载可复用的团队技能/操作指导资产。
- 它的重点是“什么时候用、怎么做、边界是什么”，而不是授予权限。
- 如果某个 skill 需要脚本、专有工具、MCP、外部二进制、或稳定复用的执行能力，那么设计上通常更适合上升为 Dominds app / toolset / teammates contract，而不应只停留在 markdown 文案。
- 设计文档在这里仅说明边界与迁移方向；具体文件命名、注入位置、标题层级、语言文件选择等，以运行时 `man({ "toolsetId": "team_mgmt", "topics": ["skills"] })` 为准。

## 管理 `.minds/env.*.md`（运行环境说明）

设计层面的定位：

- `.minds/env.*.md` 用来描述“当前 rtws 运行环境”的稳定背景信息，帮助成员理解所处环境。
- 它不应承担 persona 定义、skill 教程、团队制度大全、或仓库全局规范汇总的职责。
- 这类内容按分工应分别落在 `persona/knowhow/pitfalls`、skills、priming、或仓库自己的规范文件中。
- 设计文档在这里仅强调用途边界；具体注入位置、回退规则、标题建议等，以运行时 `man({ "toolsetId": "team_mgmt", "topics": ["env"] })` 为准。

## 引导策略：影子成员引导

初始引导的首选行为：

- 影子成员 `fuxi` 实例应该获得 `team_mgmt`（和手册工具），而不是广泛的 `ws_mod`
- 影子成员 `pangu` 实例应该获得广泛的 rtws 工具集（例如 `ws_read`、`ws_mod`、`os`），但不获得 `team_mgmt`
- 在创建 `.minds/team.yaml` 后，团队定义成为事实来源

这避免了需要授予完整的 rtws 访问权限来配置团队。

## 问题排查

- **"缺少必需的 provider/model"**：确保 `.minds/team.yaml` 有 `member_defaults.provider` 和 `member_defaults.model`
- **找不到提供商**：确保 `.minds/team.yaml` 的 `provider` 键存在于合并的提供商配置中（`dominds/main/llm/defaults.yaml` + `.minds/llm.yaml`）
- **编辑 `.minds/` 时访问被拒绝**：通用文件工具的预期行为；使用 `team_mgmt` 工具
- **MCP 工具在工具视图中不可见**：
  - 确认 `.minds/mcp.yaml` 存在且有效
  - 打开**问题**并查找 MCP 相关错误
  - 确认队友在 `.minds/team.yaml` 中被授予了相关的 `<serverId>` 工具集
- **MCP 服务器持续 (re)load 失败**：
  - 检查问题详细信息（缺少 env 变量、无效的工具名称、冲突、连接错误）
  - 修复配置后，使用 `mcp_admin` 中的 `mcp_restart` 进行每个服务器的最佳努力重启
