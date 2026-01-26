# Dominds Terminology / Dominds 专有名词表

> EN: Status: Draft / Proposed vocabulary
>
> ZH: 状态：草案 / 提议中的词汇体系

- EN: This document defines Dominds-specific terms and naming intended for system prompts and user/agent-facing docs.
- ZH: 本文档定义 Dominds 的专有名词与对外命名口径，主要用于系统提示与面向智能体/用户的文档。

## Table of Contents

- [Audience / 读者](#audience)
- [通用语境（General Context Vocabulary）](#general-context)
- [使用者语境（User-Facing Vocabulary）](#user-facing)
- [系统实现语境（Implementation-Facing Vocabulary）](#implementation-facing)

---

## Audience / 读者

- EN: The majority of Dominds “users” are **agents**. Human users are a minority (but still important).
- ZH: Dominds 的“用户”主要是**智能体**；人类用户占少数（但同样重要）。

---

## 通用语境（General Context Vocabulary）

- EN: Terms in this chapter are used across both user-facing prompts and implementation docs. They are “common ground” vocabulary.
- ZH: 本章术语会同时出现在对外提示与实现文档中，属于“共同语境”的统一口径。

### Taskdoc（差遣牒）

- EN: The shared task specification for a dialog tree. In Dominds, it is represented as an encapsulated `*.tsk/` Taskdoc package (not a single mutable Markdown file).
- ZH: 对话树共享的任务说明。在 Dominds 中，它对应一个封装的 `*.tsk/` 任务包（Taskdoc package）（而不是单个可随意改写的 Markdown 文件）。

### Taskdoc package (`*.tsk/`) / Taskdoc 任务包

- EN: A directory ending in `.tsk/` that contains three required section files: `goals.md`, `constraints.md`, and `progress.md`.
- ZH: 以 `.tsk/` 结尾的目录，包含三个必需分段文件：`goals.md`、`constraints.md`、`progress.md`。

### Taskdoc section selector / Taskdoc 分段选择器

- EN: The selector passed to `change_mind`: `goals` / `constraints` / `progress`.
- ZH: `change_mind` 的分段选择器：`goals` / `constraints` / `progress`。

### Encapsulation / 封装

- EN: General file tools MUST NOT read/write/list/move/delete anything under `**/*.tsk/`. Taskdoc edits must go through the explicit control tool `change_mind`.
- ZH: 通用文件工具不得读/写/列出/移动/删除 `**/*.tsk/` 下的任何内容；差遣牒的修改必须通过显式控制工具 `change_mind` 完成。

---

## 使用者语境（User-Facing Vocabulary）

- EN: Terms in this chapter may appear in system prompts and in docs written for agents (and sometimes humans).
- ZH: 本章术语会出现在系统提示与面向智能体（以及少量面向人类）的文档中。

### 快速对照（Quick Glossary）

- EN: `Tellask` | ZH: `诉请`
- EN: `TellaskBack` | ZH: `回问诉请`
- EN: `Tellask Session` | ZH: `长线诉请`
- EN: `Fresh Tellask` | ZH: `一次性诉请`
- EN: `Taskdoc` | ZH: `差遣牒`
- EN: `Taskdoc package (*.tsk/)` | ZH: `任务包`
- EN: `!tellaskSession <key>` | ZH: 会话键指令（只写在 headline）

### Tellask（诉请）

- EN: **Tellask** is a Dominds-specific interaction unit: a structured request addressed to a dialog participant (a teammate agent or an upstream dialog).
- ZH: **Tellask（诉请）**是 Dominds 的专有交互单元：一个对“对话参与方（队友智能体 / 上游对话）”发出的结构化请求。

- EN: A Tellask is not casual chat; it is a collaboration action that Dominds can drive, route, and coordinate (including suspend/resume).
- ZH: Tellask 不是随意聊天，而是一种可被 Dominds 驱动、路由、并由系统协调（包括挂起/恢复）的协作动作。

### 3 种诉请形态（Three Tellask Modes）

- EN: These names are intended to replace implementation-heavy labels like “Type A/B/C” in user-facing prompts.
- ZH: 下列命名旨在替代对外提示中“Type A/B/C”这类偏实现的分类叫法，让人类与智能体更好记、且更能传达语义。

> Note / 备注
>
> - EN: The underlying implementation may still use Type A/B/C internally.
> - ZH: 底层实现仍可能在内部保留 Type A/B/C 分类名。

#### 1) TellaskBack（回问诉请）

- EN (term): `TellaskBack`
- ZH（术语）: `回问诉请`

- EN (meaning): Ask the **origin dialog** (the dialog that issued the current Tellask) for clarification instead of guessing.
- ZH（含义）: 当被诉请方需要补充信息时，应**回问发起本次诉请的对话**澄清，而不是自行猜测。

- EN (what “Back” means): “Back” refers to routing back to the origin dialog; it does **not** imply hierarchy/seniority.
- ZH（Back 的含义）: “Back” 指回到发起方对话，**不暗示上下级**。

- EN (typical carrier): `!?@super ...` (available when you are inside a subdialog context)
- ZH（典型载体）: `!?@super ...`（通常在你处于子对话语境时可用）

Example / 示例（概念）:

- EN: `!?@super I need you to confirm the file extensions: only .md, or also .txt/.rst?`
- ZH: `!?@super 我需要你确认要扫描的文件扩展名：只包含 .md 还是也包含 .txt/.rst？`

#### 2) Tellask Session（长线诉请）

- EN (term): `Tellask Session`
- ZH（术语）: `长线诉请`

- EN (meaning): Multi-turn collaboration with **resumable context**, suitable for debugging, design alignment, iterative fixes, and sustained UX walkthroughs.
- ZH（含义）: 用于 **可恢复/可续用上下文** 的多轮协作，适合 debug、设计对齐、迭代修复、持续走查等。

##### 会话键指令（Session Key Directive）

- EN (directive; headline only): `!tellaskSession <key>`
- EN (compatibility note): As of today, the implementation uses `!topic <topic-id>` for resumable context. `!tellaskSession <key>` is a proposed user-facing naming/alias; until it is implemented, use `!topic` in actual Tellasks.
- ZH（兼容性备注）: 目前实现侧用于“可恢复上下文”的指令仍是 `!topic <topic-id>`；`!tellaskSession <key>` 是提议中的对外命名/别名。该别名落地前，实际诉请中请继续使用 `!topic`。
- ZH（指令；仅 headline）: `!tellaskSession <key>`

- EN (parameter name concept): `tellaskSession` (parameter names are English-only; not i18n’d)
- ZH（参数名概念）: `tellaskSession`（参数名只用英文，不做 i18n）

- EN (key format): short, stable, human-readable (e.g. `ws-schema-v2`, `tooling-read-file-ux`).
- ZH（key 格式）: 简短、稳定、可读（例如 `ws-schema-v2`、`tooling-read-file-ux`）。

- EN (placement rule): Put `!tellaskSession` in the Tellask headline; do not put it on a second line (it would become body text).
- ZH（位置规则）: `!tellaskSession` 必须写在诉请 headline 中；不要放到第二行（否则会进入 body 变成普通文本）。

##### 多人会话（Multi-Party Sessions）

- EN: The same `<key>` can be reused across multiple teammates to organize a multi-party collaboration session; this is a recommended communication pattern.
- ZH: 同一个 `<key>` 可以复用于多个队友，用于组织一次“多人协作会话”；这是推荐的沟通模式。

- EN (user mental model): You are hosting one session and inviting multiple participants.
- ZH（直觉心智模型）: 你在主持一场 session，并邀请多位参与者加入。

- EN (important nuance): Each teammate maintains its own session context; reusing the same `<key>` is a coordination convention that keeps the workstream aligned across participants.
- ZH（重要细节）: 每个队友各自维护其 session 上下文；复用同一 `<key>` 是一种“编组/对齐工作流”的协作约定，用于让多方围绕同一条工作线持续推进。

Example / 示例（概念）:

```plain-text
!?@server !tellaskSession ws-schema-v2
!?Please confirm the WS packet schema versioning strategy and point to code anchors.
!?请确认 WS packet schema 的版本化策略，并指出相关代码锚点。

!?@webui !tellaskSession ws-schema-v2
!?Explain which missing fields cause UX degradation along the current WebUI subscribe/render path.
!?按当前 WebUI 订阅/渲染路径说明：哪些字段缺失会导致 UX 退化。
```

#### 3) Fresh Tellask（一次性诉请）

- EN (term): `Fresh Tellask`
- ZH（术语）: `一次性诉请`

- EN (meaning): A one-off request with **non-resumable context**.
- ZH（含义）: 一次性请求，且其上下文 **不可恢复**。

- EN (key property): “Fresh/one-shot” is not only “new context”; it also means **no continuation semantics** — later Tellasks are not expected to resume the same workspace.
- ZH（关键性质）: “Fresh/一次性”不仅表示“新开上下文”，更表示：**没有后续续话语义** —— 后续诉请不应被期待能续到同一工作区。

- EN (practical guidance): If you need a follow-up after a Fresh Tellask, treat it as a new request and restate necessary context; if you need iterative follow-ups, use `Tellask Session` with `!tellaskSession <key>`.
- ZH（实践建议）: 如果你在一次性诉请后还要追问，应当把追问当作全新请求并补齐必要上下文；如果你需要可迭代的追问/推进，请使用 `Tellask Session` 并提供 `!tellaskSession <key>`。

Example / 示例（概念）:

- EN: `!?@cmdr Please run a single build and paste the failure output.`
- ZH: `!?@cmdr 请运行一次构建并回贴失败信息。`

### 系统提示可复用的一句话（One-Sentence Summary for System Prompts）

- EN: `TellaskBack` asks the origin dialog for clarification; `Tellask Session` uses `!tellaskSession <key>` for resumable multi-turn work; `Fresh Tellask` is one-shot and non-resumable.
- ZH: `TellaskBack` 回问发起方澄清；`Tellask Session` 用 `!tellaskSession <key>` 进行可续用多轮协作；`Fresh Tellask` 是一次性且不可恢复。

### 为何保留 `!` 前缀？（Why keep the `!` prefix?）

- EN: The Tellask headline mixes natural language with structured directives; the `!` prefix explicitly marks directives so they are less likely to be confused with ordinary text.
- ZH: 诉请 headline 同时包含自然语言与结构化指令；`!` 前缀用于显式标记指令，从而降低被误读为普通文本的概率。

---

## 系统实现语境（Implementation-Facing Vocabulary）

- EN: This chapter defines implementation-facing terms used in `dominds/docs/dialog-system.md` and in the runtime/server code.
- ZH: 本章定义系统实现语境下的术语，供 `dominds/docs/dialog-system.md` 及 runtime/server 代码对齐使用。

### Dialog / 对话

- EN: A **dialog** is a persisted, driveable conversation state machine.
- ZH: **对话（dialog）**是一个可持久化、可被后端驱动的对话状态机。

### Supdialog / 上游对话

- EN: A **supdialog** ("super dialog") is the orchestrating dialog in a hierarchical dialog relationship. It spawns subdialogs, provides context/objectives, and receives results/questions/escalations from its subdialogs.
- ZH: **supdialog（上游对话）**是在层级对话关系中负责编排的对话：它创建 subdialog，提供上下文/目标，并接收 subdialog 的结果/问题/升级请求。

- EN: A supdialog may receive **supdialog calls** from its subdialogs during execution.
- ZH: supdialog 在执行过程中可能接收来自 subdialog 的 **supdialog call（回问/回呼）**。

### Subdialog / 子对话

- EN: A **subdialog** is a specialized dialog spawned by a supdialog to handle a subtask with fresh (or session-resumed) context.
- ZH: **subdialog（子对话）**是由 supdialog 派生出来用于处理子任务的专用对话，具备相对独立的上下文（可能是新开或按会话 key 恢复）。

### Root Dialog / 根对话

- EN: A **root dialog** (aka **main dialog**) is the top-level dialog with no supdialog.
- ZH: **根对话（root dialog / main dialog）**是层级最顶层的对话，不存在 supdialog。

### Teammate Tellask / 队友诉请

- EN: A **teammate tellask** (or simply **tellask**) is a Tellask invocation that triggers communication with another agent or subdialog.
- ZH: **队友诉请（teammate tellask）**（或简称 **tellask**）是触发与另一个智能体或子对话通信的 Tellask 诉请。

### Type A/B/C (internal taxonomy) / 内部分类

- EN: The implementation may still use the internal labels **Type A/B/C** to classify teammate-tellask patterns.
- ZH: 实现层仍可能使用 **Type A/B/C** 作为队友诉请形态的内部分类。

- EN: Type A: supdialog call (subdialog calling its direct supdialog); primary syntax `!?@super` (NO `!topic`).
- ZH: Type A：supdialog call（子对话回问其直接 supdialog）；主语法 `!?@super`（不带 `!topic`）。

- EN: Type B: registered subdialog call (resumable) keyed by `agentId!topicId`.
- ZH: Type B：registered subdialog call（可恢复），用 `agentId!topicId` 作为 registry key。

- EN: Type C: transient subdialog call (one-shot), not registered.
- ZH: Type C：transient subdialog call（一次性），不注册到 registry。

### `!topic` / 会话键指令（current implementation)

- EN: In the current implementation, resumable registered subdialogs use `!topic <topic-id>` in the Tellask headline.
- ZH: 当前实现中，可恢复的注册子对话使用 Tellask headline 内的 `!topic <topic-id>`。

- EN: Proposed user-facing naming: `!tellaskSession <key>` as an alias of `!topic`.
- ZH: 提议的使用者命名：`!tellaskSession <key>` 作为 `!topic` 的别名。
