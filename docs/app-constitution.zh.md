# App 建制（Kernel–App 分离：App 概念与机制，草案）

英文版：[English](./app-constitution.md)

> 状态：设计草案（RFC-ish）。
>
> 本文档旨在把“App 是什么、能提供什么、如何被依赖/覆盖、如何参与团队组装”这些机制讲清楚。
> 它不代表当前实现已经具备全部能力；文中会显式标注“现状（已实现）”与“目标（拟实现）”。

## 范围

本文覆盖以下主题：

- Kernel 与 App 的边界：App 作为可分发单元（Node.js package），Kernel 作为宿主与运行时。
- App 可提供的 `.minds/**` 资产：至少 `.minds/team.yaml`，并包含 `mcp.yaml`、`env.md` 等同类。
- `<rtws>/.apps/<app-id>/`：作为“workspace 侧的 app 状态与覆盖层”，支持对 app 资产进行覆盖（包含对依赖 app 的覆盖）。
- “开发中 app（dev app）”模式：让一个 rtws 以一个 Dominds App 的身份运行，从而复用相同的目录结构与机制。
- `.minds/team.yaml` 的增强语法：支持 `use`/`import` 引用其它 app 提供的智能体队友，并定义运行上下文与诉请语义。

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

目标：让 app 提供的智能体队友能参与团队组装，并明确跨 app 引用的运行上下文语义。

- 关键能力（至少）：
  - 读取已启用 app 的智能体队友 YAML（并支持 workspace override）。
  - `.minds/team.yaml` 支持在 `members.<id>.from + (use|import)` 显式引用依赖 app 的智能体队友。
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
  - override 覆盖范围扩展到更多 `.minds/**` 资产（persona/knowhow/pitfalls、memory、mcp 等）。
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
- 典型加载顺序：先解析并注册工具集，再读取团队定义与 imports，应用 override，校验后注册成员；失败则 defunc。

## 核心概念

### Kernel

Kernel 是 Dominds 的宿主运行时：负责对话驱动、工具调用、持久化、WebUI/WS/HTTP，以及加载/运行 apps。

### App

App 是一个可分发/可安装的能力包，通常是一个 **Node.js 项目（含 `package.json`）**，并提供：

- 工具（tool / toolset）：供 Kernel（或其它 app）在对话中调用。
- 智能体队友（teammates）：可被选为 responder、被 tellask、或作为“接头人/桥接器”。
- `.minds/**` 资产：用来描述/装配团队、工具接入（如 MCP 配置）、环境变量需求说明等。

> 备注：App **可以同时**是一个 Python（uv）项目（含 `pyproject.toml`），用于提供命令行入口/封装脚本。
> Kernel 与 App 宿主的宿主契约仍以 Node.js 为主；Python 侧主要服务于“把 app 的能力更好地暴露到命令行/外部工具链”。

### rtws（Runtime Workspace）

rtws 是一次运行的工作区根目录（`process.cwd()`）。Kernel 在其中读写：

- `.minds/`：团队/模型/工具等配置资产（用户侧可管理）。
- `.dialogs/`：对话持久化。
- `.apps/`：app 的安装记录、运行时状态、覆盖层与 seed 的 taskdocs 等。

### app 上下文（App Context）

“一个 agent 在哪个 app 上下文中运行”决定了它“看见的团队成员集合”与“解析工具/工具集的规则”。

- Kernel 上下文：传统意义的全局团队（rtws 的 `.minds/team.yaml`）。
- App 上下文：该 app 的本地团队（app 的 `.minds/team.yaml`，以及其依赖/覆盖组合之后的结果）。

> 目标：把“团队视野（能看见谁）”从“工具可用性（能调用什么）”中解耦，但都需要以 app 为单位封装与可覆写。
>
> 设计原则：app 机制的核心是“在 kernel 的显式 control points 注册 callback 来定制系统行为”。工具可用性只是其中一个 control point，不能被建模成 lease/registry/cache 的隐式副作用。
>
> 演进策略：先坚持“显式、具名、具体”的 control points，不要在多个 control point 都还未独立成熟之前，过早抽象成通用 app callback framework。
>
> 阶段说明：目前 app 侧协议细节仍然偏少，这是预期中的现状。它表达的是“方向先树稳、表面积后生长”，而不是 app 模型尚未定型。

## App 包与清单

### App Manifest（`.minds/app.yaml`）（YAML）

（现状：已实现）Kernel 已具备读取 app manifest（`.minds/app.yaml`）的 schema 与 loader：

- Manifest 类型与校验：`dominds/main/apps/manifest.ts`（`DomindsAppManifest`）。
- 默认 manifest 文件名：`.minds/app.yaml`（可被 `package.json` 的 `dominds.appManifest` 覆盖，见 `dominds/main/apps/package-info.ts`）。

该 manifest 当前已支持（摘取关键字段，不保证穷尽）：

- `contributes.teammates.teamYaml`：指向 app 自带的 team YAML。
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

Install JSON 是 app 与 Kernel/CLI 之间的**安装/运行握手载荷**。它可以包含解析所需的快照字段，但最关键的职责是声明 app 运行入口，并为后续解析提供一致的 source-of-truth。

推荐原则：

- Install JSON 必须承载运行入口握手字段：`host.moduleRelPath` 与 `host.exportName`。
- Install JSON 可以承载运行时消费所需的解析快照，但应避免把同一语义在 manifest 与 handshake 中长期双写到无法判断主次。
- manifest（`.minds/app.yaml`）继续承担 app 能力/资产语义；Install JSON 负责回答“当前这个 app 包应如何被加载”。

#### App 入口握手契约

- 对任意外置 app，**唯一合法的运行入口来源**是 `--dominds-app` 握手 JSON 中声明的 `host.moduleRelPath` 与 `host.exportName`。
- Kernel、CLI、tests、doctor/diagnostics 以及任何其他消费方，**都不得**猜测、回退或硬编码默认入口路径/导出名，例如 `src/app.js`、`src/app-host.js`、`dist/app.js`、`createDomindsApp`、`createDomindsAppHost`。
- published app 与 local/dev app 共用同一握手契约：差别只在于谁负责执行 app bin 并拿到 install JSON，不在于入口解析规则不同。
- `resolution.yaml.installJson` 是上一次成功解析得到的**派生快照**，用于观察与复用；它不是高于即时握手结果的真理源。重新 probe app 时，应以最新握手结果为准。

#### 对外导入面（当前正式 contract）

- package 拆分本身已经是正式 contract。对外正式 consumer 对 app/runtime-facing contract 应依赖 `@longrun-ai/kernel`；只有在 shell-facing contract 被明确放入 shell 包时才应依赖 `@longrun-ai/shell`；不得依赖 `dominds/main/**` 或任何 root-package 聚合中转层。
- `dominds/main/**` 整体都是私有实现树；其中 `dominds/main/runtime/**`、`dominds/main/bootstrap/**`、`dominds/main/markdown/**`、`dominds/main/apps-host/**` 这类路径都只服务仓内源码组织，不再构成任何源码层公开面。
- `dominds/main/index.ts` 已被有意删除。仓内不得再保留这种 legacy 聚合入口，否则会继续制造“main pkg 仍提供 consumer import contract”的错误心智。
- `tests/**` 被明确排除在公开面扩张依据之外。测试写起来方便，不足以把私有实现模块抬升成事实上的 public API。

这个边界现在只应写在真实发布 contract 上：

- `packages/kernel/package.json#exports` 定义受支持的 `@longrun-ai/kernel` 导入面。
- `packages/shell/package.json#exports` 定义受支持的 shell-facing `@longrun-ai/shell` 导入面；它不意味着 CLI 或 integrated runtime 归 shell 包承载。
- `dominds/package.json#exports` 仅限 CLI/聚合壳入口（如 `./cli`）；不得再长出 root runtime import surface。
- 发布态 package resolution 必须拒绝 `dominds/main/**`、`dominds/main/runtime/**`、`dominds/main/bootstrap/**`、`dominds/main/markdown/**`、`dominds/main/apps-host/**`、`dominds/dist/**` 这类 deep import。

职责切分应保持清晰：

- Install JSON / handshake：回答“如何加载 app entry module 与 app factory export”。
- manifest：回答“app 提供什么能力、资产、依赖与默认配置”。
- `.minds/app-lock.yaml`、`.apps/configuration.yaml`、`.apps/resolution.yaml`：回答“当前 rtws 锁定了什么、显式配置了什么、派生解析成了什么”。

用户路径与底层机制应明确区分：

- **用户安装入口** 应是 `dominds install <spec>`，而不是要求用户自己执行 `npx <pkg> --dominds-app`。
- `--dominds-app` 是 **Kernel/CLI 与 app 包之间的握手参数**，用于让 Dominds 读取 app install JSON；它不是面向终端用户的常规操作界面。
- 对已发布 app：Kernel/CLI 可以在解析阶段通过 `npx -y <pkg> --dominds-app` 获取 install JSON。
- 对本地开发中的 app：Kernel/CLI 可以通过 `dominds install <path> --local` 调用本地包的 bin，并传入 `--dominds-app` 完成同一握手。
- `npm install` / `pnpm add` 只解决“包被下载到哪里”；它们**不会**自动把 app 注册到当前 rtws。把 app 纳入当前 workspace 依赖图的动作仍然是 `dominds install`。
- `src/app.js`、`src/app-host.js`、`dist/app.js` 等文件组织只是 app 作者自己的实现选择；只要握手字段正确，消费方就不应依赖这些命名。

建议的用户心智模型：

- `npm` / `pnpm`：包管理器，负责发布、下载、缓存。
- `npx`：一次性执行某个 npm package 的入口；在 app 体系里主要作为 Kernel 的解析/握手后端。
- `dominds install`：Dominds 的产品级安装命令，负责把 app 写入 `.minds/app.yaml`、更新 `.minds/app-lock.yaml`、刷新 `<rtws>/.apps/configuration.yaml` / `resolution.yaml`，并让该 app 真正进入当前 rtws 的能力图。

（现状：已实现）install json schema 与 apps 配置/解析锚点仍可参考：

- JSON schema：`dominds/main/apps/app-json.ts`（`DomindsAppInstallJson`）。
- `.apps/configuration.yaml`：`dominds/main/apps/configuration-file.ts`。
- `.apps/resolution.yaml`：`dominds/main/apps/resolution-file.ts`。

（现状：已实现）Kernel 现在将 `<rtws>/.apps/configuration.yaml` 与 `<rtws>/.apps/resolution.yaml` 分离：

- `configuration.yaml` 提供用户配置：`resolutionStrategy?`（若提供）覆盖默认策略，`disabledApps` 表达显式 disable。
- `resolution.yaml` 只保存解析结果：`apps[]` 记录 `enabled` / `assignedPort` / `source` / `installJson`。
- 若 `configuration.yaml` 缺失：strategy 使用默认值（`order=['local']`，`localRoots=['dominds-apps']`），且没有显式 disable。
- 若 `resolution.yaml` 缺失：视为空快照，Kernel 会根据当前声明依赖重新解析并写回结果。

（现状：已实现）常规入口的自愈口径如下：

- `dominds webui`：server 启动链会初始化 apps runtime，并重新物化 `<rtws>/.apps/resolution.yaml`。
- `dominds tui` / `dominds run`：进入交互 runtime 前会刷新已启用 app 的运行态 / 工具代理，并重新物化 `resolution.yaml`。
- `dominds read` / `dominds man`：会先刷新已启用 app 的工具代理；若根 manifest 仍声明依赖，也会触发 `resolution.yaml` 的重新物化。

自愈成立的前提必须同时满足：

- 根 `.minds/app.yaml` 仍声明了正确的 app id（例如 `@longrun-ai/web-dev`）。
- 当前 resolution strategy 能解析到对应 app（例如默认 `localRoots=['dominds-apps']` 下存在 `dominds-apps/@longrun-ai/web-dev/`，且该包的 install handshake / manifest 也声明同一个 app id）。

若根 manifest / team.yaml 使用了错误的 app id（例如 app 已改为 `@longrun-ai/web-dev`，但 `dependencies[].id` 或 `members.<id>.from` 里仍保留 legacy `web_dev` 或未加 scope 的 `web-dev`），那么 refresh 仍会把 `resolution.yaml` 重新物化为空；这不是“自愈没跑”，而是“它按错误声明正确地重算出了空结果”。

因此，即使缺少 `<rtws>/.apps/configuration.yaml` 或 `<rtws>/.apps/resolution.yaml`，只要 `.minds/app.yaml` 声明了依赖，Kernel 仍会按默认策略去解析本地 app；反之若根 manifest 没有依赖，则最终已启用 app 集合为空。

### `phase-gate` 第一拍最小纵切：冻结说明

以下冻结点服务于 `phase-gate` 作为首个推荐 TypeScript app 的第一拍落地。它们不是要一次性把通用 change-governance 引擎做完，而是先把会反复影响 kernel contract、host projection、产品恢复动作与用户文案的最小边界钉死。

当前第一拍只覆盖单个 change 的 `进入 -> 定向 -> 推进` 主链路，以及 `已阻断` / `例外处理中` 两个高价值主状态；小循环仅先纳入 `阻断补料`、`豁免`、`回退/恢复`。首拍对象收口为：`change dossier`、`governance decision`、`recovery action`、`route context`。

#### `定向` 的必填语义

- `定向` 不是“登记一下 change 已进入流程”，而是必须产出后续治理所需的最小业务真相。
- 对第一拍而言，这些真相至少包括：
  - 当前治理强度（例如大/中/小，或等价分级）；
  - 责任边界（谁可默认推进，谁有阻断/批准职责）；
  - 是否允许继续沿默认推进路径前进。
- 这些语义应落在现有 `route context + governance decision` 内，不应再新造“第五类对象”。
- 一旦进入 `例外处理中`，该 decision 还必须同时带出范围、时效、批准责任与补偿动作；否则“受约束的例外”会退化成“临时放行的口子”。

#### `pre-drive decision -> host projection` 的最小正式输入 contract

- `phase-gate` 第一拍的关键 contract 不是把 app 私有业务词汇直接塞进 kernel，而是冻结 app 如何把“是否允许继续 drive”表达给 host。
- 目标方向应从当前过窄的 `continue | reject`，收口到能表达 `allow / reject / block` 的正式输入面；其中 `block` 只先承载机制级 orchestration primitives，例如 `await_members`、`await_human`、`await_app_action`。
- 对 `await_app_action`，app 至少要提供这些稳定字段，host 才能把它投影成产品级恢复动作：
  - `actionClass`
  - `actionId`
  - `owner`
  - `resolutionMode`
  - `targetRef`
  - 足够的目标/摘要材料，例如 `title`、`promptSummary`，以及 `select` 场景所需的 `optionsSummary`
- 准入责任在 host projection：app 负责提供结构化材料，host 负责判断这些材料是否足以形成明确恢复动作，并决定是投影为产品级动作，还是统一降级到兜底诊断路径。
- 这层 contract 冻结前，不宜直接开做第一拍实现。当前 `dominds/packages/kernel/src/app-host-contract.ts` 里的 `DomindsAppRunControlResult` 仍只有 `continue | reject`，而现有 `phase-gate` contract tests 已经依赖更丰富的 blocked / primary-action 结构，这正是当前需要先补齐的硬缺口。

#### `继续推进` 是统一恢复动作，不是隐含状态跳转

- 第一拍产品面必须存在一个显式的统一恢复动作：`继续推进`。
- 原因很直接：`阻断补料`、`豁免`、`回退/恢复` 只覆盖“先处理异常”，并不自动回答“异常处理完后如何回挂主链路”。
- 因此，补料完成、豁免决议落定、或恢复动作完成之后，host projection 必须能够给出“现在可以继续推进”的明确动作，而不是把这一步隐含在状态切换或实现细节里。

#### 统一兜底文案：`查看问题详情`

- 当 app 提供的材料不足以形成明确恢复动作时，产品层不得显示空心动作类或实现占位词，而应统一降级到 `inspect_problem` 路径。
- 该路径的对外默认文案现在就固定为：`查看问题详情`。
- `inspect_problem`、`select`、`confirm`、`input`、`driver`、`wiring`、`host adapter` 等内部实现词，默认不进入用户主句。
- 若实现层保留 `input` 之类内部类名，对外文案也应投影成“提供信息 / 填写信息”一类用户可理解表达，而不是直接暴露内部标识。

## App 可提供的 `.minds/**` 资产

### 资产类型与目标

这里的“`.minds/**` 资产”指 **App 包内部**携带的一组配置与说明文件（它们可能被 Kernel materialize 到 workspace，或通过 overlay 机制被读取）。

典型资产：

- `.minds/team.yaml`：该 app 的智能体队友定义（teammates）。
- `.minds/mcp.yaml`：该 app 需要/建议启用的 MCP server 声明（用于工具接入）。
- `.minds/env.md`：该 app 的环境变量说明文档（人类可读）。

设计目标：

- **可移植**：安装到不同 rtws 仍然可以工作。
- **可覆写**：workspace 可以对第三方 app 的 `.minds/**` 做局部覆盖。
- **可组合**：一个 app 可以依赖其它 app，并复用对方的智能体队友与工具集（通过 `use/import` 语义）。

### `.minds/team.yaml`（App 侧）

（目标：拟实现）App 可以在自己的包中提供 `.minds/team.yaml`，作为该 app 的“本地团队定义”。

它描述：

- app 自己有哪些智能体队友（members）；
- 这些智能体队友默认拥有哪些工具集/工具；
- 这些智能体队友在 app 上下文里互相如何可见/可 tellask。

> 现状（v0）：Kernel 会从已启用 app 读取智能体队友 YAML，但**不会**把其 `members` 扁平合并进 rtws 的 `.minds/team.yaml`。
> 你必须在 rtws 的 `.minds/team.yaml` 里通过 `members.<id>.from + (use|import)` 显式引用依赖 app 的智能体队友。
> 读取锚点：`dominds/main/apps/teammates.ts`；解析/落地锚点：`dominds/main/team.ts`。

### `.minds/mcp.yaml`

（目标：拟实现）App 可以提供自己的 MCP 配置（例如服务器定义、启动命令、环境变量引用）。

关键语义：

- app 的 `.minds/mcp.yaml` 应被视为“默认建议”，workspace 可以覆盖/禁用。
- app 的工具可能依赖 MCP server；因此 MCP 配置应与 app 的工具能力一起被打包与版本化。

### `.minds/env.md`

（目标：拟实现）`env.md` 是**人类可读**文档：列出 app 运行/接入所需环境变量。

- Kernel 不应自动把 `env.md` 写入 shell rc 或环境；它只提供可见性（文档/提示）。
- 若 Kernel 提供“写入 rc managed block”的能力（例如 setup flow），也应基于明确的 UI/确认，而不是隐式执行。

### 参考设计：Web Dev App（替代旧的原型 app 叙事）

为了避免继续围绕一个过于偶然的原型 app 收敛语义，本文改用一个更直接、可长期演进的参考设计：**Web Dev App**。

它的目标不是“代表某个具体产品”，而是提供一个高频、通用、容易验证的 app 形态：

- 面向 Web 开发与浏览器回归。
- 把浏览器交互能力包装成一个明确的工具集。
- 自带一支最小但完整的团队：至少 `web_tester` 与 `web_developer`。

设计口径：

- `Web Dev App` 是一个**整合型 app**：重点是封装团队、工具集、环境说明与协作姿态，而不是炫耀某个业务前端。
- 它应优先复用已有能力，而不是在 app 内重复发明一套浏览器自动化协议。
- 当前可参考的上游能力是 OpenAI `skills` 仓库中的 `playwright-interactive`。它之所以以 `SKILL.md` 形态暴露浏览器能力，很大程度上是因为上游产品把 `js_repl` 设计成了产品内置能力；`SKILL.md` 承担的是“如何使用这项内置能力”的指导层。Dominds 不应照搬这层切分，而应把“专属工具 + 工具集操作手册 + 推荐的智能体队友定义”作为更自洽的 app 封装颗粒度。`Web Dev App` 与其说是“包装一个 skill”，不如说是以更正交的产品边界，重新封装同类浏览器能力。

因此，`Web Dev App` 对 `playwright-interactive` 的定位应明确分成两层：

1. **产品语义层（本次设计范围）**：
   - 定义一个稳定的工具集名，例如 `playwright_interactive`。
   - 规定哪些智能体队友拿到这个工具集、它解决什么问题、什么时候用。
   - 配套 `.minds/team.yaml`、队友 persona/knowhow/pitfalls、`.minds/env.md`、工具集操作手册等资产。
2. **执行后端层（后续实现可替换）**：
   - 可以由 app 自己提供一组专属工具，产品化一套与 `playwright-interactive` 同类的浏览器交互能力；
   - 也可以是未来替换成等价的 MCP server / 本地宿主模块；
   - 只要对团队侧暴露的工具集契约不漂移即可。

这里必须明确 **app 与 skill 不是同一层概念**，而且两者在现有实现中都已经是正式机制：

- **App** 是 Dominds 的安装/解析/组合单元：它有自己的 `id`、manifest（`.minds/app.yaml`）、团队资产（`.minds/team.yaml`、persona/knowhow/pitfalls）、环境说明（`.minds/env.md`），并可被 `dominds install` 纳入某个 rtws。
- **Skill** 是 rtws 内的纯 Markdown 技能资产：当前从 `.minds/skills/team_shared/**` 与 `.minds/skills/individual/**` 读取，按工作语言优先选择 `SKILL.cn.md` / `SKILL.en.md` / `SKILL.md`，并把正文直接注入智能体系统提示词。它更适合承载软性的操作指导、检查清单、判断口诀与团队特定方法学，而不是承载需要稳定工具契约的可分发产品能力。
- Skill frontmatter 当前支持 `name`、`description`、`allowed-tools`、`user-invocable`、`disable-model-invocation`；其中后 3 项目前主要用于兼容/迁移语义，不会自动授予工具权限，也不会替代团队 / 工具集调度规则。
- **工具集操作手册 / 随 App 附带的操作手册** 更适合表达“和工具一起分发的操作指导”：它的性质接近 skill，但会与专属工具、工具集和 App 身份一起打包，更适合像 `web-dev` 这种需要整体分发与安装解析的能力。
- `playwright-interactive/` 不应被归类为上述“纯 Markdown rtws skill”；更准确地说，它体现的是“内置浏览器能力之上的指导层”。在 Dominds 中，更正交的做法是像 `@longrun-ai/web-dev` 这样，把专属工具、工具集操作手册、推荐智能体队友定义与运行态缓存一起封装成 app。
- **流程定义** 这个词在 Dominds 内应优先留给 `phase-gate` 这类带 phase/gate/quorum/rollback/自动推进语义的硬流程机制；skill 与工具集操作手册更接近指导层或操作手册，而不是流程引擎。

因此，正确表述不是“把一个纯 skill 直接当 app 安装”，而是：

- **纯提示型、纯 Markdown、无需额外工具能力** 的内容，优先直接作为 rtws skill 维护；
- **一旦能力包需要专属工具、外部二进制、MCP、由 App 提供的工具、稳定的工具集命名、智能体队友组装或依赖解析**，就应把“工具 + 工具集操作手册 + 推荐智能体队友定义 + 面向团队的契约”封装成 app；
- 其它 app 若依赖这类能力，应依赖该封装 app，而不是隐式约定“大家各自去抄一份 skill 再手配工具”；
- app 对外暴露稳定的团队、工具集与环境说明契约；底层 skill / MCP / 本地宿主模块可以替换，但 app 身份与面向团队的契约应保持稳定。

可以把判断口径压缩成一句话：

- **skill 负责软性指导，工具集操作手册负责随工具分发的操作说明，app 负责工具能力、依赖关系与面向团队的契约。**

建议安装流程（面向用户）：

```bash
# 本地开发态 app
dominds install ./dominds-apps/@longrun-ai/web-dev --local --enable

# 已发布到 npm 的 app（目标形态）
dominds install @longrun-ai/web-dev --enable
```

Web Dev App 需要明确区分三套命名，避免再次漂移：

- installable app id：`@longrun-ai/web-dev`
- 本地开发目录：`dominds-apps/@longrun-ai/web-dev/`
- npm package name：`@longrun-ai/web-dev`

也就是说，workspace `.minds/app.yaml` 的 `dependencies[].id`、`.minds/team.yaml` 的 `members.<id>.from`，以及 `<rtws>/.apps/resolution.yaml` 的 `apps[].id` 都应使用 `@longrun-ai/web-dev`；本地开发目录与 npm package 也统一保持 `@longrun-ai/web-dev` 这套 identity，不再同时保留 scoped / unscoped 双拼写。

安装完成后，用户应预期以下文件发生变化：

- `.minds/app.yaml`：增加根依赖声明。
- `.minds/app-lock.yaml`：冻结 app package 版本。
- `<rtws>/.apps/configuration.yaml`：记录用户显式 enable/disable 意图。
- `<rtws>/.apps/resolution.yaml`：记录实际来源、effective enabled 与稳定 `assignedPort`。

建议的最小资产形态：

```text
@longrun-ai/web-dev/
├── package.json
├── .minds/
│   ├── app.yaml
│   ├── team.yaml
│   ├── env.md
│   ├── app-lock.yaml
│   └── team/
│       ├── web_tester/
│       │   ├── persona.zh.md
│       │   ├── knowhow.zh.md
│       │   └── pitfalls.zh.md
│       └── web_developer/
│           ├── persona.zh.md
│           ├── knowhow.zh.md
│           └── pitfalls.zh.md
├── bin/
│   └── <app>.js
└── src/
    └── app.js
```

建议的团队形态：

- `web_tester`
  - 主要职责：运行浏览器交互、回归走查、收集截图/console/network 证据。
  - 默认工具集：`playwright_interactive` + 只读型 workspace 工具（如 `ws_read`）。
  - 非目标：不直接修改业务代码；不接管构建/进程管理。
- `web_developer`
  - 主要职责：实现页面/UI/交互修复，消费 `web_tester` 的缺陷报告并完成闭环。
  - 默认工具集：代码修改/检索工具（如 `codex_inspect_and_patch_tools` 或等价工具）+ 可选读取 `web_tester` 产出的证据。
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
      - codex_inspect_and_patch_tools
```

关于 `playwright_interactive` 工具集的设计要求：

- 它应被视为 **app 暴露给团队的稳定能力名**，而不是强绑定某个底层实现细节（skill / MCP / App 宿主）。
- 它应至少覆盖以下任务意图：
  - 打开/复用浏览器会话。
  - 导航到目标 URL。
  - 执行交互与断言。
  - 采集截图与关键调试证据。
  - 在多轮修复之间保持“可复用会话”的心智模型。
- 如果当前阶段还没有可直接执行的后端实现，文档必须明确标注为“目标契约（拟实现）”，而不是宣称已经内建完成。

当前原型期说明（`dominds-apps/@longrun-ai/web-dev`，截至 2026-03-08）：

- 该 app 已可安装，并已贡献 `web_tester` / `web_developer` 智能体队友与可用的 `playwright_interactive` 工具集注册。
- 可安装 app id 当前固定为 `@longrun-ai/web-dev`；本地开发目录与 npm package 也保持同一 scoped identity，避免多套命名并存。
- `playwright_session_new/list/status/eval/attach/detach/close` 与跨对话提醒同步已落地。
- `kind: "web"` 会话现在会创建真实的 Playwright browser/context/page 运行时，并通过 status/reminder 报告实时页面状态。
- `kind: "electron"` 还没有达到同等完成度：当前仍回落到旧的原型运行时路径，应视为未完成能力。
- 提醒体验契约：tool 输出可以摘要提示提醒同步动作，但附着状态的权威可见面仍是 reminder 面板本身。
- 运行时刷新契约：app 启用后，不应再要求为了“看见工具集”而整实例重启；下一次 minds 重新加载 / tool-availability 拉取应刷新已启用 app 的工具代理。但这 **不表示** 已经发出的进行中 prompt 会被追写更新。
- 动态工具可用性协议说明：app 控制的 dynamic availability 是独立协议层，语义上必须与 MCP registry/lease 和成员工具绑定正交；见 [tool-availability-protocol.md](./tool-availability-protocol.md)。
- app 机制说明：这里的 dynamic availability 应通过注册到 kernel control point 的 app callback 表达，而不是引入 app 自己的 registry，或与 MCP/runtime cache 隐式耦合。
- 浏览器能力层的剩余缺口：截图 / console / network 证据尚未作为一等 tool output 暴露，也还没有生产级浏览器生命周期管理器。
- 重启边界：若 kernel/apps-host 进程重启，已持久化的 session record 仍在，但内存态浏览器运行时会退化，需要后续 tool call 重新建立。

这类 app 的价值在于：

- 它让 `.minds/team.yaml` 的跨成员协作语义更具体：开发与测试天然是两个长期智能体队友，而不是临时角色描述。
- 它验证“app 提供团队 + 工具集 + 环境文档”的组合是否足够表达一个真实协作能力包。
- 它为后续把 skill/MCP/本地宿主模块统一到同一个 app 语义层提供了稳定锚点。

## `<rtws>/.apps/override/<app-id>/`：覆盖层

### 覆盖层目录（override root）

（目标：拟实现）rtws 中的 app 覆盖层目录改为：

`<rtws>/.apps/override/<app-id>/`

用途：

- 存放对 app 资产的覆盖（overrides）。
- 覆盖范围需要足够完整（不仅是 team）：应包括 persona/knowhow/pitfalls、memory 等。

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
- `.minds/team/<memberId>/{persona,knowhow,pitfalls}.md` 及其工作语言版本（例如 `persona.zh.md`）
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

（目标：拟实现）为了让 app 能“复用其它 app 提供的智能体队友”，而不是把所有智能体队友扁平合并到一个全局 team，我们引入两种不同语义，并把语法收敛为“在 members 内声明来源”。

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

（目标：拟实现）允许存在不注册工具（不 `contributes.tools`）的“cfg-only app”，它只提供 `.minds/**` 资产，用于 AI 团队的重组与 knowhow/pitfalls/人格配置。

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
- app 智能体队友加载器（原型期扁平合并）：`dominds/main/apps/teammates.ts`、`dominds/main/team.ts`
- manifest（`.minds/app.yaml`）解析：`dominds/main/apps/manifest.ts`
- rtws seed（taskdocs）：`dominds/main/apps/rtws-seed.ts`

---

本文档为设计草案；后续会随着实现落地持续更新。
