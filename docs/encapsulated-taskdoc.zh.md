# 封装式差遣牒（Taskdoc，`*.tsk/`）（设计）

英文版：[English](./encapsulated-taskdoc.md)

本文档为 Dominds 对话指定了一个**结构化的、封装的差遣牒（Taskdoc）格式**。

不是单一的可变“差遣牒（Taskdoc）” markdown 文件；每个对话树的差遣牒落到磁盘上是一份**任务包目录**，具有稳定的模式和严格的访问策略。

## 目标

- **清晰性**：将"我们想要什么"（目标）与"我们必须遵守什么"（约束）以及"我们在哪里"（进度）分开。
- **实时协调**：把差遣牒（Taskdoc）作为跨主线/跨智能体的**任务实时协调公告板**（频繁更新 `progress.md`；把硬约束写入 `constraints.md`；不要把关键决策只留在对话里）。
- **持久性**：使任务状态在长期工作和多程对话重置之间保持持久。
- **可审计性**：使任务变更明确且可归因于单一、有意的操作。
- **安全性**：防止绕过预期用户体验和控制点的意外或工具驱动的读/写。
- **可共享性**：确保差遣牒在整个对话树（根 + 子对话）中可见/一致。

## 非目标

- 替换提醒、Q4H 或智能体内存（这些仍然是单独的机制）。
- 设计通用项目管理格式（工单、史诗、多任务看板）。
- 支持任务包内的任意二进制资产（超出 v1 范围）。

## 术语

- **对话树**：根对话加上在其下产生的任何子对话/队友。
- **差遣牒（Taskdoc）**：一份任务契约（目标/约束/进度），同时也是跨主线/跨智能体的任务实时协调公告板。
- **任务包（Taskdoc package）**：以 `.tsk/` 后缀结尾的目录，将差遣牒存储为多个文件。
- **有效差遣牒（effective Taskdoc）**：呈现给智能体的逻辑差遣牒内容，从任务包派生而来。
- **封装**：将 `.tsk/` 视为受保护的内部状态，而不是普通 rtws（运行时工作区）文件。

## 任务包结构

任务包是后缀为 `.tsk/` 的目录（例如 `my-task.tsk/`），包含：

- `goals.md`（必需）
- `constraints.md`（必需）
- `progress.md`（必需）
- （可选）注入的"牢记在心"章节目录 `bearinmind/`（见下文）
- （可选）额外的**应用程序特定**文件和目录（对通用文件工具只读）

### 文件含义

#### `goals.md`

意图和成功标准。

- 应表述为成果。
- 应在时间上保持稳定；使用 `progress.md` 处理日常变化。

#### `constraints.md`

硬性要求和禁止。

- 必须包括任何相关的策略规则、安全规则、格式化要求、范围限制和不变量。
- 应写为清晰的、可测试的陈述（优先使用 "MUST/SHOULD/MUST NOT"）。

#### `progress.md`

当前状态、已做出的决定以及剩余内容。

- 应可以安全地频繁更新。
- 可以包括清单、简短日志和决策记录。
- 应避免重复完整的对话历史；保持简洁且可操作。

### 可选注入目录：`bearinmind/`（设计）

Dominds 可以在任务包内支持一个特殊的子目录 `bearinmind/`。

设计目标：

- 为"永远记住/绝不能忘记"的内容提供一个小的、稳定的地点，与 `constraints.md` 不同。
- 保持提示词大小可预测，避免运行时可配置的注入。

#### 允许的文件（固定白名单；最多 6 个）

如果 `bearinmind/` 存在，它最多可以包含 **6** 个固定名称的文件：

- `contracts.md`
- `acceptance.md`
- `grants.md`
- `runbook.md`
- `decisions.md`
- `risks.md`

硬性规则：

- 具有这些名称的文件不得出现在 `bearinmind/` 之外。
- 相反，`goals.md`、`constraints.md`、`progress.md` 不得出现在任何子目录下。
- `bearinmind/` 下不允许其他文件。

未来扩展只能通过产品/设计更改（扩展白名单）进行；它不得是运行时可配置的。

### 额外文件（应用程序特定）

运行时可以为内部需要在任务包内存储额外文件（例如：`snapshots/`、`attachments-index.md`）。

设计约束：

- 这些文件不得被视为普通 rtws（运行时工作区）文件。
- 它们不得通过普通文件工具编辑。
- 如果任何文件对用户可见，必须通过明确的 UI 工具而非原始文件读取来呈现。

## 有效差遣牒（用于智能体上下文）

Dominds 必须从任务包构造一个**有效差遣牒**用于提示词和 UI 显示。

规范结构（v1）：

1. 稳定的标题，指示这是对话树的差遣牒
2. `## Goals` 后跟 `goals.md` 的内容
3. `## Constraints` 后跟 `constraints.md` 的内容
4. `## Progress` 后跟 `progress.md` 的内容

### 提示词注入规则（设计）

有效差遣牒是系统提示词注入智能体上下文的内容。

注入必须是确定性的和有界的：

- 始终注入顶层三段（`goals.md`、`constraints.md`、`progress.md`）。
- 仅从固定白名单 `bearinmind/` 目录可选注入 `## Bear In Mind` 块。
- 其他子目录或文件不会作为正文内容注入（可能会显示额外章节的索引以供发现；内容必须通过 `recall_taskdoc` 读取）。

如果存在，注入的 `## Bear In Mind` 块必须出现在 `## Constraints` 和 `## Progress` **之间**。

如果存在，注入的 `bearinmind/` 部分必须按此固定顺序出现：

1. `contracts.md`
2. `acceptance.md`
3. `grants.md`
4. `runbook.md`
5. `decisions.md`
6. `risks.md`

### 规范系统/工具副本（MUST）

系统提示词和向智能体展示的任何工具文档必须明确以下几点：

1. `.tsk/` 封装限制
2. 提示词注入规则（什么是自动注入到上下文中）

下面是规范副本。如果需要为 UI 布局重新表述，必须保留语义。

#### 规范副本（zh；语义基线）

**Taskdoc 封装与访问限制**

- 任何 `.tsk/` 目录及其子路径（`**/*.tsk/**`）都是封装状态：禁止使用任何通用文件工具读取/写入/列目录（例如 `read_file` / `write_file` / `list_dir` 等）。
- 更新 Taskdoc 只能使用函数工具 `change_mind`（按章节整段替换；顶层用 `selector`，额外章节用 `category + selector`）。
- 读取"不会自动注入上下文"的额外章节，只能使用函数工具 `recall_taskdoc({ category, selector })`。

**Taskdoc 自动注入规则（系统提示）**

- 系统提示会把"有效 Taskdoc"自动注入到模型上下文中。
- 一定会注入顶层三段：`goals.md`、`constraints.md`、`progress.md`（按此顺序）。
- 可选注入 `bearinmind/`（仅固定白名单，最多 6 个文件）：`contracts.md`、`acceptance.md`、`grants.md`、`runbook.md`、`decisions.md`、`risks.md`。
- 若存在 `bearinmind/` 注入块，它会以 `## Bear In Mind` 出现在 `## Constraints` 与 `## Progress` 之间，并按以上固定顺序拼接。
- 除此之外，`.tsk/` 内任何其他目录/文件都不会被自动注入正文（系统只会注入一个"额外章节索引"用于提示；需要时用 `recall_taskdoc` 显式读取）。

#### 参考副本（en；必须与 zh 匹配）

**Taskdoc encapsulation & access restrictions**

- Any `.tsk/` directory and its subpaths (`**/*.tsk/**`) are encapsulated state: general file tools MUST NOT read/write/list them (e.g. `read_file` / `write_file` / `list_dir`).
- Taskdoc updates MUST go through the function tool `change_mind` (whole-section replace; use top-level `selector`, or `category + selector` for extra sections).
- To read extra sections that are NOT auto-injected, use the function tool `recall_taskdoc({ category, selector })`.

**Taskdoc auto-injection rules (system prompt)**

- The system prompt auto-injects the "effective Taskdoc" into the model context.
- It always injects the three top-level sections in order: `goals.md`, `constraints.md`, `progress.md`.
- It may also inject `bearinmind/` (fixed whitelist only; max 6 files): `contracts.md`, `acceptance.md`, `grants.md`, `runbook.md`, `decisions.md`, `risks.md`.
- If present, the injected block appears as `## Bear In Mind` between `## Constraints` and `## Progress`, and the files are concatenated in the fixed order above.
- No other directories/files inside `.tsk/` are auto-injected as body content (only an "extra sections index" may be injected for discoverability; use `recall_taskdoc` when needed).

注意：

- 有效差遣牒必须是确定性的（除了上述框架之外没有隐藏的重新格式化）。
- 允许空部分，但文件仍然存在。

## `change_mind` 语义（不开启新一程对话）

函数工具 `change_mind` 通过**替换其整个内容**来更新任务包的**恰好一个**部分文件。

关键点：

- `change_mind` 不开启新一程对话。
- 如需开启新一程对话，请单独调用函数工具 `clear_mind({ "reminder_content": "<接续包>" })`（或其他对话过程控制机制）。
  - 建议：包含一个有效的接续包，以便智能体在下一程对话流畅接续。

### 参数（当前）

`change_mind` 通过**替换其整个内容**来更新**恰好一个**差遣牒分段。

它接受：

- `selector`（必需）
- `content`（必需）
- `category`（可选）

当 `category` 缺失/为空时，`selector` 指向**顶层**部分文件：

- `goals`
- `constraints`
- `progress`

当提供 `category` 时，`selector` 指向任务包内 `<category>/` 下的文件。

保留的选择器及其允许的位置：

- 仅顶层（无 category）：`goals`、`constraints`、`progress`
- 仅 `category="bearinmind"`：`contracts`、`acceptance`、`grants`、`runbook`、`decisions`、`risks`

其他类别：

- `category` 必须是安全标识符（例如 `ux`、`ux.checklists`）
- `selector` 必须是安全标识符
- 目标文件路径是 `<category>/<selector>.md`

硬性禁止：

- `goals|constraints|progress` 不得在任何类别目录下编写。
- `contracts|acceptance|grants|runbook|decisions|risks` 不得在 `category="bearinmind"` 之外编写。
- 没有其他类别会自动注入系统提示（只会显示一个索引）。

### `recall_taskdoc`（只读；用于非自动注入的部分）

因为通用文件工具无法读取 `*.tsk/` 下的任何内容，Dominds 提供了一个专门的读取工具：

```
recall_taskdoc({ category, selector })
```

行为：

- 读取 `bearinmind/<whitelisted>.md` 或 `<category>/<selector>.md`。
- 顶层三段（`goals` / `constraints` / `progress`）已经自动注入，因此 `recall_taskdoc` 不会读取它们。

示例（bearinmind）：

```text
使用函数工具 `change_mind` 调用：
{ "selector": "grants", "category": "bearinmind", "content": "- Allowed: ...\n- Disallowed: ...\n" }
```

示例（额外类别）：

```text
使用函数工具 `recall_taskdoc` 调用：
{ "category": "ux", "selector": "checklist" }
```

示例：

```text
使用函数工具 `change_mind` 调用：
{ "selector": "constraints", "content": "- MUST not browse the web.\n- MUST keep responses under 10 lines unless asked otherwise.\n" }
```

### 行为规则

- `(category, selector)` 对必须根据上述保留选择器规则有效；其他任何内容都是错误。
- 正文被视为不透明的 markdown 文本；不暗示部分修补/差异语义。
- 成功的 `change_mind` 会立即更新任务包，并对以下内容可见：
  - 当前对话
  - 对话树中的所有子对话/队友
  - 任何观察的 WebUI 客户端

### 失败情况（非穷尽）

如果满足以下条件，`change_mind` 必须被拒绝：

- 选择器缺失或无效。
- 正文缺失（仅当明确支持时才允许空正文；v1 应拒绝空正文以防止错误）。
- 调用尝试定位定义集之外的文件。

## 文件工具封装策略（`**/*.tsk/`）

所有通用文件系统工具（读/写/列/移动/删除）必须将 `**/*.tsk/` 下的任何路径视为**禁止**。

- 读取必须被拒绝（即使文件存在）。
- 写入必须被拒绝（包括创建/覆盖/追加）。
- 目录列表不得泄露 `.tsk/` 的内容（最多只能显示目录名称存在）。

理由：

- 防止通过通用文件操作进行意外编辑。
- 强制通过明确的、有语义的操作（`change_mind`）进行差遣牒变更。
- 避免智能体"好心"地在没有明确意图的情况下重写任务约束这类提示词/控制流陷阱。

系统提示词（和向智能体展示的任何工具文档）必须明确说明此限制。

## UX 预期（设计级）

- WebUI 应将差遣牒渲染为三个窗格/选项卡（目标/约束/进度）和可选的组合视图。
- WebUI 应使编辑明确：当用户更改一个部分时，必须清楚正在替换哪个部分。
- WebUI 应显示每个部分的简短"最后更新"指示器（时间 + 参与者）以支持可审计性。

## 兼容性考虑

Dominds 应将 `*.tsk/` 任务包标准化为**唯一**支持的差遣牒存储格式。

如果 rtws 以前使用单文件 `.md` 差遣牒，它们必须在运行新对话之前迁移到 `*.tsk/` 任务包。

## 安全与完整性说明

- `.tsk/` 包是**高完整性状态**：它可以实质性地改变智能体行为和安全边界。
- 封装减少了隐蔽编辑的机会（例如，通过复制文本中嵌入的工具调用）。
- 强烈建议使用审计元数据（谁/何时）进行事件分析和用户信任。

## 开放问题

- 任务包默认应该放在哪里（在对话持久化下、在启动入口旁边，还是专用 rtws 子目录）？
- `change_mind` 是否应该允许显式设置空的部分正文（用于有意的清空）？
