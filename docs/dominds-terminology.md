# Dominds Terminology / Dominds 专有名词表

> EN: Status: Draft / Proposed vocabulary
>
> ZH: 状态：草案 / 提议中的词汇体系

- EN: This document defines Dominds-specific terms and naming intended for system prompts and user/agent-facing docs.
- ZH: 本文档定义 Dominds 的专有名词与对外命名口径，主要用于系统提示与面向智能体/用户的文档。

## Table of Contents

- [Audience / 读者](#audience--读者)
- [通用语境（General Context Vocabulary）](#通用语境general-context-vocabulary)
- [使用者语境（User-Facing Vocabulary）](#使用者语境user-facing-vocabulary)
- [系统实现语境（Implementation-Facing Vocabulary）](#系统实现语境implementation-facing-vocabulary)

---

## Audience / 读者

- EN: The majority of Dominds “users” are **agents**. Human users are a minority (but still important).
- ZH: Dominds 的“用户”主要是**智能体**；人类用户占少数（但同样重要）。

---

## 通用语境（General Context Vocabulary）

- EN: Terms in this chapter are used across both user-facing prompts and implementation docs. They are “common ground” vocabulary.
- ZH: 本章术语会同时出现在对外提示与实现文档中，属于“共同语境”的统一口径。

### 用词原则：者 / 器 与 -or / -er

#### 中文：用"者"指代智能体角色，用"器"指代软件工具

- EN: When referring to a **role played by an agent** (intelligent actor), use the suffix **"-者"** (e.g., "管理者" instead of "管理器").
- ZH: 当指代**智能体承担的角色**时，用 **"-者"**（例如："团队管理者"而非"团队管理器"）。

- EN: When referring to a **software tool or utility**, use the suffix **"-器"** (e.g., "调度器", "解析器").
- ZH: 当指代**软件工具/组件**时，用 **"-器"**（例如："调度器"、"解析器"）。

- EN: The distinction prevents ambiguity between automated agents and static tools.
- ZH: 区分智能体（动态角色）与工具（静态组件）。

#### 英文：优先使用 -or 而非 -er

- EN: For agent roles, prefer **"-or"** (e.g., "operator", "monitor") over **"-er"** (e.g., "manager", "handler").
- ZH: 智能体角色优先用 **"-or"** 结尾（例如：operator、monitor），避免用 **"-er"**（manager、handler）。

- EN: "-or" denotes an active agent/actor; "-er" can imply a passive instrument.
- ZH: "-or" 暗示主动的行为者；"-er" 更偏向被动工具。

### Dialog Course（对话程）

- EN: **Dialog course** (ZH: **对话程**) is the Dominds-specific term for **one execution cycle of a dialog**. It replaces the generic "round" or "turn" to avoid confusion with LLM-generated "rounds" and business "iterations".
- ZH: **对话程（dialog course）**是 Dominds 的专有术语，指**对话的一次执行周期**。用于替代泛化的"轮/轮次"，避免与 LLM 生成的"轮次"及业务"迭代轮次"混淆。

- EN: Key properties:
  - One dialog course = one complete drive cycle (trigger → planning → action → result).
  - Distinct from "LLM round" (one model inference) and "business iteration" (one unit of work).
  - Used for observability: "dialog has completed 42 courses".
  - The term "course" implies a **dynamic process with direction**, not a static segment.
- ZH: 关键特性：
  - 一个对话程 = 一次完整的驱动周期（触发 → 规划 → 执行 → 结果）。
  - 区别于"LLM 轮次"（一次模型推理）和"业务迭代"（一个工作单元）。
  - 用于可观测性描述："对话已完成 42 程"。
  - "程"字暗示**动态进程、有方向性**，而非静态片段。

- EN: Do NOT use "round", "turn", or "轮次" when referring to dialog courses in Dominds context.
- ZH: 在 Dominds 语境中指代对话程时，**不要使用** "round"、"turn"、"轮次" 等泛化词。

### Taskdoc（差遣牒）

- EN: **Taskdoc** (ZH: **差遣牒**) is Dominds's task encapsulation format: a directory ending in `.tsk/` that contains three required sections: `goals.md`, `constraints.md`, and `progress.md`.
- ZH: **差遣牒（Taskdoc）** 是 Dominds 的任务封装格式：以 `.tsk/` 结尾的目录，包含三个必需分段：`goals.md`、`constraints.md`、`progress.md`。

- EN: Taskdocs are "single source of truth" for team-shared task contracts. They MUST be edited via the explicit control tool `change_mind`; generic file tools are **banned** from reading/writing anything under `**/*.tsk/`.
- ZH: 差遣牒是全队共享任务契约的"单一事实来源"。必须通过显式控制工具 `change_mind` 进行修改；通用文件工具**禁止**读/写 `**/*.tsk/` 下的任何内容。

#### Section selector / 分段选择器

- EN: The selector passed to `change_mind`: `goals` / `constraints` / `progress`.
- ZH: `change_mind` 的分段选择器：`goals` / `constraints` / `progress`。

### Continuation Package / 接续包

- EN: A scannable, actionable info package helping agents resume after `clear_mind`. Contains: (1) first step, (2) key info (files/symbols), (3) run info (commands/ports), (4) volatile details (paths/IDs/URLs).
- ZH: 可扫描、可操作的信息包，帮助智能体在 `clear_mind` 后快速接续工作。包含：① 第一步操作，② 关键定位信息，③ 运行/验证信息，④ 临时细节（路径/ID/URL）。
- ZH 术语：**接续包**（禁止使用"恢复包"、"检查点包"等变体）。

### clear_mind（清理头脑）

- EN: A function tool that clears the agent's short-term working memory (conversation history, tool outputs) while preserving Taskdoc, reminders, and memories. Used when context health degrades and a fresh start is needed.
- ZH: 一个函数工具，用于清空智能体的短期工作记忆（对话历史、工具输出），同时保留差遣牒、提醒项与记忆层。用于上下文健康度下降、需要重新开始时。

- EN: After `clear_mind`, the agent should have a "Continuation Package" prepared for quick resumption.
- ZH: `clear_mind` 后，智能体应准备好"接续包"以便快速接续工作。

### Reminder（提醒项）

- EN: A short-lived, high-frequency work item tied to the current run (not persisted). Reminders help agents track next steps, critical details, or pending tasks. They are managed by the `add_reminder`, `update_reminder`, `delete_reminder` function tools.
- ZH: 一种短期、高频的工作项，与当前运行绑定（不持久化）。提醒项帮助智能体追踪下一步、关键细节或待办事项。通过 `add_reminder`、`update_reminder`、`delete_reminder` 函数工具管理。
- ZH 术语：**提醒项**（禁止使用"便签"、"备注"、"待办"等变体）。

### Q4H (Question for Human) （向人类的诉请）

- EN: A mechanism for raising questions to humans, initiated via `!?@human`, which suspends dialog progression until the human responds. **Always use "Q4H" (capital Q, numeral 4, capital H); never use "Q-for-H", "QforH", or "4-hour".**
- ZH: 一种通过 `!?@human` 向人类提问的机制，暂停对话进度直到人类响应。**统一使用"Q4H"（大写 Q、数字 4、大写 H）；禁止使用"Q-for-H"、"QforH"、"每四小时"等变体。**

### Diligence Push（鞭策）

- EN: A proactive continuation mechanism that Diligence Pushes the agent when it's idle or blocked, using configurable prompts and budget limits. **Always use "Diligence Push"; never use "keep-going", "勤奋", "proactive-push", or "auto-continue".**
- ZH: 一种主动继续机制，在智能体空闲或阻塞时通过可配置的提示词和预算上限进行"鞭策"。**统一使用"鞭策"；禁止使用"保持运行"、"勤奋"、"自动继续"、"催促"等变体。**

- EN: Related terms: "Diligence Push prompt" (prompt file), "Diligence Push-max" config, "Diligence Push injection" (prompt injection).
- ZH: 相关术语："鞭策提示词"（提示词文件）、"鞭策上限"（配置项）、"鞭策注入"（注入机制）。

### Teammate / 队友

- EN: An agent participant in the Dominds dialog system. **Always use "teammate" when referring to agent participants; avoid "member", "agent peer", or "collaborator" in this context.**
- ZH: Dominds 对话系统中的智能体参与者。**统一使用"队友"（teammate）指代智能体参与者；避免使用"成员"、"智能体同伴"、"协作者"等变体。**

- EN: Contrast with "team member" which refers to organizational structure topics.
- ZH: 与"团队成员"（team member）形成对比；后者用于谈论组织结构架设话题。

### Memory（分层记忆）

- EN: The persistent knowledge store in Dominds, consisting of layers: personal memory, team memory, and shared minds. **Always use "Memory" (singular) as the concept name; use "minds" (plural) only when referring to the directory/collection.**
- ZH: Dominds 中的持久化知识库，由多个层级组成：个人记忆、团队记忆、共享记忆。**统一使用"Memory"（单数）作为概念名；只有指代目录/集合时才使用"minds"（复数）形式。**

- EN: Do NOT use "Mind" as a synonym; "Mind" refers to the entire persistent store (the concept), while "memory" refers to individual entries within it.
- ZH: 不要用"Mind"作为同义词；"Memory"指代整个持久化知识库这一概念，而"memory"指代其中的单个条目。

### Tellask（诉请）

- EN: A Dominds-specific interaction unit: a structured request addressed to a dialog participant. **Always use "Tellask" (noun) or "tellask" (verb); never use "ask", "request", "query", or "invocation".**
- ZH: Dominds 的专有交互单元：一个对对话参与方发出的结构化请求。**统一使用"Tellask"（名词）或"tellask"（动词）；避免使用"询问"、"请求"、"查询"、"调用"等变体。**

### Fresh Boots Reasoning（扪心自问）

- EN: A reasoning approach where the agent starts from first principles without relying on prior context. **Use "Fresh Boots Reasoning" or its abbreviation "FBR" interchangeably; never use "bootstrapping" or "fresh start reasoning".**
- ZH: 一种从第一性原理出发、不依赖先前上下文的推理方式。**统一使用全称"扪心自问"或缩写"FBR"；禁止使用"自举推理"、"从零思考"等变体。**

- EN: Named after the metaphor of a newborn animal taking its first steps.
- ZH: 取自新生动物迈出第一步的隐喻。

- EN: General file tools MUST NOT read/write/list/move/delete anything under `**/*.tsk/`. Taskdoc edits must go through the explicit control tool `change_mind`.
- ZH: 通用文件工具不得读/写/列出/移动/删除 `**/*.tsk/` 下的任何内容；差遣牒的修改必须通过显式控制工具 `change_mind` 完成。

---

## 使用者语境（User-Facing Vocabulary）

- EN: Terms in this chapter may appear in system prompts and in docs written for agents (and sometimes humans).
- ZH: 本章术语会出现在系统提示与面向智能体（以及少量面向人类）的文档中。

### 快速对照（Quick Glossary）

- EN: `Tellask` | ZH: `诉请`
- EN: `Tellask headline` | ZH: `诉请头`
- EN: `Tellask body` | ZH: `诉请内容`
- EN: `TellaskBack` | ZH: `回问诉请`
- EN: `Tellask Session` | ZH: `长线诉请`
- EN: `Fresh Tellask` | ZH: `一次性诉请`
- EN: `Taskdoc` | ZH: `差遣牒`
- EN: `Taskdoc package (*.tsk/)` | ZH: `任务包`
- EN: `!tellaskSession <slug>` | ZH: 会话 Slug（只写在 headline）
- EN: `CLI (entrypoint UI)` | ZH: `CLI（入口界面）`
- EN: `TUI (interactive UI)` | ZH: `TUI（交互前端）`
- EN: `WebUI (interactive UI)` | ZH: `WebUI（交互前端）`

### UI Surfaces（入口界面与交互前端）

- EN: In Dominds terminology, the **CLI is only the initial entrypoint UI**: it starts/manages a run and hosts subcommands; it is **not called** the “end-user UI surface / interactive frontend”.
- ZH: 在 Dominds 语境中，**CLI 只是初始入口界面**：用于启动/管理一次运行与承载子命令；它**不被称为**“最终用户界面/交互前端”。

- EN: **TUI and WebUI are the interactive frontends** (end-user interaction surfaces), and both are launched via the CLI entrypoint.
- ZH: **TUI / WebUI 才是交互前端**（面向最终交互的 UI surface），并且都经由 CLI 启动。

- EN: At the moment, `dominds tui` / `dominds run` are “planned / reserved subcommand names” (no stable implementation yet) — but the term “TUI” still denotes the terminal interactive frontend category.
- ZH: 现阶段 `dominds tui` / `dominds run` 属于“规划中/子命令名保留”（无稳定实现）——但术语口径仍使用 TUI 指代该类终端交互前端。

### Tellask（诉请）

- EN: **Tellask** is a Dominds-specific interaction unit: a structured request addressed to an agent.
- ZH: **Tellask（诉请）**是 Dominds 的专有交互单元：一个对智能体发出的结构化请求。

- EN: A Tellask is not casual chat; it is a collaboration action that Dominds can drive, route, and coordinate (including suspend/resume).
- ZH: Tellask 不是随意聊天，而是一种可被 Dominds 驱动、路由、并由系统协调（包括挂起/恢复）的协作动作。

#### Tellask headline（诉请头）

- EN: The first line of a Tellask block, starting with `!?@<name> ...`.
- ZH: 诉请块的第一行，以 `!?@<name> ...` 开头。

- EN: Additional lines starting with `!?@...` in the same block are appended to the headline (they do not start a new Tellask).
- ZH: 同一诉请块内，后续以 `!?@...` 开头的行会被并入诉请头（不会开启新的诉请）。

- EN: Put structured directives such as `!tellaskSession <slug>` in the headline.
- ZH: 结构化指令（例如 `!tellaskSession <slug>`）必须放在诉请头中。

#### Tellask body（诉请内容）

- EN: Lines in the Tellask block that start with `!?` but do not start with `!?@`. They carry the request context (steps, constraints, acceptance criteria, etc.).
- ZH: 诉请块内以 `!?` 开头但不以 `!?@` 开头的行，用于承载诉请内容（步骤、上下文、约束、验收标准等）。

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

##### 会话 Slug（Session Slug）

- EN (directive; headline only): `!tellaskSession <slug>`
- ZH（指令；仅 headline）: `!tellaskSession <slug>`

- EN (parameter name concept): `tellaskSession` (parameter names are English-only; not i18n'd)
- ZH（参数名概念）: `tellaskSession`（参数名只用英文，不做 i18n）

- EN (slug format): short, stable, human-readable (e.g. `ws-schema-v2`, `tooling-read-file-ux`).
- ZH（slug 格式）: 简短、稳定、可读（例如 `ws-schema-v2`、`tooling-read-file-ux`）。

- EN (placement rule): Put `!tellaskSession` in the Tellask headline; do not put it on a second line (it would become body text).
- ZH（位置规则）: `!tellaskSession` 必须写在诉请 headline 中；不要放到第二行（否则会进入 body 变成普通文本）。

##### 多人会话（Multi-Party Sessions）

- EN: The same `<slug>` can be reused across multiple teammates to organize a multi-party collaboration session; this is a recommended communication pattern.
- ZH: 同一个 `<slug>` 可以复用于多个队友，用于组织一次"多人协作会话"；这是推荐的沟通模式。

- EN (user mental model): You are hosting one session and inviting multiple participants.
- ZH（直觉心智模型）: 你在主持一场 session，并邀请多位参与者加入。

- EN (important nuance): Each teammate maintains its own session context; reusing the same `<slug>` is a coordination convention that keeps the workstream aligned across participants.
- ZH（重要细节）: 每个队友各自维护其 session 上下文；复用同一 `<slug>` 是一种"编组/对齐工作流"的协作约定，用于让多方围绕同一条工作线持续推进。

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

- EN (practical guidance): If you need a follow-up after a Fresh Tellask, treat it as a new request and restate necessary context; if you need iterative follow-ups, use `Tellask Session` with `!tellaskSession <slug>`.
- ZH（实践建议）: 如果你在一次性诉请后还要追问，应当把追问当作全新请求并补齐必要上下文；如果你需要可迭代的追问/推进，请使用 `Tellask Session` 并提供 `!tellaskSession <slug>`。

Example / 示例（概念）:

- EN: `!?@<shell-specialist> Please run a single build and paste the failure output.`
- ZH: `!?@<shell-specialist> 请运行一次构建并回贴失败信息。`

### 系统提示可复用的一句话（One-Sentence Summary for System Prompts）

- EN: `TellaskBack` asks the origin dialog for clarification; `Tellask Session` uses `!tellaskSession <slug>` for resumable multi-turn work; `Fresh Tellask` is one-shot and non-resumable.
- ZH: `TellaskBack` 回问发起方澄清；`Tellask Session` 用 `!tellaskSession <slug>` 进行可续用多轮协作；`Fresh Tellask` 是一次性且不可恢复。

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

### Type A/B/C (internal taxonomy) / 内部分类

- EN: The implementation may still use the internal labels **Type A/B/C** to classify teammate-tellask patterns.
- ZH: 实现层仍可能使用 **Type A/B/C** 作为队友诉请形态的内部分类。

- EN: Type A: supdialog call (subdialog calling its direct supdialog); primary syntax `!?@super` (NO `!tellaskSession`).
- ZH: Type A：supdialog call（子对话回问其直接 supdialog）；主语法 `!?@super`（不带 `!tellaskSession`）。

- EN: Type B: registered subdialog call (resumable) keyed by `agentId!tellaskSession`.
- ZH: Type B：registered subdialog call（可恢复），用 `agentId!tellaskSession` 作为 registry key。

- EN: Type C: transient subdialog call (one-shot), not registered.
- ZH: Type C：transient subdialog call（一次性），不注册到 registry。

### `!tellaskSession` / 会话键指令

- EN: Resumable registered subdialogs use `!tellaskSession <key>` in the Tellask headline.
- ZH: 可恢复的注册子对话使用 Tellask headline 内的 `!tellaskSession <key>`。
