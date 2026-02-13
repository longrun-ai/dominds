# Dominds Terminology / Dominds 专有名词表

> EN: Status: Draft / Proposed vocabulary
>
> ZH: 状态：草案 / 提议中的词汇体系

- EN: This document defines Dominds-specific terms and naming intended for system prompts and user/agent-facing docs.
- ZH: 本文档定义 Dominds 的专有名词与对外命名口径，主要用于系统提示与面向智能体/用户的文档。

## Table of Contents

- [Audience / 读者](#audience--读者)
- [使用者语境（User-Facing Vocabulary）](#使用者语境user-facing-vocabulary)
- [通用语境（General Context Vocabulary）](#通用语境general-context-vocabulary)
- [系统实现语境（Implementation-Facing Vocabulary）](#系统实现语境implementation-facing-vocabulary)

---

## Audience / 读者

- EN: The majority of Dominds “users” are **agents**. Human users are a minority (but still important).
- ZH: Dominds 的“用户”主要是**智能体**；人类用户占少数（但同样重要）。

---

## 使用者语境（User-Facing Vocabulary）

- EN: Terms in this chapter may appear in system prompts and in docs written for agents (and sometimes humans).
- ZH: 本章术语会出现在系统提示与面向智能体（以及少量面向人类）的文档中。

### 快速对照（Quick Glossary）

- EN: `Tellask` | ZH: `诉请`
- EN: `Tellask headline` | ZH: `诉请头`
- EN: `Tellask body` | ZH: `诉请正文`
- EN: `tellasker` | ZH: `诉请者`
- EN: `tellaskee` | ZH: `被诉请者`
- EN: `tellasker dialog` | ZH: `诉请者对话`
- EN: `tellaskee dialog` | ZH: `被诉请者对话`
- EN: `TellaskBack` | ZH: `回问诉请`
- EN: `Tellask Session` | ZH: `长线诉请`
- EN: `Fresh Tellask` | ZH: `一次性诉请`
- EN: `Mainline dialog` | ZH: `主线对话`
- EN: `Sideline dialog` | ZH: `支线对话`
- EN: `Taskdoc` | ZH: `差遣牒`
- EN: `Taskdoc package (*.tsk/)` | ZH: `任务包`
- EN: `sessionSlug` | ZH: 会话 Slug（只写在 headline）
- EN: `CLI (entrypoint UI)` | ZH: `CLI（入口界面）`
- EN: `TUI (interactive UI)` | ZH: `TUI（交互前端）`
- EN: `WebUI (interactive UI)` | ZH: `WebUI（交互前端）`

### Dialog Terms（主线对话 / 支线对话）

- EN: **Mainline dialog** is the dialog that carries the canonical shared Taskdoc and is responsible for overall progress.
- ZH: **主线对话**是承载共享差遣牒（Taskdoc）并负责整体推进的那条对话。

- EN: **Only the mainline dialog responder** can call `change_mind`.
- ZH: **只有主线对话主理人**拥有 `change_mind` 权限；支线对话主理人没有。

- EN: A **sideline dialog** is a temporary work dialog for a subtask. Between dialogs/agents, there is no hierarchy — only **tellasker/tellaskee** roles.
- ZH: **支线对话**是为推进某个分项任务临时创建的工作对话。对话/智能体之间没有上下级关系，只有 **诉请者/被诉请者**。

- EN: A **tellasker dialog** is the dialog that issued the current Tellask; it can be the mainline dialog or any sideline dialog.
- ZH: **诉请者对话**是当前诉请的发起对话；它可以是主线对话，也可以是任意支线对话。

- EN: A **tellaskee dialog** is the dialog handling the current Tellask (this dialog).
- ZH: **被诉请者对话**是处理当前诉请的对话（也就是此对话）。

- EN: These are **call roles**, not hierarchy; a tellasker dialog may or may not be the structural supdialog.
- ZH: 这是一次诉请的**角色关系**，不是层级关系；诉请者对话可能是也可能不是结构上的上位对话。

- EN (cross-reference): In implementation-facing docs/code you may see `root dialog` / `main dialog` for “mainline dialog”, and `subdialog` for “sideline dialog”.
- ZH（交叉说明）: 在系统实现语境（文档/代码）中，你可能会看到 **根对话 / 主对话（root dialog / main dialog）** 来指代“主线对话”，以及 **subdialog（子对话）** 来指代“支线对话”。这些实现术语不应出现在使用者语境的提示词/示例中。

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

- EN: The first line of a Tellask block, starting with `tellaskSessionless({ targetAgentId: "<name>", tellaskContent: "..." })`.
- ZH: 诉请块的第一行，以 `tellaskSessionless({ targetAgentId: "<name>", tellaskContent: "..." })` 开头。

- EN: Additional lines starting with `tellask* function call` in the same block are appended to the headline (they do not start a new Tellask).
- ZH: 同一诉请块内，后续以 `tellask* function call` 开头的行会被并入诉请头（不会开启新的诉请）。

- EN: Put structured directives such as `sessionSlug` in the headline.
- ZH: 结构化指令（例如 `sessionSlug`）必须放在诉请头中。

#### Tellask body（诉请正文）

- EN: The `tellaskContent` argument in tellask-special function calls. It carries request context (steps, constraints, acceptance criteria, etc.).
- ZH: tellask-special 函数调用里的 `tellaskContent` 参数，用于承载诉请正文（步骤、上下文、约束、验收标准等）。

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

- EN (meaning): Ask the **tellasker dialog** (the dialog that issued the current Tellask) for clarification instead of guessing.
- ZH（含义）: 当被诉请方需要补充信息时，应**回问诉请者对话**澄清，而不是自行猜测。

- EN (what “Back” means): “Back” refers to routing back to the tellasker dialog; it does **not** imply hierarchy/seniority.
- ZH（Back 的含义）: “Back” 指回到诉请者对话，**不暗示上下级**。

- EN (typical carrier): `tellaskBack({ tellaskContent: "..." }) ...` (only available inside a sideline dialog)
- ZH（典型载体）: `tellaskBack({ tellaskContent: "..." }) ...`（只在你处于支线对话语境时可用）

Example / 示例（概念）:

- EN: `tellaskBack({ tellaskContent: "..." }) I need you to confirm the file extensions: only .md, or also .txt/.rst?`
- ZH: `tellaskBack({ tellaskContent: "..." }) 我需要你确认要扫描的文件扩展名：只包含 .md 还是也包含 .txt/.rst？`

#### 2) Tellask Session（长线诉请）

- EN (term): `Tellask Session`
- ZH（术语）: `长线诉请`

- EN (meaning): Multi-turn collaboration with **resumable context**, suitable for debugging, design alignment, iterative fixes, and sustained UX walkthroughs.
- ZH（含义）: 用于 **可恢复/可续用上下文** 的多轮协作，适合 debug、设计对齐、迭代修复、持续走查等。

##### 会话 Slug（Session Slug）

- EN (directive; headline only): `sessionSlug`
- ZH（指令；仅 headline）: `sessionSlug`

- EN (parameter name concept): `tellaskSession` (parameter names are English-only; not i18n'd)
- ZH（参数名概念）: `tellaskSession`（参数名只用英文，不做 i18n）

- EN (slug format): short, stable, human-readable (e.g. `ws-schema-v2`, `tooling-read-file-ux`).
- ZH（slug 格式）: 简短、稳定、可读（例如 `ws-schema-v2`、`tooling-read-file-ux`）。

- EN (placement rule): Put `sessionSlug` in the Tellask headline; do not put it on a second line (it would become body text).
- ZH（位置规则）: `sessionSlug` 必须写在诉请 headline 中；不要放到第二行（否则会进入 body 变成普通文本）。

##### 多人会话（Multi-Party Sessions）

- EN: The same `<slug>` can be reused across multiple teammates to organize a multi-party collaboration session; this is a recommended communication pattern.
- ZH: 同一个 `<slug>` 可以复用于多个队友，用于组织一次"多人协作会话"；这是推荐的沟通模式。

- EN (user mental model): You are hosting one session and inviting multiple participants.
- ZH（直觉心智模型）: 你在主持一场 session，并邀请多位参与者加入。

- EN (important nuance): Each teammate maintains its own session context; reusing the same `<slug>` is a coordination convention that keeps the workstream aligned across participants.
- ZH（重要细节）: 每个队友各自维护其 session 上下文；复用同一 `<slug>` 是一种"编组/对齐工作流"的协作约定，用于让多方围绕同一条工作线持续推进。

Example / 示例（概念）:

```plain-text
tellask({
  targetAgentId: "server",
  sessionSlug: "ws-schema-v2",
  tellaskContent: "Please confirm the WS packet schema versioning strategy and point to code anchors.\n请确认 WS packet schema 的版本化策略，并指出相关代码锚点。",
})

tellask({
  targetAgentId: "webui",
  sessionSlug: "ws-schema-v2",
  tellaskContent: "Explain which missing fields cause UX degradation along the current WebUI subscribe/render path.\n按当前 WebUI 订阅/渲染路径说明：哪些字段缺失会导致 UX 退化。",
})
```

#### 3) Fresh Tellask（一次性诉请）

- EN (term): `Fresh Tellask`
- ZH（术语）: `一次性诉请`

- EN (meaning): A one-off request with **non-resumable context**.
- ZH（含义）: 一次性请求，且其上下文 **不可恢复**。

- EN (key property): “Fresh/one-shot” is not only “new context”; it also means **no continuation semantics** — later Tellasks are not expected to resume the same session context.
- ZH（关键性质）: “Fresh/一次性”不仅表示“新开上下文”，更表示：**没有后续续话语义** —— 后续诉请不应被期待能自动续接本次一次性诉请的上下文。

- EN (practical guidance): If you need a follow-up after a Fresh Tellask, treat it as a new request and restate necessary context; if you need iterative follow-ups, use `Tellask Session` with `sessionSlug`.
- ZH（实践建议）: 如果你在一次性诉请后还要追问，应当把追问当作全新请求并补齐必要上下文；如果你需要可迭代的追问/推进，请使用 `Tellask Session` 并提供 `sessionSlug`。

Example / 示例（概念）:

- EN: `tellaskSessionless({ targetAgentId: "shell-specialist", tellaskContent: "Please run a single build and paste the failure output." })`
- ZH: `tellaskSessionless({ targetAgentId: "shell-specialist", tellaskContent: "请运行一次构建并回贴失败信息。" })`

### 系统提示可复用的一句话（One-Sentence Summary for System Prompts）

- EN: `TellaskBack` asks the tellasker dialog for clarification; `Tellask Session` uses `sessionSlug` for resumable multi-turn work; `Fresh Tellask` is one-shot and non-resumable.
- ZH: `TellaskBack` 回问诉请者澄清；`Tellask Session` 用 `sessionSlug` 进行可续用多轮协作；`Fresh Tellask` 是一次性且不可恢复。

### 为何保留 `!` 前缀？（Why keep the `!` prefix?）

- EN: The Tellask headline mixes natural language with structured directives; the `!` prefix explicitly marks directives so they are less likely to be confused with ordinary text.
- ZH: 诉请 headline 同时包含自然语言与结构化指令；`!` 前缀用于显式标记指令，从而降低被误读为普通文本的概率。

---

## 通用语境（General Context Vocabulary）

- EN: Terms in this chapter are used across both user-facing prompts and implementation docs. They are “common ground” vocabulary.
- ZH: 本章术语会同时出现在对外提示与实现文档中，属于“共同语境”的统一口径。

### Taskdoc（差遣牒）

- EN: **Taskdoc** (ZH: **差遣牒**) is Dominds's task encapsulation spec: a task contract with three required sections: `goals.md`, `constraints.md`, and `progress.md`.
- ZH: **差遣牒（Taskdoc）**是 Dominds 的任务封装规范：一份任务契约，包含三个必需分段：`goals.md`、`constraints.md`、`progress.md`。

- EN: **Taskdoc package** (ZH: **任务包**) is the on-disk directory ending in `.tsk/` that contains those three section files.
- ZH: **任务包（Taskdoc package）**是落地到磁盘上的目录形态：以 `.tsk/` 结尾的目录，包含上述三个分段文件。

- EN: Taskdocs are the "single source of truth" for team-shared task contracts. They MUST be edited via the explicit control tool `change_mind`; generic file tools are **banned** from reading/writing anything under `**/*.tsk/`.
- ZH: 差遣牒是全队共享任务契约的"单一事实来源"。必须通过显式控制工具 `change_mind` 进行修改；通用文件工具**禁止**读/写 `**/*.tsk/` 下的任何内容。

- EN: Practically: treat the Taskdoc as the task’s **live coordination bulletin board**. If a decision/status/next-step affects others, write it back to `progress` (or `constraints`) — don’t leave it only in chat or reminders.
- ZH: 实践上：把差遣牒当作任务的**实时协调公告板**。任何会影响他人的关键决策/当前状态/下一步，都要写回 `progress`（或 `constraints`），不要只留在对话或提醒项里。

#### Section selector / 分段选择器

- EN: The selector passed to `change_mind`: `goals` / `constraints` / `progress`.
- ZH: `change_mind` 的分段选择器：`goals` / `constraints` / `progress`。

### rtws（运行时工作区）

- EN: **rtws** (runtime workspace) is the directory Dominds treats as its runtime root (by default it is `process.cwd()`, and can be changed via `-C <dir>`). Files like `.minds/` and `.dialogs/` live under the rtws.
- ZH: **rtws（运行时工作区）**是 Dominds 运行时使用的根目录（默认等于 `process.cwd()`，可通过 `-C <dir>` 切换）。诸如 `.minds/`、`.dialogs/` 等运行态目录均位于 rtws 下。

- EN: Wording rule: when the meaning is **rtws**, prefer writing “rtws (runtime workspace)” (or just “rtws” after the first mention) rather than the ambiguous generic “workspace”.
- ZH: 用词规则：当语义指向 **rtws** 时，优先写“rtws（运行时工作区）”（或在已定义后只写“rtws”），避免在对外提示/文档中只写“工作区”从而与其他语境的 workspace/workdir 混淆。

### Tellask（诉请）

- EN: A Dominds-specific interaction unit: a structured request addressed to a dialog participant. **Always use "Tellask" (noun) or "tellask" (verb); never use "ask", "request", "query", or "invocation".**
- ZH: Dominds 的专有交互单元：一个对对话参与方发出的结构化请求。**统一使用"Tellask"（名词）或"tellask"（动词）；避免使用"询问"、"请求"、"查询"、"调用"等变体。**

### Teammate / 队友

- EN: An agent participant in the Dominds dialog system. **Always use "teammate" when referring to agent participants; avoid "member", "agent peer", or "collaborator" in this context.**
- ZH: Dominds 对话系统中的智能体参与者。**统一使用"队友"（teammate）指代智能体参与者；避免使用"成员"、"智能体同伴"、"协作者"等变体。**

- EN: Contrast with "team member" which refers to organizational structure topics.
- ZH: 与"团队成员"（team member）形成对比；后者用于谈论组织结构架设话题。

### Dialog Responder（对话主理人）

- EN: **Dialog Responder** (ZH: **对话主理人**) is the agent role responsible for **responding in and advancing a specific dialog**.
- ZH: **对话主理人（Dialog Responder）**是一个智能体在某个**具体对话**中承担的角色：负责在该对话中**回应并推进**。

- EN: Practical mapping:
  - The dialog responder is identified by the dialog's `agentId` in `dialog.yaml` (implementation field name stays `agentId`).
  - Do NOT call it “dialog agent” in docs/prompts; that phrase is ambiguous.
- ZH: 落地映射：
  - 对话主理人在实现上由 `dialog.yaml` 中的 `agentId` 指定（实现字段名仍为 `agentId`）。
  - 在文档/提示词中不要使用 “对话智能体” / “dialog agent” 这类不正规表述，它会与“智能体（agent）作为参与者”的泛称混淆。

### Q4H (Question for Human) （向人类的诉请）

- EN: A mechanism for raising questions to humans, initiated via `askHuman({ tellaskContent: "..." })`, which suspends dialog progression until the human responds. **Always use "Q4H" (capital Q, numeral 4, capital H); never use "Q-for-H", "QforH", or "4-hour".**
- ZH: 一种通过 `askHuman({ tellaskContent: "..." })` 向人类提问的机制，暂停对话进度直到人类响应。**统一使用"Q4H"（大写 Q、数字 4、大写 H）；禁止使用"Q-for-H"、"QforH"、"每四小时"等变体。**

### Fresh Boots Reasoning（扪心自问）

- EN: **Fresh Boots Reasoning (FBR)** — reasoning from first principles without relying on existing dialog history. **Use "Fresh Boots Reasoning" or its abbreviation "FBR" interchangeably; never use "bootstrapping" or "fresh start reasoning".**
- ZH: **扪心自问（FBR）**：Fresh Boots Reasoning——从第一性原理出发，不依赖既有对话历史的推理方式。**统一使用全称"扪心自问"或缩写"FBR"；禁止使用"自举推理"、"从零思考"等变体。**

- EN: Here, “Fresh Boots / 初心” carries two layers: (1) a Chinese idiom “wear new shoes, don’t step in dog poop” (even if the task you’re sent to do is bullshit, returning to “fresh boots / 初心” helps you still find some meaning in it), and (2) “return to your original aspiration, and you can see it through” (intentionally reset to a cleaner, more reliable first-principles/task-contract view).
- ZH: 这里的“Fresh Boots / 初心”取自两层含义：① 俗语“穿新鞋不踩狗屎”（你被安排去做的事情再狗屎，藉以初心，总还是能找到它的某些意义的）；② “回归初心，方得始终”（刻意回到更干净、更可信的第一性原理与任务契约上）。

### clear_mind（清理头脑）

- EN: A function tool that clears the agent's short-term working memory (dialog history, tool outputs) while preserving Taskdoc, reminders, and memories.
- ZH: 一个函数工具，用于清空智能体的短期工作记忆（对话历史、工具输出），同时保留差遣牒、提醒项与记忆层。

- EN: `clear_mind` starts a **new dialog course** (in a multi-course dialog).
- ZH: `clear_mind` 会在**多程对话**中开启对话的**新一程**。

- EN: After `clear_mind`, the agent should have a "Continuation Package" prepared for quick resumption.
- ZH: `clear_mind` 后，智能体应准备好"接续包"以便快速接续工作。

### Dialog Course（某一程对话）

- EN: **Dialog course** (ZH: **某一程对话**) is the Dominds-specific term for **one dialog-workspace segment** within a dialog.
- ZH: **某一程对话（dialog course）**是 Dominds 的专有术语，指一次对话中的**一个“对话工作区段”**。

- EN: Key properties:
  - A course is the unit of **mental clarity reset**: `clear_mind` clears dialog noise and starts a new dialog course.
  - A course is **not** the same as one model inference (“LLM round”) nor a business iteration.
  - A course is the unit for persistence streams: `.dialogs/**/course-###.jsonl` stores events for that course.
- ZH: 关键特性：
  - 一程是**清理头脑的边界**：`clear_mind` 会清空对话噪声并开启新一程。
  - 一程**不等于**一次模型推理（LLM “轮次”）也不等于业务迭代。
  - 一程对应持久化的事件流单位：`.dialogs/**/course-###.jsonl` 记录该程的事件。

- EN: In Dominds terminology, avoid generic labels like “round” when referring to a dialog course; and for the role, use “Dialog Responder” (not “dialog agent”).
- ZH: 在 Dominds 语境中指代“某一程对话”时，避免使用“轮次”等泛化词，也不要使用“对话程”这种语感奇怪的说法；指代角色时用“对话主理人”而不是“对话智能体”。

### Multi-course Dialog（多程对话）

- EN: **Multi-course dialog** (ZH: **多程对话**) means a dialog can progress through **multiple courses**, with each course being a fresh dialog workspace.
- ZH: **多程对话（multi-course dialog）**指同一个对话可以拥有**多段过程**；每一程都像一次“重新开工”的对话工作区。

- EN: Course creation (how a new course starts):
  - The **first course** exists naturally when a mainline dialog or sideline dialog is created.
  - After that, a **new course** is started when the dialog responder calls `clear_mind`.
  - Exception: the system may auto-start a new course for remediation (e.g., context health becomes critical).
- ZH: “一程”如何产生（新一程如何开始）：
  - **第一程**：随着主线对话/支线对话的创建自然产生。
  - **之后每一程**：通常由对话主理人调用 `clear_mind` 开启。
  - 例外：系统可能出于恢复目的自动开启新一程（例如上下文健康度进入 critical 后触发自动清理）。

### Continuation Package / 接续包

- EN: A scannable, actionable info package helping agents resume after `clear_mind`. Contains: (1) first step, (2) key info (files/symbols), (3) run info (commands/ports), (4) volatile details (paths/IDs/URLs).
- ZH: 可扫描、可操作的信息包，帮助智能体在 `clear_mind` 后快速接续工作。包含：① 第一步操作，② 关键定位信息，③ 运行/验证信息，④ 临时细节（路径/ID/URL）。
- ZH 术语：**接续包**（禁止使用"恢复包"、"检查点包"等变体）。

### Reminder（提醒项）

- EN: A short-lived, high-frequency work item tied to the current run (not persisted). Reminders help agents track next steps, critical details, or pending tasks. They are managed by the `add_reminder`, `update_reminder`, `delete_reminder` function tools.
- ZH: 一种短期、高频的工作项，与当前运行绑定（不持久化）。提醒项帮助智能体追踪下一步、关键细节或待办事项。通过 `add_reminder`、`update_reminder`、`delete_reminder` 函数工具管理。
- ZH 术语：**提醒项**（禁止使用"便签"、"备注"、"待办"等变体）。

### Memory（分层记忆）

- EN: The persistent knowledge store in Dominds, consisting of layers: personal memory, team memory, and shared minds. **Always use "Memory" (singular) as the concept name; use "minds" (plural) only when referring to the directory/collection.**
- ZH: Dominds 中的持久化知识库，由多个层级组成：个人记忆、团队记忆、共享记忆。**统一使用"Memory"（单数）作为概念名；只有指代目录/集合时才使用"minds"（复数）形式。**

- EN: Do NOT use "Mind" as a synonym for the concept name. In Dominds docs/prompts, "minds" usually refers to a directory/collection (e.g. `.minds/`), while "memory" (lowercase) refers to individual entries.
- ZH: 不要把"Mind"当作概念名的同义词。在 Dominds 的文档/提示词中，"minds"通常指目录/集合（例如 `.minds/`）；"memory"（小写）指代其中的单个条目。

### Diligence Push（鞭策）

- EN: A proactive continuation mechanism that nudges an agent forward when it's idle or blocked (a "Diligence Push"), using configurable prompts and budget limits. **Always use "Diligence Push"; never use "keep-going", "勤奋", "proactive-push", or "auto-continue".**
- ZH: 一种主动继续机制，在智能体空闲或阻塞时通过可配置的提示词和预算上限进行"鞭策"。**统一使用"鞭策"；禁止使用"保持运行"、"勤奋"、"自动继续"、"催促"等变体。**

- EN: Related terms: "Diligence Push prompt" (prompt file), "Diligence Push-max" config, "Diligence Push injection" (prompt injection).
- ZH: 相关术语："鞭策提示词"（提示词文件）、"鞭策上限"（配置项）、"鞭策注入"（注入机制）。

### 用词原则：者 / 器 与 -or / -er

#### 中文：用"者"指代智能体角色，用"器"指代软件工具

- EN: When referring to a **role played by an agent** (intelligent actor), use the suffix **"-者"** (e.g., "管理者" instead of "管理器").
- ZH: 当指代**智能体承担的角色**时，用 **"-者"**（例如："团队管理者"而非"团队管理器"）。

- EN: When referring to a **software tool or utility**, use the suffix **"-器"** (e.g., "调度器", "解析器").
- ZH: 当指代**软件工具/组件**时，用 **"-器"**（例如："调度器"、"解析器"）。

- EN: The distinction prevents ambiguity between automated agents and static tools.
- ZH: 区分智能体（动态角色）与工具（静态组件）。

#### 英文：优先使用 -or 而非 -er

- EN: For agent roles, prefer **"-or"** (e.g., "operator", "monitor") over **"-er"** where possible (e.g., avoid "handler" when "operator" conveys intent better).
- ZH: 智能体角色优先用 **"-or"** 结尾（例如：operator、monitor），尽量避免用 **"-er"**（例如：能用 operator 明确语义时，不用 handler 这类更泛化/更像工具名的词）。

- EN: This preference is a naming convention for clarity, not a strict linguistic rule.
- ZH: 这是一条偏工程化的命名口径，用于提升可读性，并非严格的语言学规则。

> Note / 备注
>
> - EN: Some established terms may be exceptions for clarity (e.g., **Dialog Responder**).
> - ZH: 个别既有/更清晰的术语可能作为例外保留（例如：**Dialog Responder**）。

---

## 系统实现语境（Implementation-Facing Vocabulary）

- EN: This chapter defines implementation-facing terms used in [`dialog-system.md`](./dialog-system.md) and in the runtime/server code.
- ZH: 本章定义系统实现语境下的术语，供 [`dialog-system.md`](./dialog-system.md) 及 runtime/server 代码对齐使用。

### Dialog / 对话

- EN: A **dialog** is a persisted, driveable conversation state machine.
- ZH: **对话（dialog）**是一个可持久化、可被后端驱动的对话状态机。

### Supdialog / 上位对话

- EN: A **supdialog** ("super dialog") is the orchestrating dialog in a hierarchical dialog relationship. It spawns subdialogs, provides context/objectives, and receives results/questions/escalations from its subdialogs.
- ZH: **supdialog（上位对话）**是在层级对话关系中负责编排的对话：它创建 subdialog，提供上下文/目标，并接收 subdialog 的结果/问题/升级请求。

- EN: A supdialog may receive **TellaskBack calls** from its subdialogs during execution.
- ZH: supdialog 在执行过程中可能接收来自 subdialog 的 **TellaskBack call（回问诉请）**。

### Subdialog / 子对话

- EN: A **subdialog** is a specialized dialog spawned by a supdialog to handle a subtask with fresh (or session-resumed) context.
- ZH: **subdialog（子对话）**是由 supdialog 派生出来用于处理子任务的专用对话，具备相对独立的上下文（可能是新开或按会话 key 恢复）。

### Root Dialog / 根对话

- EN: A **root dialog** (aka **main dialog**) is the top-level dialog with no supdialog.
- ZH: **根对话（root dialog / main dialog）**是层级最顶层的对话，不存在 supdialog。

### Type A/B/C (internal taxonomy) / 内部分类

- EN: The implementation may still use the internal labels **Type A/B/C** to classify teammate-tellask patterns.
- ZH: 实现层仍可能使用 **Type A/B/C** 作为队友诉请形态的内部分类。

- EN: Type A: TellaskBack call (a subdialog asking back to its tellasker dialog); primary syntax `tellaskBack({ tellaskContent: "..." })` (NO `sessionSlug`).
- ZH: Type A：回问诉请（子对话回问其诉请者对话）；主语法 `tellaskBack({ tellaskContent: "..." })`（不带 `sessionSlug`）。

- EN: Type B: registered subdialog call (resumable) keyed by `agentId!sessionSlug`.
- ZH: Type B：registered subdialog call（可恢复），用 `agentId!sessionSlug` 作为 registry key。

- EN: Type C: transient subdialog call (one-shot), not registered.
- ZH: Type C：transient subdialog call（一次性），不注册到 registry。

### `sessionSlug` / 会话 Slug 指令

- EN: Resumable registered subdialogs use `sessionSlug` in the Tellask headline.
- ZH: 可恢复的注册子对话使用 Tellask headline 内的 `sessionSlug`。
