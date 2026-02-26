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

## 非目标

- 2.x 前不引入协议/schema 版本与兼容策略
- 2.x 前不引入 sandbox 隔离
- run control 大幅扩展不在本文讨论（将单独出专项文档）

## 核心概念

- Kernel registry 维持当前 dominds 状态，内置能力将逐步迁出为独立 app。
- 每个 app 维护独立 registry，**app 本地优先、允许同名覆盖**。
- app 不会把对象注册到 kernel registry。
- app 之间互相隔离，只有通过 export/import 显式交换对象。

## App install json（`app --json`）

在现有 `DomindsAppInstallJsonV1` 基础上新增：

- `depends?: [{ appId: string; versionRange: string }]`
- `exports?: { members?: string[]; toolsets?: string[] }`

约定：

- `exports` 为空表示不允许被 import。
- `exports` 只允许列出 **单个成员 / 单个工具集** 的 ID（粒度固定）。
- `exports` 中的成员必须来自 `contributes.teammatesYamlRelPath` 的成员定义。
- `exports` 中的工具集必须来自 `contributes.toolsets`。

## Registry 与解析规则

- App 内对象解析顺序：**local(app) → kernel**。
- App 之间互不覆盖；若 import 后发生同名冲突，app 置为 defunc。
- Kernel registry 不接收 app 注册对象，因此不存在“从 kernel registry 移除”这一操作。

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

## Defunc 语义

- defunc 后 app 功能不可用。
- 不会从 registry 移除（app registry 不再被使用；kernel registry 没有 app 对象）。
- defunc 原因应被记录并可被诊断。

## App 集成手册（`app_integration_manual`）

- kernel 固定工具：`app_integration_manual`
- 参数：`{ appId: string, language?: string }`
  - 未指定 `language` 时默认 **work language**。
- kernel 通过 IPC 路由到 app host，由 app 返回内容。
- app 可以静态输出 markdown，或运行时动态生成。
- app 必须提供 zh/en 双语内容。

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

add_member:
  - id: npc_new
    value:
      name: 新NPC
      toolsets: [trae_toolset]

replace_member:
  - id: npc_old
    value:
      name: 旧NPC
      hidden: true

modify_member:
  - id: npc_village_head
    set:
      toolsets: [trae_toolset, extra_toolset]
      streaming: true
    unset: [tools]
    merge:
      model_params:
        codex:
          temperature: 0.2

delete_member:
  - id: npc_removed

modify_member_defaults:
  set:
    provider: codex

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

## 关键落点（现有代码）

- install json 解析：`dominds/main/apps/app-json.ts`
- apps runtime：`dominds/main/apps/runtime.ts`
- apps host contract：`dominds/main/apps-host/app-host-contract.ts`
- apps host IPC：`dominds/main/apps-host/ipc-types.ts`
- team.yaml 解析：`dominds/main/team.ts`
- app teammates loader：`dominds/main/apps/teammates.ts`

---

本文件为原型阶段设计草案，后续实现细节会跟随代码落地更新。
