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

本文作为 App 相关语义与机制的统一入口。

## 路线图：A/B/C/D 阶段（MVP=阶段）

本文使用 **A/B/C/D** 表示该特性的演进阶段。

- “**MVP=C**” 的含义：本阶段的验收口径以 **C 阶段**的清单为准（即：只要求达到 C 阶段所列能力；其它能力即使已实现，也不作为 C 阶段 gate）。
- 阶段不等同于“兼容策略/稳定性承诺”：Dominds 仍处于原型期，阶段只用来定义**本特性**的可交付范围与验收重点。

> 说明：本路线图是 RFC-ish 的“目标范围定义”，并不自动代表“当前实现已具备”。文中仍以“现状（已实现）/目标（拟实现）”分别标注。

### 阶段 A：概念与最小骨架可跑（Foundations）

目标：把 Kernel/App 的边界与最小数据流跑通，让“安装/解析/启动路径”可被验证。

- 关键能力（至少）：
  - App 的 install handshake（`<app> --dominds-app`）可被 Kernel/CLI 读取。
  - App manifest（`.minds/app.yaml`）schema/loader 可用。
  - 基本的本地解析策略（`local`）可工作：按 `<rtws>/dominds-apps/<appId>/` 发现本地 app。

### 阶段 B：团队组装与跨 app 引用（Team Composition）

目标：让 app 提供的 teammates 能参与 team 组装，并明确跨 app 引用的运行上下文语义。

- 关键能力（至少）：
  - 读取 enabled apps 的 teammates YAML（并支持 workspace override）。
  - `.minds/team.yaml` 支持在 `members.<id>.from + (use|import)` 显式引用依赖 app 的 teammate。
  - 同名冲突/引用失败可诊断，并进入 Problems/defunc 路径（可重试）。

### 阶段 C：MVP gate（依赖/锁定/覆盖口径/端口固化/Problems）

目标：把“依赖解析 + 可观测 + 可回归”的闭环打齐，确保 dogfooding 下可诊断、可恢复。

- 关键能力（必过）：
  - required/optional 依赖：
    - optional 缺失/被 disable：静默跳过（不阻塞启动；不要求产生 Problems；允许 debug 日志）。
    - required 缺失/被 disable：不阻塞启动；必须在 WebUI Problems 可观测；相关能力进入 defunc/不可用。
  - disable 传导（required）：
    - `<rtws>/.apps/configuration.yaml` 需要表达用户显式 disable（`disabledApps`）。
    - `<rtws>/.apps/resolution.yaml` 只记录解析后的 effective enabled 结果。
    - 依赖恢复后，能自动恢复被动传导导致的 disable（不覆盖用户显式 disable）。
  - override 优先级（文档口径固定）：`rtws override > app override > app defaults`。
  - lock 语义（设计口径）：`.minds/app-lock.yaml` 仅冻结依赖项版本；enable/disable 不应导致 lock 抖动。
  - assignedPort：resolver 产出的 `assignedPort` 一旦固化必须为非 0；冲突时提示并重分配；卸载后自然回收。
  - Problems：Problems id 使用稳定前缀（当前为 `apps/apps_resolution/`），修复后可 reconcile 清理（不应永久残留）。

### 阶段 D：整合与体验完善（Integration & UX）

目标：让 integrator app 能“可发布地整合”依赖 app 的默认覆盖，并完善 Problems/可观测性体验。

- 关键能力（目标）：
  - app override：app 包内可携带对依赖 app 的默认覆盖（作为 integrator 的可发布整合配置），且仍以 rtws override 为最高优先级。
  - override 覆盖范围扩展到更多 `.minds/**` 资产（persona/knowledge/lessons、memory、mcp 等）。
  - Problems 机制增强：记录并展示“发生时间/解决时间/已解决状态”，并支持“一键清理已解决项目”。
  - 更完整的异常路径契约（损坏 YAML、部分可用、恢复策略）与回归覆盖。

## 非目标

- 本文不引入协议/schema 版本与长期兼容策略（原型期仍以快速迭代为主）。
- 本文不定义 sandbox/隔离（例如权限隔离、资源隔离）。
- 本文不把所有实现细节塞进来；实现锚点以“关键落点”形式列出。

## Kernel–App 运行时骨架

以下规则定义 Kernel 与 App 的关键运行时边界：

- 解析顺序：app 内固定为 `local(app) -> kernel`。
- 覆盖语义：覆盖按“配置层”发生，而不是按“对象注册”发生：
  - 对同一 app 的资产路径 `p`：`<rtws>/.apps/override/<app-id>/.minds/<p>`（rtws override）优先于 app 包内默认值。
  - （目标：拟实现）app 作为集成者可以为其依赖 app 提供 _app override_（例如随包发布的默认覆盖），但最终仍以 rtws override 为准。
  - 对 kernel registry 的同名覆盖不是目标：同名冲突应被显式诊断（并按规则进入 defunc / Problems），而不是“后写覆盖前写”。
- 冲突语义：import 引入同名冲突或依赖不满足时，app 进入 defunc。
- registry 边界：app 对象不注册到 kernel registry；defunc 不涉及“从 kernel 移除 app 对象”。
- 可观测性：defunc 原因应进入 Problems（至少可定位 `appId`、原因分类与建议动作）。
- 重试语义：defunc 默认可重试（依赖或配置修复后，下一次刷新周期可重载）。
- 固定工具契约：`app_integration_manual({ appId, language? })` 失败应可观测，但不触发 defunc。
- 典型加载顺序：先解析并注册工具集，再读取 team 与 imports，应用 override，校验后注册成员；失败则 defunc。

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

### App Manifest（`.minds/app.yaml`）（YAML）

（现状：已实现）Kernel 已具备读取 app manifest（`.minds/app.yaml`）的 schema 与 loader：

- Manifest 类型与校验：`dominds/main/apps/manifest.ts`（`DomindsAppManifest`）。
- 默认 manifest 文件名：`.minds/app.yaml`（可被 `package.json` 的 `dominds.appManifest` 覆盖，见 `dominds/main/apps/package-info.ts`）。

该 manifest 当前已支持（摘取关键字段，不保证穷尽）：

- `contributes.teammates.teamYaml`：指向 app 自带的 team yaml。
- `contributes.tools.module`：指向工具实现模块。
- `contributes.web.staticDir`：静态资源（可选）。
- `contributes.rtwsSeed.taskdocs[]`：向 `<rtws>/.apps/<app-id>/...*.tsk/` 写入种子 taskdoc（见 `dominds/main/apps/rtws-seed.ts`）。

#### 依赖声明 / 版本冻结 / workspace 解析（v0 草案）

（目标：拟实现）将“依赖声明 / 版本冻结 / workspace 解析结果（含 enable/disable 与端口固化）”分层，避免把声明、锁定与运行时状态混写在同一个文件里。

类比（直觉层面）：

- `.minds/app.yaml`：类似 `package.json`（声明依赖图 + 本 app 的默认配置）。
- `.minds/app-lock.yaml`：类似 `pnpm-lock.yaml`（冻结依赖版本；不应因 enable/disable 抖动）。
- `<rtws>/.apps/configuration.yaml`：workspace 用户配置（解析策略 + 显式 `disabledApps`）。
- `<rtws>/.apps/resolution.yaml`：某个 rtws 中的解析结果快照（实际来源 + effective enabled + 已固化端口）。

关键语义：

- enable/disable 操作只影响 `<rtws>/.apps/configuration.yaml.disabledApps`。
- 依赖项分为 `required` / `optional`：
  - `required` 依赖被 disable 时，依赖它的 app 需要连带变为 _effective disabled_（至少在 UI/Problems 中可观测）。
  - `optional` 依赖被 disable 时，不连带 disable。
- 端口：
  - app 在 `.minds/app.yaml` 中声明 `frontend.defaultPort`（可为 `0` 表示允许运行时决定）。
  - `<rtws>/.apps/resolution.yaml` 中的 `assignedPort` 用于“固化后的解析配置”，一旦存在则必须为**非 0**端口（用于防抖动）。
  - `assignedPort` 不等同于运行时“实际绑定端口（bound port）”；它是 resolver 产出的稳定配置。

### Install JSON（`npx <pkg> --dominds-app`）

（目标：拟实现）Install JSON 应避免与 manifest（`.minds/app.yaml`）内容重叠。

它的职责是：**提供“缓存位置/可定位信息”**（例如 app 的本地缓存目录、manifest 的相对路径/绝对路径、以及必要的校验信息），Kernel 后续根据该位置去读取 manifest（`.minds/app.yaml`）文件，获取完整信息。

推荐原则：

- Install JSON 只承载“定位与缓存”所需的最小字段。
- App 的能力清单（teammates/tools/web/seed 等）**只以 manifest 为准**，避免双写导致漂移。

用户路径与底层机制应明确区分：

- **用户安装入口** 应是 `dominds install <spec>`，而不是要求用户自己执行 `npx <pkg> --dominds-app`。
- `--dominds-app` 是 **Kernel/CLI 与 app 包之间的握手参数**，用于让 Dominds 读取 app install JSON；它不是面向终端用户的常规操作界面。
- 对已发布 app：Kernel/CLI 可以在解析阶段通过 `npx -y <pkg> --dominds-app` 获取 install JSON。
- 对本地开发中的 app：Kernel/CLI 可以通过 `dominds install <path> --local` 调用本地包的 bin，并传入 `--dominds-app` 完成同一握手。
- `npm install` / `pnpm add` 只解决“包被下载到哪里”；它们**不会**自动把 app 注册到当前 rtws。把 app 纳入当前 workspace 依赖图的动作仍然是 `dominds install`。

建议的用户心智模型：

- `npm` / `pnpm`：包管理器，负责发布、下载、缓存。
- `npx`：一次性执行某个 npm package 的入口；在 app 体系里主要作为 Kernel 的解析/握手后端。
- `dominds install`：Dominds 的产品级安装命令，负责把 app 写入 `.minds/app.yaml`、更新 `.minds/app-lock.yaml`、刷新 `<rtws>/.apps/configuration.yaml` / `resolution.yaml`，并让该 app 真正进入当前 rtws 的能力图。

（现状：已实现）install json schema 与 apps 配置/解析锚点仍可参考：

- JSON schema：`dominds/main/apps/app-json.ts`（`DomindsAppInstallJsonV1`）。
- `.apps/configuration.yaml`：`dominds/main/apps/configuration-file.ts`。
- `.apps/resolution.yaml`：`dominds/main/apps/resolution-file.ts`。

（现状：已实现）Kernel 现在将 `<rtws>/.apps/configuration.yaml` 与 `<rtws>/.apps/resolution.yaml` 分离：

- `configuration.yaml` 提供用户配置：`resolutionStrategy?`（若提供）覆盖默认策略，`disabledApps` 表达显式 disable。
- `resolution.yaml` 只保存解析结果：`apps[]` 记录 `enabled` / `assignedPort` / `source` / `installJson`。
- 若 `configuration.yaml` 缺失：strategy 使用默认值（`order=['local']`，`localRoots=['dominds-apps']`），且没有显式 disable。
- 若 `resolution.yaml` 缺失：视为空快照，Kernel 会根据当前声明依赖重新解析并写回结果。

因此，即使缺少 `<rtws>/.apps/configuration.yaml` 或 `<rtws>/.apps/resolution.yaml`，只要 `.minds/app.yaml` 声明了依赖，Kernel 仍会按默认策略去解析本地 app；反之若根 manifest 没有依赖，则最终 enabled apps 为空。

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

> 现状（v0）：Kernel 会从 enabled apps 读取 teammates YAML，但**不会**把其 `members` 扁平合并进 rtws 的 `.minds/team.yaml`。
> 你必须在 rtws 的 `.minds/team.yaml` 里通过 `members.<id>.from + (use|import)` 显式引用依赖 app 的 teammate。
> 读取锚点：`dominds/main/apps/teammates.ts`；解析/落地锚点：`dominds/main/team.ts`。

### `.minds/mcp.yaml`

（目标：拟实现）App 可以提供自己的 MCP 配置（例如服务器定义、启动命令、环境变量引用）。

关键语义：

- app 的 `.minds/mcp.yaml` 应被视为“默认建议”，workspace 可以覆盖/禁用。
- app 的 tools 可能依赖 MCP server；因此 MCP 配置应与 app 的工具能力一起被打包与版本化。

### `.minds/env.md`

（目标：拟实现）`env.md` 是**人类可读**文档：列出 app 运行/接入所需环境变量。

- Kernel 不应自动把 `env.md` 写入 shell rc 或环境；它只提供可见性（文档/提示）。
- 若 Kernel 提供“写入 rc managed block”的能力（例如 setup flow），也应基于明确的 UI/确认，而不是隐式执行。

### 参考设计：Web Dev App（替代旧的原型 app 叙事）

为了避免继续围绕一个过于偶然的原型 app 收敛语义，本文改用一个更直接、可长期演进的参考设计：**Web Dev App**。

它的目标不是“代表某个具体产品”，而是提供一个高频、通用、容易验证的 app 形态：

- 面向 Web 开发与浏览器回归。
- 把浏览器交互能力包装成一个明确的 toolset。
- 自带一支最小但完整的团队：至少 `web_tester` 与 `web_developer`。

设计口径：

- `Web Dev App` 是一个 **integrator-style app**：重点是封装团队、工具集、环境说明与工作方式，而不是炫耀某个业务前端。
- 它应优先复用已有能力，而不是在 app 内重复发明一套浏览器自动化协议。
- 当前可参考的上游能力是仓库根目录的 `playwright-interactive/` skill；该 skill 更像“工作流/方法学资产”，不是可直接作为 Dominds MCP server 安装的现成 server。

因此，`Web Dev App` 对 `playwright-interactive` 的定位应明确分成两层：

1. **产品语义层（本次设计范围）**：
   - 定义一个稳定的 toolset 语义，例如 `playwright_interactive`。
   - 规定哪些成员拿到这个 toolset、它解决什么问题、什么时候用。
   - 配套 `.minds/team.yaml`、成员 persona/knowledge、`.minds/env.md` 等资产。
2. **执行后端层（后续实现可替换）**：
   - 可以是把 `playwright-interactive` skill 包装成 app-host tools；
   - 也可以是未来替换成等价的 MCP server / 本地 host module；
   - 只要对 team.yaml 暴露的 toolset 契约不漂移即可。

这里必须明确 **app 与 skill 不是同一层概念**：

- **App** 是 Dominds 的安装/解析/组合单元：它有自己的 `id`、manifest（`.minds/app.yaml`）、团队资产（`.minds/team.yaml`、persona/knowledge/lessons）、环境说明（`.minds/env.md`），并可被 `dominds install` 纳入某个 rtws。
- **Skill** 更像工作流资产、方法学资产，或某个底层执行能力的封装材料。它可以被 app 复用、包装、替换，但通常不直接承担“被 workspace 安装、被 team.yaml 引用、被 resolution/lock 管理”的职责。
- `playwright-interactive/` 当前更接近 skill：它提供可借鉴或可包装的浏览器工作流能力，但 `Web Dev App` 才是把这些能力整合成“可安装产品单元”的实体。

因此，正确表述不是“把一个 skill 直接当 app 安装”，而是：

- skill 作为实现材料被 app 吸纳；
- app 对外暴露稳定的 team/toolset/env 契约；
- 底层 skill / MCP / host module 可以替换，但 app 身份与 team-facing contract 应保持稳定。

建议安装流程（面向用户）：

```bash
# 本地开发态 app
dominds install ./dominds-apps/web-dev --local --enable

# 已发布到 npm 的 app（目标形态）
dominds install @longrun-ai/web-dev --enable
```

安装完成后，用户应预期以下文件发生变化：

- `.minds/app.yaml`：增加根依赖声明。
- `.minds/app-lock.yaml`：冻结 app package 版本。
- `<rtws>/.apps/configuration.yaml`：记录用户显式 enable/disable 意图。
- `<rtws>/.apps/resolution.yaml`：记录实际来源、effective enabled 与稳定 `assignedPort`。

建议的最小资产形态：

```text
web-dev/
├── package.json
├── .minds/
│   ├── app.yaml
│   ├── team.yaml
│   ├── env.md
│   ├── app-lock.yaml
│   └── team/
│       ├── web_tester/
│       │   ├── persona.zh.md
│       │   ├── knowledge.zh.md
│       │   └── lessons.zh.md
│       └── web_developer/
│           ├── persona.zh.md
│           ├── knowledge.zh.md
│           └── lessons.zh.md
└── src/
    └── app-host.ts
```

建议的团队形态：

- `web_tester`
  - 主要职责：运行浏览器交互、回归走查、收集截图/console/network 证据。
  - 默认工具集：`playwright_interactive` + 只读型 workspace 工具（如 `ws_read`）。
  - 非目标：不直接修改业务代码；不接管构建/进程管理。
- `web_developer`
  - 主要职责：实现页面/UI/交互修复，消费 `web_tester` 的缺陷报告并完成闭环。
  - 默认工具集：代码修改/检索工具（如 `codex_style_tools` 或等价工具）+ 可选读取 `web_tester` 产出的证据。
  - 非目标：不把浏览器验收职责模糊地“顺手做掉”；需要时应显式 tellask `web_tester` 做验收。

建议的 `team.yaml` 片段：

```yaml
members:
  web_tester:
    name: Web Tester
    icon: '🧪'
    toolsets:
      - ws_read
      - playwright_interactive

  web_developer:
    name: Web Developer
    icon: '🛠️'
    toolsets:
      - ws_read
      - codex_style_tools
```

关于 `playwright_interactive` toolset 的设计要求：

- 它应被视为 **app 暴露给 team 的稳定能力名**，而不是强绑定某个底层实现细节（skill / MCP / app-host）。
- 它应至少覆盖以下任务意图：
  - 打开/复用浏览器会话。
  - 导航到目标 URL。
  - 执行交互与断言。
  - 采集截图与关键调试证据。
  - 在多轮修复之间保持“可复用会话”的心智模型。
- 如果当前阶段还没有可直接执行的后端实现，文档必须明确标注为“目标契约（拟实现）”，而不是宣称已经内建完成。

当前 prototype 说明（`dominds-apps/web-dev`，截至 2026-03-08）：

- 该 app 已可安装，并已贡献 `web_tester` / `web_developer` teammate 与可用的 `playwright_interactive` toolset 注册。
- `playwright_session_new/list/status/eval/attach/detach/close` 与跨对话 reminder sync 已落地。
- `kind: "web"` 会话现在会创建真实的 Playwright browser/context/page runtime，并通过 status/reminder 报告实时页面 surface。
- `kind: "electron"` 还没有达到同等完成度：当前仍回落到旧的 prototype runtime 路径，应视为未完成能力。
- reminder 体验契约：tool 输出可以摘要提示 reminder-sync 动作，但 attachment state 的权威可见面仍是 reminder 面板本身。
- runtime 刷新契约：app 启用后，不应再要求为了“看见 toolset”而整实例重启；下一次 minds reload / tools-registry fetch 应刷新 enabled app tool proxies。但这 **不表示** 已经发出的 in-flight prompt 会被追写更新。
- 浏览器能力层的剩余缺口：截图 / console / network 证据尚未作为一等 tool output 暴露，也还没有生产级浏览器生命周期管理器。
- 重启边界：若 kernel/apps-host 进程重启，已持久化的 session record 仍在，但内存态浏览器 runtime 会退化，需要后续 tool call 重新建立。

这类 app 的价值在于：

- 它让 `.minds/team.yaml` 的跨成员协作语义更具体：开发与测试天然是两个长期 agent，而不是临时角色描述。
- 它验证“app 提供团队 + toolset + env 文档”的组合是否足够表达一个真实工作流。
- 它为后续把 skill/MCP/本地 host module 统一到同一个 app 语义层提供了稳定锚点。

## `<rtws>/.apps/override/<app-id>/`：覆盖层

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

> 本文同时覆盖 `<rtws>/.apps/<app-id>/team.yaml` override DSL 的构想，并扩展到更通用的 `.minds/**` 资产（不仅限于 team）。

#### 覆盖范围（建议）

为了让 app 能“完整交付一个可复用团队/知识包”，override 应至少覆盖这些 `.minds/**` 资产：

- `.minds/team.yaml`
- `.minds/mcp.yaml`
- `.minds/env.md`
- `.minds/team/<memberId>/{persona,knowledge,lessons}.md` 及其工作语言版本（例如 `persona.zh.md`）
- `.minds/memory/**`（共享与个人记忆，见 `dominds/main/tools/mem.ts` 与 `dominds/main/minds/load.ts`）

#### 覆盖示例：固化依赖 app 的端口（v0 草案）

（目标：拟实现）端口属于“可发布的整合配置”，而不是运行时状态。

- app 在 `.minds/app.yaml` 里声明 `frontend.defaultPort`。
- workspace（或整合 app）可以通过覆盖文件为某个依赖 app 固化端口：
  - `<rtws>/.apps/override/<target-app-id>/frontend.yaml`

约定：

- 覆盖文件内容最小化（例如只包含 `port: <number>`）。
- 覆盖文件不仅可用于本地 rtws 开发，也可以被 app 内涵到包中发布（即 app 自己携带 `.apps/override/<target-app-id>/frontend.yaml` 作为“默认覆盖”）。
- 当一个 app 作为依赖被更外层 app 整合时，外层 app 的 override 可以继续覆盖内层 app 的默认 override（覆盖关系随整合链路传导）。
- resolver 在某个 rtws 中计算得到最终端口后，可以将其写入 `<rtws>/.apps/resolution.yaml` 的 `assignedPort` 以完成固化（且 `assignedPort` 必须非 0）。

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

> 现状（v0）：`.minds/team.yaml` 解析器已支持该语法。
> 但由于 App 上下文隔离/桥接机制尚未完成，`use` 与 `import` 在运行时暂时等价（都会把来源 member 的配置导入为当前 team 的一个成员），差异仅作为未来语义的占位。

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

建议将 `.minds/team.yaml` 的跨 app 成员引用问题统一归档到一个稳定前缀下，便于 Problems 面板聚合。

Problem id 应体现“定义方 scope 的从属层级”，并保持短小稳定（Problem id 是 UI 地址，不是栈轨迹）。

- 推荐形态：`team/team_yaml_error/members/<defining-app-id>/<local-id>/...`

其中：

- `<defining-app-id>`：把 rtws 与 kernel 都当作“虚拟 app”对待：
  - rtws 可没有 manifest，但默认 `app-id = rtws`
  - kernel 默认 `app-id = kernel`
- `<local-id>`：该 scope 下的 `members` key。

示例（仅示意，子类命名可调整）：

- `team/team_yaml_error/members/rtws/scribe/use_and_import_conflict`
- `team/team_yaml_error/members/rtws/librarian/from/missing`
- `team/team_yaml_error/members/rtws/bad_from/from/invalid`

## “开发中 app（dev app）”模式：让 rtws 作为 app 运行

（目标：拟实现）允许把一个 rtws 视为“正在开发的 Dominds App”，从而复用同一套目录结构与机制。

直觉类比：Node.js 项目在本地开发时，既是源码仓库，也是运行时工作目录；依赖通过 package manager 解析。

### 预期行为

- 当当前工作目录可被识别为一个 Dominds App（存在 manifest（`.minds/app.yaml`）；允许没有 `package.json` 的 cfg-only app），Kernel 可以进入 dev app 模式。
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
- `.apps/resolution.yaml`：`dominds/main/apps/resolution-file.ts`
- apps runtime（proxy tools）：`dominds/main/apps/runtime.ts`
- app teammates loader（原型期扁平合并）：`dominds/main/apps/teammates.ts`、`dominds/main/team.ts`
- manifest（`.minds/app.yaml`）解析：`dominds/main/apps/manifest.ts`
- rtws seed（taskdocs）：`dominds/main/apps/rtws-seed.ts`

---

本文档为设计草案；后续会随着实现落地持续更新。
