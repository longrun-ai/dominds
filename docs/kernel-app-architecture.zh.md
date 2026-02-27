# Kernel–App 架构（原型 v0.1）

English version: [English](./kernel-app-architecture.md)

## 范围与目标

本文件描述 Dominds 的 Kernel–App 分离原型设计，覆盖：

- 两级 namespace（kernel 外层 / app 内层）与解析规则
- app install json（`app --json`）扩展字段
- export/import 语义与冲突处理
- app defunc 语义
- app 集成手册（`app_integration_manual`）
- app 语言约束（work/ui language 与 i18n）
- `<rtws>/.apps/<app-id>/team.yaml` 增量覆盖 DSL

本原型的代码实现用于 **概念与功能验证**；本文件是“综合方案推进”的主载体（可被后续实现/迁移/评审稳定引用）。

## 非目标

- 2.x 前不引入协议/schema 版本与兼容策略
- 2.x 前不引入 sandbox 隔离
- run control 大幅扩展不在本文讨论（将单独出专项文档）

## 核心概念

- Kernel registry 维持当前 dominds 状态，内置能力将逐步迁出为独立 app。
- 每个 app 维护独立 registry，**app 本地优先、允许同名覆盖**。
- app 不会把对象注册到 kernel registry。
- app 之间互相隔离，只有通过 export/import 显式交换对象。

## Identity 与解析（Resolution）

### 名称空间

- 两级 scope：`kernel` 与 `app`。
- 在“运行时解析”中，对象的 **短 ID**（例如 `toolsetId`、`memberId`、`toolName`）仍然以当前 kernel 的习惯用法为主。
- 在“日志/诊断/Problems/文档”中，需要可唯一指认来源，因此引入 **Qualified Id**（仅用于诊断/显示，不强制写入 wire 协议）：
  - `kernel:<name>`
  - `app:<appId>:<name>`

### 解析顺序（app 内）

对任意解析请求（tool/toolset/member），在 app 内的解析顺序固定为：

1. `local(app)`（含：app 自身注册 + import 进来的对象）
2. `kernel`

说明：

- **允许同名覆盖**仅发生在 `local(app)` 覆盖 `kernel` 的场景。
- App 之间互不覆盖；若 import 导致 `local(app)` 内部同名冲突，则 app 置为 defunc。

## App install json（`app --json`）

在现有 `DomindsAppInstallJsonV1` 基础上新增：

- `depends?: [{ appId: string; versionRange: string }]`
- `exports?: { members?: string[]; toolsets?: string[] }`

约定：

- `exports` 为空表示不允许被 import。
- `exports` 可以列出多个对象，但 import 的最小单元固定为 **单个成员 / 单个工具集**（一次 import 指向一个 ID）。
- `exports` 中的成员必须来自 `contributes.teammatesYamlRelPath` 的成员定义。
- `exports` 中的工具集必须来自 `contributes.toolsets`。

## Registry 与解析规则

- App 内对象解析顺序：**local(app) → kernel**。
- App 之间互不覆盖；若 import 后发生同名冲突，app 置为 defunc。
- Kernel registry 不接收 app 注册对象，因此不存在“从 kernel registry 移除”这一操作。
- defunc 的 app 不参与解析（但其对象也不会被“移除”——因为它们从未进入 kernel registry）。

## Export / Import 语义

### Export

- 由 app install json 的 `exports` 声明。
- Kernel 对外提供 app exports 查询（API 形态可在实现阶段确定）。

### Import

- **成员 import**：在 app 的 `team.yaml` 中声明。
- **工具集 import**：在 app 的 `team.yaml` 中声明；运行时通过 dominds API 拉取工具集元信息，并注册到 app registry。

推荐结构（示意）：

```yaml
imports:
  members:
    - app: foo_app
      id: npc_foo
  toolsets:
    - app: bar_app
      id: bar_toolset
```

### 冲突与依赖失败

- import 冲突或依赖不满足 → app 置为 defunc。

#### 冲突矩阵（最小规则集）

| 场景                                        | 结果                      |
| ------------------------------------------- | ------------------------- |
| `local(app)` 与 `kernel` 同名               | 允许（local 覆盖 kernel） |
| import 的 member/toolset 与 app 本地同名    | defunc                    |
| import 的 member/toolset 与其它 import 同名 | defunc                    |
| import 指向未 export 的对象                 | defunc                    |
| depends 不满足（缺失/版本不匹配）           | defunc                    |

## Defunc 语义

- defunc 后 app 功能不可用。
- 不会从 registry 移除（app registry 不再被使用；kernel registry 没有 app 对象）。
- defunc 原因应被记录并可被诊断。

### Defunc 触发条件（建议枚举）

- `MANIFEST_INVALID`：install json 字段缺失/格式错误。
- `DEPENDENCY_MISSING` / `DEPENDENCY_VERSION_MISMATCH`：depends 缺失或不满足。
- `EXPORTS_INVALID`：exports 声明引用不存在的 member/toolset。
- `IMPORT_NOT_EXPORTED`：import 指向的对象未在对方 exports 声明。
- `IMPORT_CONFLICT`：import 引入同名冲突。
- `TEAM_OVERRIDE_INVALID`：`<rtws>/.apps/<app-id>/team.yaml` 覆盖 DSL 解析或校验失败。
- `IMPORT_FETCH_FAILED`：通过 API 拉取 toolset 元信息失败或返回无效。

### 重试语义（建议）

- defunc 默认 **可重试**：当依赖/配置问题被修复后，kernel 在下一次 app 刷新周期重新加载该 app。
- 重试不会自动修改已有对话/历史 round；仅影响后续解析与新调用。

### 可观测性（建议）

- defunc 必须进入 Problems（或等价的可见面），至少包含：`appId`、`reasonKind`、`detail`、`firstSeenAt`、`lastSeenAt`、`retryable`、`suggestedAction`。
- `app_integration_manual` 调用失败 **不触发 defunc**（失败应被记录，但不应让 app 进入不可用）。

## App 集成手册（`app_integration_manual`）

- kernel 固定工具：`app_integration_manual`
- 参数：`{ appId: string, language?: string }`
  - 未指定 `language` 时默认 **work language**。
- kernel 通过 IPC 路由到 app host，由 app 返回内容。
- app 可以静态输出 markdown，或运行时动态生成。
- app 必须提供 zh/en 双语内容。
- 调用失败不触发 defunc（返回错误即可）。

## 语言约束

- **work language** 来自 `LANG` 环境变量，kernel 与 app host 继承并且运行期不可变。
- app 必须遵守 kernel 的 work language。
- app UI 可以独立设置 ui language。
- 所有 app 必须至少支持 zh/en 双语。

## `team.yaml` 增量覆盖 DSL

覆盖文件：`<rtws>/.apps/<app-id>/team.yaml`

- 无需 `actions:` 顶层。
- 使用领域特定语法，支持 **add/replace/modify/delete**。
- 每次读取磁盘时执行动作，失败则 app 置为 defunc。

示意：

```yaml
version: 1

add:
  members:
    - id: npc_new
      value:
        name: 新NPC
        toolsets: [trae_toolset]

replace:
  members:
    - id: npc_old
      value:
        name: 旧NPC
        hidden: true

modify:
  members:
    - id: npc_village_head
      set:
        toolsets: [trae_toolset, extra_toolset]
        streaming: true
      unset: [tools]
      merge:
        model_params:
          codex:
            temperature: 0.2
  member_defaults:
    set:
      provider: codex

delete:
  members:
    - id: npc_removed

set_default_responder: npc_village_head

add_shell_specialist:
  - npc_village_head

remove_shell_specialist:
  - npc_foo
```

语义约束：

- `modify_member` 支持 `set`/`unset`/`merge`，其中 `merge` 对对象执行深合并。
- 所有新增/替换/修改需经过现有 team.yaml 校验逻辑。
- 出现冲突或解析失败，app 置 defunc。

## 加载流程（建议）

1. 解析并落实工具集（本地 toolsets + imports.toolsets），**先注册工具集与内含工具**
2. 读取 app 内置 team.yaml
3. 解析 imports.members
4. 应用 `<rtws>/.apps/<app-id>/team.yaml` 覆盖
5. 执行校验（此时工具/工具集已可解析）
6. 成功 → 注册成员到 app registry
7. 失败 → app defunc

## 复核包（Review Packet）

本节用于让 reviewer 在 30 分钟内完成复核并继续推进（不把实现细节写进差遣牒 progress）。

### 产物索引（Artifacts）

- 架构文档（语义源）：`dominds/docs/kernel-app-architecture.zh.md`
- 英文对齐：`dominds/docs/kernel-app-architecture.md`

### 近期变更影响面（Delta）

- WebSocket 驱动不再接收 `runControlId/runControlInput`（run control 的大幅扩展另起专项文档）。
- apps-host 的 run control 结果不再支持 `systemPromptPatch/prompt`（收敛为最小的 continue/reject 形态）。
- kernel-driver 的 context-health 驱动逻辑对齐 driver-v2 的实现方式（仅作为原型期收敛/清理）。

### 最小行为复核（Smoke，建议）

以下 smoke 以“原型仅概念/功能验证”为前提，重点验证系统未因近期清理而破坏既有路径：

1. `pnpm -C dominds run lint:types` 通过。
2. 若当前 rtws 存在已启用 app：启动后 apps runtime 能启动 apps-host，并将 app 的 `contributes.toolsets` 注册为 proxy tools（不发生 name collision）。
3. 在 WebUI 驱动对话与 Q4H 回答时，不再需要/不再发送 `runControlId/runControlInput`。

## 原型现状与问题清单（Gap List）

本原型当前已具备的“可验证骨架”（仅陈述事实，不承诺完备）：

- 已有 apps runtime + apps-host IPC 基础设施，可启动 apps-host 子进程并转发 tool 调用。
- 已支持按 app 的 `contributes.toolsets` 注册 proxy toolset/tool（用于概念/功能验证）。
- 已支持 app 声明 dialog run controls 的注册（但 run control 语义扩展另起专项文档）。

本原型尚未闭环/需要后续实现明确落点的事项（作为“现状与问题”产物）：

- `depends/exports/imports` 的加载、校验与冲突处理目前主要停留在架构规格层，尚需落地实现与端到端验证。
- defunc 的生命周期状态机、Problems 可观测面、可重试/重载入口需要实现级闭包（含日志/错误分类）。
- `<rtws>/.apps/<app-id>/team.yaml` override DSL 的实际读取/动作执行/校验落点需要实现与回归。
- `app_integration_manual(appId, language?)` 的 kernel 固定工具与 IPC 路由需要实现与回归。
- 迁移路线图（内置能力迁出顺序、回滚策略、dogfooding gate）需在后续实现阶段形成可执行清单。

## 完成定义（验收口径）

当以下条件满足时，可认为本原型的“综合方案推进”文档交付完成：

- 本文覆盖并明确：Identity/Resolution、defunc 触发与可重试、imports/exports 粒度与冲突矩阵、team.yaml override DSL、`app_integration_manual` 契约。
- 关键规则使用“发生 X → 系统做 Y”的句式，且没有依赖读源码才能理解的隐式前提。
- `kernel-app-architecture.zh.md` 与英文版 `kernel-app-architecture.md` 同步一致（zh 为语义基准）。

## 关键落点（现有代码）

- install json 解析：`dominds/main/apps/app-json.ts`
- apps runtime：`dominds/main/apps/runtime.ts`
- apps host contract：`dominds/main/apps-host/app-host-contract.ts`
- apps host IPC：`dominds/main/apps-host/ipc-types.ts`
- team.yaml 解析：`dominds/main/team.ts`
- app teammates loader：`dominds/main/apps/teammates.ts`

---

本文件为原型阶段设计草案，后续实现细节会跟随代码落地更新。
