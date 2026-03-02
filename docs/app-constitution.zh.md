# App Constitution（Kernel–App 分离：App 概念与机制，草案）

英文版：[English](./app-constitution.md)

> 状态：设计草案（RFC-ish）。
>
> 本文档旨在把“App 是什么、能提供什么、如何被依赖/覆盖、如何参与 team 组装”这些机制讲清楚。
> 它不代表当前实现已经具备全部能力；文中会显式标注“现状（已实现）”与“目标（拟实现）”。

## 范围

本文覆盖以下主题：

- Kernel 与 App 的边界：App 作为可分发单元（Node.js package），Kernel 作为宿主与运行时。
- App 可提供的 `.minds/**` 资产：至少 `.minds/team.yaml`，并包含 `mcp.yaml`、`env.md` 等同类。
- `<rtws>/.apps/<app-id>/`：作为“workspace 侧的 app 状态与覆盖层”，支持对 app 资产进行覆盖（包含对依赖 app 的覆盖）。
- “开发中 app（dev app）”模式：让一个 rtws 以一个 Dominds App 的身份运行，从而复用相同的目录结构与机制。
- `.minds/team.yaml` 的增强语法：支持 `use`/`import` 引用其它 app 提供的 teammate，并定义运行上下文与诉请语义。

本文与 `dominds/docs/kernel-app-architecture.zh.md` 的关系：

- `kernel-app-architecture` 更关注“registry/解析/defunc/IPC”等运行时骨架。
- 本文更关注“App 包与 `.minds/**` 资产的约定、覆盖机制、team 组装语义”。

## 非目标

- 本文不引入协议/schema 版本与长期兼容策略（原型期仍以快速迭代为主）。
- 本文不定义 sandbox/隔离（例如权限隔离、资源隔离）。
- 本文不把所有实现细节塞进来；实现锚点以“关键落点”形式列出。

## 核心概念

### Kernel

Kernel 是 Dominds 的宿主运行时：负责对话驱动、工具调用、持久化、WebUI/WS/HTTP，以及加载/运行 apps。

### App

App 是一个可分发/可安装的能力包，通常是一个 **Node.js 项目（含 `package.json`）**，并提供：

- 工具（tool / toolset）：供 Kernel（或其它 app）在对话中调用。
- 团队成员（teammates）：可被选为 responder、被 tellask、或作为“接头人/桥接器”。
- `.minds/**` 资产：用来描述/装配团队、工具接入（如 MCP 配置）、环境变量需求说明等。

> 备注：App **可以同时**是一个 Python（uv）项目（含 `pyproject.toml`），用于提供命令行入口/封装脚本。
> Kernel 与 app-host 的宿主契约仍以 Node.js 为主；Python 侧主要服务于“把 app 的能力更好地暴露到命令行/外部工具链”。

### rtws（Runtime Workspace）

rtws 是一次运行的工作区根目录（`process.cwd()`）。Kernel 在其中读写：

- `.minds/`：团队/模型/工具等配置资产（用户侧可管理）。
- `.dialogs/`：对话持久化。
- `.apps/`：app 的安装记录、运行时状态、覆盖层与 seed 的 taskdocs 等。

### app 上下文（App Context）

“一个 agent 在哪个 app 上下文中运行”决定了它“看见的团队成员集合”与“解析工具/工具集的规则”。

- Kernel 上下文：传统意义的全局团队（rtws 的 `.minds/team.yaml`）。
- App 上下文：该 app 的本地 team（app 的 `.minds/team.yaml`，以及其依赖/覆盖组合之后的结果）。

> 目标：把“团队视野（能看见谁）”从“工具可用性（能调用什么）”中解耦，但都需要以 app 为单位封装与可覆写。

## App 包与清单

### App Manifest（YAML）

（现状：已实现）Kernel 已具备读取 app manifest 的 schema 与 loader：

- Manifest 类型与校验：`dominds/main/apps/manifest.ts`（`DomindsAppManifest`）。
- 默认 manifest 文件名：`.minds/app.yaml`（可被 `package.json` 的 `dominds.appManifest` 覆盖，见 `dominds/main/apps/package-info.ts`）。

该 manifest 当前已支持（摘取关键字段，不保证穷尽）：

- `contributes.teammates.teamYaml`：指向 app 自带的 team yaml。
- `contributes.tools.module`：指向工具实现模块。
- `contributes.web.staticDir`：静态资源（可选）。
- `contributes.rtwsSeed.taskdocs[]`：向 `<rtws>/.apps/<app-id>/...*.tsk/` 写入种子 taskdoc（见 `dominds/main/apps/rtws-seed.ts`）。

### Install JSON（`npx <pkg> --json`）

（目标：拟实现）Install JSON 应避免与 manifest 内容重叠。

它的职责是：**提供“缓存位置/可定位信息”**（例如 app 的本地缓存目录、manifest 的相对路径/绝对路径、以及必要的校验信息），Kernel 后续根据该位置去读取 manifest 文件，获取完整信息。

推荐原则：

- Install JSON 只承载“定位与缓存”所需的最小字段。
- App 的能力清单（teammates/tools/web/seed 等）**只以 manifest 为准**，避免双写导致漂移。

（现状：已实现）install json schema 与 installed apps 文件锚点仍可参考：

- JSON schema：`dominds/main/apps/app-json.ts`（`DomindsAppInstallJsonV1`）。
- `.apps/installed.yaml`：`dominds/main/apps/installed-file.ts`。

## App 可提供的 `.minds/**` 资产

### 资产类型与目标

这里的“`.minds/**` 资产”指 **App 包内部**携带的一组配置与说明文件（它们可能被 Kernel materialize 到 workspace，或通过 overlay 机制被读取）。

典型资产：

- `.minds/team.yaml`：该 app 的团队成员定义（teammates）。
- `.minds/mcp.yaml`：该 app 需要/建议启用的 MCP server 声明（用于工具接入）。
- `.minds/env.md`：该 app 的环境变量说明文档（人类可读）。

设计目标：

- **可移植**：安装到不同 rtws 仍然可以工作。
- **可覆写**：workspace 可以对第三方 app 的 `.minds/**` 做局部覆盖。
- **可组合**：一个 app 可以依赖其它 app，并复用对方的 teammates/toolsets（通过 `use/import` 语义）。

### `.minds/team.yaml`（App 侧）

（目标：拟实现）App 可以在自己的包中提供 `.minds/team.yaml`，作为该 app 的“本地团队定义”。

它描述：

- app 自己有哪些 teammates（members）；
- 这些 teammates 默认拥有哪些 toolsets/tools；
- 这些 teammates 在 app 上下文里互相如何可见/可 tellask。

> 现状：Kernel 目前已经支持“从 enabled apps 读取 teammates YAML 并把其 `members` 合并进 rtws 的 `.minds/team.yaml`”。
> 该合并逻辑在 `dominds/main/team.ts`，读取逻辑在 `dominds/main/apps/teammates.ts`。
> 但这仍是“原型期的扁平合并”，不等价于“每个 app 独立 team + use/import 语义”。

### `.minds/mcp.yaml`

（目标：拟实现）App 可以提供自己的 MCP 配置（例如服务器定义、启动命令、环境变量引用）。

关键语义：

- app 的 `.minds/mcp.yaml` 应被视为“默认建议”，workspace 可以覆盖/禁用。
- app 的 tools 可能依赖 MCP server；因此 MCP 配置应与 app 的工具能力一起被打包与版本化。

### `.minds/env.md`

（目标：拟实现）`env.md` 是**人类可读**文档：列出 app 运行/接入所需环境变量。

- Kernel 不应自动把 `env.md` 写入 shell rc 或环境；它只提供可见性（文档/提示）。
- 若 Kernel 提供“写入 rc managed block”的能力（例如 setup flow），也应基于明确的 UI/确认，而不是隐式执行。

## `<rtws>/.apps/<app-id>/`：状态与覆盖层

### `.apps/installed.yaml`

（现状：已实现）Kernel 把“安装/启用的 apps 列表”写入 `<rtws>/.apps/installed.yaml`。

它是 workspace 侧 app 系统的事实来源之一（至少用于 enabled apps snapshot）。

### 覆盖层目录（override root）

（目标：拟实现）rtws 中的 app 覆盖层目录改为：

`<rtws>/.apps/override/<app-id>/`

用途：

- 存放对 app 资产的覆盖（overrides）。
- 覆盖范围需要足够完整（不仅是 team）：应包括 persona/knowledge/lessons、memory 等。

> 说明：运行时状态（state）与覆盖层（override）在结构上可以拆分；本文先聚焦 override 语义与路径。

（现状：已实现）rtws seed taskdocs 当前会写入到 `<rtws>/.apps/<app-id>/...`（实现锚点：`dominds/main/apps/rtws-seed.ts#applyRtwsSeed()`）。

（目标：拟实现）在引入 `.apps/override/<app-id>/` 后，seed 的落点需要重新定义（例如作为 override 的一部分，或作为 state 的一部分），但应保持：

- 能按 appId 定位并可 purge；
- 不与 override 的“用户可编辑覆盖”语义混淆；
- 仍能做到路径穿越防护。

### 覆盖 app（含覆盖依赖 app）资产

（目标：拟实现）workspace 可以通过 `<rtws>/.apps/<app-id>/` 提供覆盖层来修改第三方 app 的资产，而无需 fork 该 app 包。

建议的覆盖规则（以任意 app 资产路径 `p` 为例）：

1. `<rtws>/.apps/override/<app-id>/.minds/<p>`（workspace override，优先）
2. `<appPackageRoot>/.minds/<p>`（app 默认）

这条规则天然支持“覆盖依赖 app”：只要某个依赖 app 在该 rtws 中被启用，workspace 就可以通过它自己的 `.apps/<dep-id>/...` 覆盖它。

> 与 `kernel-app-architecture` 的对齐：该文档中已有 `<rtws>/.apps/<app-id>/team.yaml` override DSL 的构想；
> 本文把“override”扩展到更通用的 `.minds/**` 资产（不仅限于 team）。

#### 覆盖范围（建议）

为了让 app 能“完整交付一个可复用团队/知识包”，override 应至少覆盖这些 `.minds/**` 资产：

- `.minds/team.yaml`
- `.minds/mcp.yaml`
- `.minds/env.md`
- `.minds/team/<memberId>/{persona,knowledge,lessons}.md` 及其工作语言版本（例如 `persona.zh.md`）
- `.minds/memory/**`（共享与个人记忆，见 `dominds/main/tools/mem.ts` 与 `dominds/main/minds/load.ts`）

## `.minds/team.yaml` 增强：`use` / `import`

（目标：拟实现）为了让 app 能“复用其它 app 提供的 teammate”，而不是把所有 teammate 扁平合并到一个全局 team，我们引入两种不同语义，并把语法收敛为“在 members 内声明来源”。

### `use`：引用（桥接 / 接头人）

`use` 的直觉：

- 我想“用到”某个 app 的 agent，但我不把它“带进来”。
- 这个 agent **仍在原 app 上下文中运行**：只看见原 app 的队友与工具可用性。
- 在当前 app 视角下，它相当于一个“接头人”：你 tellask 它，它去原 app 里组织/调用原 app 的能力，再把结果带回来。

约束：

- 当前 app 不应在 prompt 中注入原 app 的队友列表（保持隔离）。
- `use` agent 不应被当作当前 app 的“内部成员”；它更像跨 app 的 RPC 入口。

### `import`：导入（在当前 app 运行的团队成员）

`import` 的直觉：

- 我想复用某个 agent 的“身份/人设/提示词”，但让它成为当前 app 团队的一员。
- 这个 agent **在当前 app 上下文中运行**：只看见当前 app 的队友。
- 它的工具解析也遵循当前 app 的规则（例如 local(app) → kernel）。

约束：

- `import` 不应让 agent 获得依赖 app 的“隐藏队友视野”；依赖 app 的能力应通过显式导入 toolsets 或 `use` 来获得。

### 建议的 YAML 形态

> 注意：下述语法为目标设计；当前 `.minds/team.yaml` 的解析器尚未支持。

示例（片段）：

```yaml
members:
  builder:
    name: Builder
    toolsets: [repo_tools]

  librarian:
    use: librarian # 可选；默认等于当前 member id（即 librarian）
    from: knowledge_base # <dep-app-id>
    # 可选其它 overrides

  scribe:
    import: scribe # 若省略则默认等价于 use
    from: common_agents # <dep-app-id>
    # 可选其它 overrides
```

语义要点：

- `members.<id>.from` 指定来源 app（依赖 app id）。
- `members.<id>.use` 表示引用来源 app 的 member（默认：若未写 `use/import`，则视为本地定义；若写了 `from` 但未写 `import`，默认按 `use` 处理）。
- `members.<id>.import` 表示把来源 app 的 member “导入为本地成员”来运行（上下文=当前 app）。

> 约定：同一个 member 定义里 `use` 与 `import` 不得同时出现。

#### 冲突矩阵（v0 草案）

> 说明：这里的“结果”描述的是目标行为口径；具体实现可选择 fail-open（忽略该条并记录问题）或 fail-closed（直接使 app/team 不可用），但必须可观测。

| 场景                                                       | 结果（建议）                                 |
| ---------------------------------------------------------- | -------------------------------------------- |
| `members.<id>.from` 不是字符串                             | 忽略该 member 的跨 app 定义；记录问题        |
| 同时出现 `members.<id>.use` 与 `members.<id>.import`       | 忽略该 member 的跨 app 定义；记录问题        |
| 仅出现 `use/import` 但缺少 `from`                          | 忽略该 member 的跨 app 定义；记录问题        |
| 指向的 app 不存在/未启用                                   | 忽略该 member 的跨 app 定义；记录问题        |
| 指向的 app 存在但未 export 该 member（未来：exports 约束） | 忽略该 member 的跨 app 定义；记录问题        |
| `use`：桥接成员被诉请时，目标 app defunc/不可用            | 诉请失败并返回错误；记录问题（不应静默吞掉） |

#### Problems / issue id 前缀（v0 草案）

建议将 `.minds/team.yaml` 的跨 app 成员引用问题统一归档到一个稳定前缀下，便于 Problems 面板聚合：

- 前缀：`team/team_yaml_error/members/<local-id>/from_app/<from-app-id>/<from-member-id>/`

说明：

- `<local-id>` 只在当前 team 内唯一，不代表全局唯一。
- 真正可跨 app 唯一指认来源的是 `<from-app-id>/<from-member-id>`。
- 当 `from` / `use` / `import` 本身无效时，实现可以使用占位段（例如 `_unknown_from_app_` / `_unknown_from_member_`）保持问题 id 稳定、可 grep。

建议的子类（示例）：

- `team/team_yaml_error/members/<local-id>/from_app/<from-app-id>/<from-member-id>/missing`
- `team/team_yaml_error/members/<local-id>/from_app/<from-app-id>/<from-member-id>/invalid`
- `team/team_yaml_error/members/<local-id>/from_app/<from-app-id>/<from-member-id>/use_and_import_conflict`
- `team/team_yaml_error/members/<local-id>/from_app/<from-app-id>/<from-member-id>/app_missing`
- `team/team_yaml_error/members/<local-id>/from_app/<from-app-id>/<from-member-id>/not_exported`
- `team/team_yaml_error/members/<local-id>/from_app/<from-app-id>/<from-member-id>/use_bridge_failed`

## “开发中 app（dev app）”模式：让 rtws 作为 app 运行

（目标：拟实现）允许把一个 rtws 视为“正在开发的 Dominds App”，从而复用同一套目录结构与机制。

直觉类比：Node.js 项目在本地开发时，既是源码仓库，也是运行时工作目录；依赖通过 package manager 解析。

### 预期行为

- 当当前工作目录可被识别为一个 Dominds App（存在 manifest；允许没有 `package.json` 的 cfg-only app），Kernel 可以进入 dev app 模式。
- dev app 模式下：
  - 当前目录的 `.minds/**` 被视为该 app 的默认资产；
  - `<rtws>/.apps/override/<dep-app-id>/...` 仍可用来覆盖依赖 app；
  - 可以在同一个 rtws 里同时启用其它已安装 app 作为依赖。

### cfg-only app（仅配置 app）

（目标：拟实现）允许存在不注册工具（不 `contributes.tools`）的“cfg-only app”，它只提供 `.minds/**` 资产，用于 AI 团队的重组与知识/人格配置。

这使得：

- rtws 作为 dev app 时，不必是一个 nodejs package。
- dominds app 自身也可仅作为配置包分发（例如只携带 `dominds.app.yaml` + `.minds/**`）。

### 价值

- App 开发者不需要“先打包/安装再调试”；直接在 repo 里跑即可。
- 同一套覆盖/依赖机制可以用于“产品运行”与“本地开发”。

## 关键落点（现有实现锚点）

- install json 解析：`dominds/main/apps/app-json.ts`
- `.apps/installed.yaml`：`dominds/main/apps/installed-file.ts`
- apps runtime（proxy tools）：`dominds/main/apps/runtime.ts`
- app teammates loader（原型期扁平合并）：`dominds/main/apps/teammates.ts`、`dominds/main/team.ts`
- manifest 解析：`dominds/main/apps/manifest.ts`
- rtws seed（taskdocs）：`dominds/main/apps/rtws-seed.ts`

---

本文档为设计草案；后续会随着实现落地持续更新。
