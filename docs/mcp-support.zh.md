# MCP 支持（`.minds/mcp.yaml`）

本文档规范了 Dominds 如何将 MCP（Model Context Protocol）服务器作为一级工具来源进行支持，**除了**任何现有的/遗留的基于 JSON 的 MCP 配置格式之外。

仓库根目录是 **rtws**（运行时工作区）。以下所有路径均相对于 rtws 根目录。

## 状态（当前代码）

在此工作区中当前 Dominds 实现的 MCP 已实现（使用官方 MCP TypeScript SDK）：

- `.minds/mcp.yaml` 加载器，支持强制热重载。
- MCP 衍生的工具/工具集注册到现有的全局工具（集）注册表。
- 支持的传输方式：`stdio` 和 `streamable_http`（SSE 传输不支持作为独立的配置选项）。
- 工作区问题通过 WebUI（问题药丸+面板）呈现，用于 MCP 和 LLM 提供者的拒绝。

本文档仍然是行为和语义的权威设计/规范。

## 相关现有原语（工具如今如何工作）

MCP 支持应该通过组合现有原语来实现，而不是发明一个并行系统：

- Dominds 工具仅限函数工具（`FuncTool`）（见 `dominds/main/tool.ts`）。
  - 注意："tellask" 保留用于队友 tellask / 对话编排，不是工具类型。
- 工具和工具集通过 `registerTool` / `registerToolset` 在 `dominds/main/tools/registry.ts` 中全局注册（内置工具在模块初始化期间注册）。
- 团队成员在运行时通过 `Team.Member.listTools()` 在 `dominds/main/team.ts` 中使用 `getToolset()` / `getTool()` 将工具集解析为具体的工具列表。
- LLM 层只能通过生成器（例如 `dominds/main/llm/gen/codex.ts）"看到"函数工具（`FuncTool`），工具执行通过驱动（`dominds/main/llm/driver.ts`）中的 `FuncTool.call()` 发生。
- 函数工具调用可以并发执行（驱动使用 `Promise.all()`），因此任何 MCP 客户端包装器必须安全地处理并行的飞行中请求。

## MCP 工具输出（文本 + 图片）与 artifact

部分 MCP 工具会返回结构化 `content[]`（而不仅仅是字符串）。常见形态（示意）：

- `type: "text"`：包含 `text: string`
- `type: "image"`：包含 `mimeType: string` 与 `data: string`（通常为 base64，可能带 `data:<mime>;base64,` 前缀）

Dominds 的行为：

- **落盘**：将 `image` 的 bytes 写入对话目录下的 `artifacts/`，路径形如：
  - `artifacts/mcp/<serverId>/<toolName>/<timestamp>-<uuid>.<ext>`
- **结构化回传**：`FuncTool.call()` 返回 `ToolCallOutput` 对象，并在 `contentItems` 中携带：
  - `{ type: "input_text", text }`
  - `{ type: "input_image", mimeType, byteLength, artifact: { rootId, selfId, relPath } }`
- **WebUI 渲染**：WebUI 可通过二进制接口拉取 artifact 并渲染图片：
  - `GET /api/dialogs/:root/:self/artifact?path=artifacts/...`
- **回喂给模型（识图）**：当生成器遇到 `func_result_msg.contentItems[].type=input_image` 时，会读取 artifact 并按提供者能力喂给模型；仅允许：
  - `image/jpeg | image/png | image/gif | image/webp`
  - 不支持的 mimeType 会降级成文本提示（避免请求被提供者拒绝）

许多真实的 MCP 服务器**并不安全，无法在多个对话/智能体之间共享**。示例包括保持可变会话状态的服务器、维护隐式"当前页面"句柄的服务器，或具有全局进程范围缓存的服务器。

因此，Dominds 默认将 MCP 客户端连接/进程视为**租赁资源**。

### 服务器配置：`truely-stateless`（默认值：`false`）

每个 MCP 服务器支持一个显式的布尔标志：

- `truely-stateless: false`（默认）：假设服务器**不**适合并发多对话使用。
- `truely-stateless: true`：声明该服务器可以安全地在对话之间共享。

注意：YAML 键有意拼写为 `truely-stateless`（而不是 `truly-stateless`），以匹配实现的配置表面。

### 默认行为（`truely-stateless: false`）

- 第一次在任何对话中使用来自该服务器工具集的 MCP 工具时，Dominds 为该对话创建一个**专用的 MCP 客户端实例**（因此也是专用的 MCP 服务器进程/连接）。
- 该客户端实例在来自同一工具集的未来工具调用中保持**租赁给该对话**。
- 如果另一个对话并发使用相同的 MCP 工具集，Dominds 为请求对话创建**另一个**MCP 客户端实例（不跨对话共享）。
- 在首次租赁时，Dominds 向对话添加一个**粘性拥有提醒**，指示智能体在确信不再需要该工具集时释放租赁。

释放：

- 智能体应调用 `mcp_release({"serverId":"<serverId>"})`（来自 `mcp_admin`）来释放当前对话的租赁客户端实例。

### 共享行为（`truely-stateless: true`）

- Dominds 可以跨对话共享该服务器/工具集的单个 MCP 客户端实例。
- 不需要每个对话的租赁提醒。

## 目标

- 通过 `.minds/mcp.yaml` 配置 MCP 服务器。
- 将每个 MCP 服务器视为 Dominds **工具集**（因此可以通过 `team.yaml` 授予）。
- 支持按模式进行工具名白名单/黑名单过滤。
- 支持工具名前缀/后缀转换以避免冲突并改善命名 UX。
- 支持安全的环境变量接线，包括从主机环境重命名/复制（因此 secrets 不需要提交到 YAML）。

## 非目标

- 替换 Dominds 内置工具集（`ws_read`、`ws_mod`、`os` 等）。
- 精确镜像每个第三方 MCP 客户端配置细节；这是一个以 Dominds 为中心的配置表面。

## 文件位置

- 主要配置文件：`.minds/mcp.yaml`
- 如果文件不存在，MCP 支持被禁用（不注册动态 MCP 工具集）。

## 映射：MCP 服务器 → Dominds 工具集

每个配置的 MCP 服务器映射到：

- 一个名为 `<serverId>` 的 Dominds 工具集（例如 `playwright`）。
- 一组注册到全局工具注册表的 Dominds 工具（工具名称必须在所有工具集中全局唯一）。

Dominds **必须**确保工具名称在以下范围内唯一：

- 内置工具（例如 `read_file`、`shell_cmd`）
- 所有服务器的所有 MCP 衍生工具

如果发生冲突，Dominds 应跳过冲突的 MCP 工具并记录清晰的警告，标识服务器 + 工具。

## 实现草图（基于当前注册表模型）

### 初始化位置

由于工具注册表是全局的，MCP 工具集必须在使用 `Team.Member.listTools()` 构建智能体工具列表之前注册（因此也在 `dominds/main/llm/driver.ts` 中的 LLM 生成之前）。

两个可行的集成点：

1. **服务器启动初始化（推荐）**：在服务器启动期间调用异步 `initMcpToolsetsFromWorkspace()`（在接受请求之前）。
2. **首次使用时延迟初始化**：在 `loadAgentMinds()`（或驱动循环）内调用 `ensureMcpToolsetsLoaded()`，并带有简单的 mtime 检查以支持"编辑配置并重试"。

### 需要添加的内容

至少需要：

- `.minds/mcp.yaml` 的 YAML 加载器（类似于 `Team.load()` 和 `LlmConfig.load()` 模式）。
- 一个注册表"所有者"层，跟踪哪些工具名称属于哪个 MCP 服务器，以便它可以：
  - 在重新加载时注销陈旧工具（`unregisterTool`）和工具集（`unregisterToolset`）。
  - 避免在配置编辑后留下旧工具。
- 每个服务器的 MCP 客户端实现（官方 SDK），它：
  - 通过 `stdio`（生成 `command` + `args` + `env`）或 `streamable_http`（`url` + `headers`）连接。
  - 执行 MCP 握手并获取工具列表（包括每个工具的 JSON 模式）。
  - 将每个 MCP 工具公开为 Dominds `FuncTool`，其 `call()` 执行 MCP `callTool` 请求。

### 为什么 MCP 工具应该是 `FuncTool`

Dominds 已经通过提供者支持结构化的"函数调用"，包括参数验证（`validateArgs()`）、工具模式转换、持久化和 UI 生命周期事件。将 MCP 工具实现为 `FuncTool` 意味着：

- MCP 工具自动作为函数工具出现在模型面前。
- 结果记录为 `func_result_msg`，匹配现有的持久化和 UI 逻辑。

Tellask 是一个单独的**队友调用语法**（不是工具类型），不适合 MCP 的结构化模式驱动工具。

### Stdio 传输注意事项（MCP 服务器端）

对于 stdio 传输，MCP 服务器进程必须将其 stdout 视为协议通道。操作日志必须转到 stderr（或文件），否则协议流将被损坏。

## 工具过滤（白名单/黑名单）

过滤旨在：

- 减少暴露的攻击面（只加载你打算授予的工具）。
- 避免 UI 和提示中的杂乱。

关键要求：不通过白名单/黑名单规则的工具**永远不会注册**到 Dominds 的工具系统中，因此永远不能呈现给智能体使用。

### 模式规则

- 模式使用简单的通配符匹配，使用 `*`（匹配任何子字符串）。
- 匹配针对**原始 MCP 工具名称**评估（在重命名转换之前）。这使过滤器保持稳定，即使命名转换发生变化。

### 语义

`whitelist` 根据是否配置了 `blacklist` 支持两种模式：

- **仅白名单模式**（`blacklist` 省略或为空）：
  - 如果提供了 `whitelist` 且非空，**只有**匹配至少一个 `whitelist` 模式的工具会被注册。
  - 如果 `whitelist` 省略或为空，所有工具都会被注册。
- **白名单 + 黑名单模式**（`blacklist` 提供且非空）：
  - 匹配任何 `blacklist` 模式的工具永远不会被注册，**除非**它们也匹配 `whitelist`（白名单覆盖黑名单用于精选）。
  - 既不匹配 `whitelist` 也不匹配 `blacklist` 的工具会被注册（即当黑名单存在时，白名单不限制范围）。

## 工具名称转换

转换应用于 MCP 工具名称以生成 Dominds 工具名称。

### 为什么存在转换

- MCP 服务器经常暴露短/常见的工具名称（`open`、`search`、`list` ……），这些名称可能在服务器之间冲突并与内置工具冲突。
- Dominds 工具名称是全局的，因此名称必须唯一且可识别。

### 支持的转换

转换按顺序应用：

1. `prefix`：添加或替换前缀。
2. `suffix`：添加后缀。

示例：

```yaml
transform:
  - prefix: 'playwright_'
  - prefix:
      remove: 'stock_prefix_'
      add: 'my_prefix_'
  - suffix: '_playwright'
```

注意：

- `prefix: "x_"` 始终在当前名称前面添加 `x_`。
- `prefix: { remove, add }` 删除指定的前导子字符串（如果存在），然后添加 `add`。
- `suffix: "_x"` 始终将 `"_x"` 附加到当前名称。

## 工具名称有效性（拒绝无效名称）

Dominds 必须**拒绝**其名称对于函数工具命名规则无效的 MCP 工具，这些规则由支持的 LLM 提供者共享。被拒绝的工具永远不会被注册。

精确规则（OpenAI + Anthropic 工具名称约束的交集）：

- 必须匹配：`^[a-zA-Z0-9_-]{1,64}$`
  - 允许的字符：ASCII 字母、数字、下划线、连字符
  - 长度：1-64 个字符

注意：

- 这同时适用于原始 MCP 工具名称和转换后的 Dominds 工具名称。
- Dominds 不得自动规范化无效名称（无隐式重命名）。只有显式配置的转换可以更改名称。
- 选择此规则是因为 OpenAI 和 Anthropic 对工具/函数名称基本都强制执行相同的约束；使用交集可以避免特定提供者的惊喜。

## 工具模式支持（MCP 输入 JSON 模式）

Dominds 应将 MCP 工具视为 `FuncTool`。这要求 `FuncTool.parameters` 支持标准 MCP 服务器使用的完整 JSON 模式功能集。

这意味着将 `dominds/main/tool.ts` 中的模式类型扩展到当前最小子集之外，以支持（至少）MCP 服务器常见发出的 JSON 模式构造，包括：

- `type`：包括 `'integer'` 和 `'null'`（此外还有 string/number/boolean/object/array），以及联合形式（例如 `type: ['string', 'null']`）
- 组合：`oneOf`、`anyOf`、`allOf`、`not`
- 字面量：`enum`、`const`、`default`
- 对象：`properties`、`required`、`additionalProperties`（布尔值或模式）、`patternProperties`、`propertyNames`
- 数组：`items`（模式或元组）、`prefixItems`、`minItems`、`maxItems`、`uniqueItems`
- 字符串：`minLength`、`maxLength`、`pattern`、`format`
- 数字/整数：`minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`、`multipleOf`
- 元数据：`title`、`description`

目前，Dominds 应**原样传递模式**给 LLM 提供者，只有在实践中被提供者拒绝特定模式时才收紧。任何提供者端的模式拒绝都必须通过 Problems + 日志呈现。

## 提供者安全工具投影（LLM 包装器 API）

即使 Dominds 可以在内部表示和验证 MCP 工具模式，每个 LLM 提供者可能有自己的工具模式约束。Dominds 需要一个特定于提供者的"投影"步骤，这样我们只向模型发送提供者兼容的工具定义。

设计：

- 在工具注册表中保留规范的、高保真的 `FuncTool`。
- 在生成时，为活动提供者投影工具：
  - `projectFuncToolsForProvider(apiType, funcTools) -> { tools, problems }`
  - 生成器仅在提供者请求负载中使用 `tools`。-（未来）被投影排除的工具会产生问题条目，以便用户可以看到为什么该提供者的工具缺失。

投影层是位于以下之间的 LLM 包装器 API：

- `Team.Member.listTools()`（工具注册表输出）
- LLM 生成器（例如 `dominds/main/llm/gen/codex.ts`、`dominds/main/llm/gen/anthropic.ts`、`dominds/main/llm/gen/openai.ts`）

规则：

- 目前，投影是一个**无操作直通**：它不会尝试"向下转换"模式或预先排除工具。如果提供者不喜欢工具模式，允许提供者拒绝请求。
- 当提供者拒绝工具模式时，Dominds 必须呈现一个描述提供者、工具名称和错误文本的问题（如果可以识别，还要包含涉及的工具名称）。我们可以稍后将投影演进为真正的提供者安全过滤和/或模式降级。
- 这个投影必须是确定性的且无副作用（无后台突变）。

## 重试和停止策略（当提供者拒绝请求时）

Dominds 不应盲目重试由无效请求引起的提供者拒绝（例如工具模式/工具名称/工具负载不兼容）。这些应该停止对话并需要明确的人工干预。

策略：

- **提供者拒绝（不可重试）**：如果 LLM 提供者拒绝请求（例如 HTTP 400，或表示无效请求/工具模式的结构化提供者错误），Dominds 必须：
  - 将对话转换为**停止/中断**运行状态（无自动重试）。
  - 呈现一个包含提供者名称、对话 ID 和错误文本的问题（如果可以识别，还要包含涉及的工具名称）。
  - 允许用户在更改配置/代码后恢复（例如调整 MCP 配置、重命名工具、减少工具集等）。
- **网络/可重试错误**：Dominds 可能仅对明确可重试的类别自动重试，例如瞬时网络故障/超时和提供者瞬时错误（例如速率限制或 5xx），使用有界退避和最大重试次数。

这保持系统响应，避免由无效工具模式引起的无限"重试循环"。

## 环境变量（`env`）

MCP 服务器通常需要凭证或运行时旋钮。Dominds 应支持两种方式来填充服务器进程环境：

1. **字面量值**（谨慎使用；避免 YAML 中的 secrets）
2. **从主机进程 env 复制**（首选用于 secrets 和本地唯一值）

### 环境值形式

```yaml
env:
  # 字面量值
  SOME_ENV_VAR_NAME: 'some_env_var_value'

  # 从主机环境复制/重命名
  NEW_ENV_VAR_NAME:
    env: EXISTING_ENV_VAR_NAME
```

语义：

- 子进程环境从 `process.env`（继承）开始，然后在其上应用 `env` 映射。
- 对于 `{ env: EXISTING_ENV_VAR_NAME }`，值在运行时从 Dominds 进程环境获取；如果缺失，服务器启动应失败并显示清晰的消息。

## HTTP 头（`streamable_http`）

`streamable_http` 服务器可以选择性地定义 HTTP 请求标头。值使用与 `env` 相同的字面量或 `{ env: ... }` 映射形式：

```yaml
headers:
  Authorization:
    env: MCP_AUTH_TOKEN
  X-Client-Name: 'dominds'
```

## 提议的 `.minds/mcp.yaml` 模式（v1）

这是一个以 Dominds 为中心的模式。它有意设计得很小，应该易于验证。

```yaml
version: 1
servers:
  <serverId>:
    # 并发模型（重要）
    # - 默认 false：每对话客户端租赁（对有状态服务器更安全）
    # - True：跨对话共享客户端（仅适用于真正无状态的服务器）
    truely-stateless: false

    # 传输配置（最小可行集）
    #
    # 1) stdio
    transport: stdio
    command: npx
    args: ['-y', '@playwright/mcp@latest']

    # 可选环境接线
    env: {}

    # 2) streamable_http
    # transport: streamable_http
    # url: http://127.0.0.1:3000/mcp
    # headers: {} # 可选（支持字面量或 { env: NAME } 值）
    # sessionId: '' # 可选

    # 工具暴露控制
    tools:
      whitelist: [] # 可选
      blacklist: [] # 可选

    # 工具名称转换（可选）
    transform: []
```

### 示例：Playwright MCP 服务器

```yaml
version: 1
servers:
  playwright:
    truely-stateless: false
    transport: stdio
    command: npx
    args: ['-y', '@playwright/mcp@latest']
    tools:
      whitelist: ['browser_*', 'page_*']
      blacklist: ['*_unsafe']
    transform:
      - prefix: 'playwright_'
```

使用上面的示例，服务器注册工具集 `playwright`，并公开如下工具：

- `playwright_browser_click`
- `playwright_browser_snapshot`

## 与 `team.yaml` 的交互

一旦 MCP 工具集被注册，它们可以像任何其他工具集一样被授予：

```yaml
members:
  alice:
    toolsets:
      - ws_read
      - playwright
```

## 加载 / 重新加载

- 在服务器启动时加载 `.minds/mcp.yaml`（推荐）。
- 热重载是**强制的**：Dominds 必须检测 `.minds/mcp.yaml` 变化并在运行时应用它们（无需服务器重启），包括：
  - 注销已移除的工具集/工具。
  - 重新注册已更新的工具集/工具。
  - 避免在全局注册表中留下陈旧工具。

## 动态重新加载设计（运行时适配）

本节设计了一个安全、实用的热重载机制，适合 Dominds 的**全局工具（集）注册表**以及智能体在每轮生成中重新解析工具的事实。

### 检测：如何注意到变化

使用以下之一：

1. **文件监视**：通过 `fs.watch()` 监视 `.minds/mcp.yaml` 并在 `change` / `rename` 时触发重新加载。
2. **轮询回退**：从 `fs.stat()` 记录 `mtimeMs` 并定期比较（或在 `loadAgentMinds()` 中的每轮比较）。

建议：两者都实现（监视以获得快速反馈；轮询以获得可靠性）。

始终进行去抖动（例如 100-500ms），因为编辑器可能通过临时文件 + 重命名或多次写入来写入。

将 `.minds/mcp.yaml` 的删除视为等同于空配置（清除所有服务器）：注销所有 MCP 工具集/工具并停止所有 MCP 服务器进程。

### 原子性：重新加载作为"计算然后交换"

重新加载应实现为：

1. 将 YAML 解析并验证为类型化配置对象。
2. 从该配置构建**期望的运行时模型**。
3. 区分期望与当前的运行时模型。
4. 在简短的临界区内应用对注册表的突变。

关键洞察是：**工具对象每轮被捕获到 `agentTools` 中**。注册表更改只影响未来轮次（或其他对话）当它们再次调用 `Team.Member.listTools()` 时。

### 注册表所有权跟踪（必需）

由于 `toolsRegistry` 是全局的，MCP 热重载必须准确跟踪它创建了哪些名称，以便以后可以移除它们而不触及内置工具。

维护一个内存结构，例如：

- `mcpRuntimeByServerId: Map<string, { toolsetName: string; toolNames: string[]; client: ...; hash: string; ... }>`
- `toolOwnerByName: Map<string, { kind: 'mcp'; serverId: string }>`

规则：

- 只注销由 MCP 拥有的工具/工具集（通过咨询 `toolOwnerByName`）。
- 永远不要注销内置工具/工具集。

### 差异规则（添加/移除/更改）

计算每个服务器定义的稳定哈希（包括传输特定字段如 command/args/env 或 url/headers/sessionId，加上工具过滤器/转换）。

- **添加的服务器**：生成客户端，列出工具，注册其工具 + 工具集。
- **移除的服务器**：注销其工具集，注销其工具，停止其客户端。
- **更改的服务器**：视为移除 + 添加（或进行就地更新），但从注册表的角度保持操作原子性。

重新加载**按服务器独立提交**：

- 如果服务器 A 重新加载失败，保持 A 的最后已知良好注册运行。
- 如果服务器 B 在同一周期中重新加载成功，即使 A 失败，也要提交 B 的更新。

### 排序（避免冲突和部分状态）

应用重新加载时：

1. 首先在内存中准备所有新的 `Tool` 对象和工具集。
2. 在临界区内：
   - 首先注销已移除/更改服务器的 toolset。
   - 接下来注销已移除/更改服务器的工具。
   - 注册已添加/更改服务器的工具。
   - 最后注册已添加/更改服务器的 toolsets。

这减少了碰撞风险，并避免 toolset 短暂指向缺失的工具。

### 并发与飞行中调用

Dominds 可以并发执行函数工具。对于 MCP 工具，这意味着：

- 每个 MCP 服务器客户端必须安全地支持多个飞行中的 `callTool` 请求。
- 热重载不得损坏飞行中的调用。

实用方法：

- 当工具被移除/更改时，通过注销工具对象来停止服务**新**调用。
- 保持底层 MCP 客户端存活，直到所有飞行中调用完成，然后终止它。
  - 每服务器客户端跟踪 `inFlightCount`。
  - 在"请求停止"时，设置 `closing = true`，仅当 `inFlightCount === 0` 时才终止。
  - 可选择强制超时以强制终止挂起的服务器。

### 失败行为

如果重新加载失败（无效 YAML、缺失环境变量、服务器生成失败、工具模式无效等）：

- 记录包含失败的服务器 ID 和原因的可操作错误。
- 保持**最后已知良好**MCP 运行时注册在位。
  - "好"表示：服务器成功启动、初始化，并且其工具集/工具已注册。
  - 已初始化的 MCP 服务器实例必须保持功能（并保持注册），直到新的"好"实例替换它。
- 不要对给定服务器部分应用重新加载（不要对该服务器进行半更新的注册表状态）。

### 重新加载期间与 `team.yaml` 的交互

如果成员引用了不再存在的工具集（例如 `playwright` 被移除），那么 `Team.Member.listTools()` 将警告"工具集未找到"，智能体在该轮中 simply 不会有那些工具。这是可以接受的；单独的 UX 改进可以在 UI 中呈现缺失的工具集。

### 可选：版本控制

维护一个单调递增的 `mcpRegistryVersion`，在每次成功重新加载后更新。这可用于：

- 调试日志（"智能体轮次使用了 MCP 版本 N"）
- UI 状态显示（"MCP 配置加载于……"）

## 验证与错误处理

Dominds 必须**始终启动**，即使 MCP 配置或服务器配置错误。MCP 问题应通过 Problems + 日志报告，并且 MCP 应按服务器优雅降级。

Dominds 应该在两个范围内尽早失败（带有可操作消息）：

**工作区级别（拒绝此重新加载尝试；保持最后已知良好的集合不变）：**

- 无效 YAML、缺失 `version` 或不支持的 `version`。
- 重复的服务器 ID。

**每服务器（仅拒绝该服务器的更新；保持该服务器的最后已知良好实例/工具）：**

- 不支持的 `transport` 值（例如 `sse` 不支持作为配置选项）。
- 转换后的工具名称冲突。
- 缺失的主机环境变量由 `{ env: ... }` 引用。

警告（非致命）应包括：

- 由于 `blacklist` 模式而从未注册的工具。
- 仅白名单模式下被排除的工具（仅当 `blacklist` 省略或为空时）。
- 由于冲突而丢弃的工具。
