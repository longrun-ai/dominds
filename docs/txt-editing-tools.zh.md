---
title: 文本编辑工具（ws_mod）— 设计文档
status: implemented
updated: 2026-06-10
---

# 文本编辑工具（ws_mod）设计文档（以当前实现为准）

英文版：[English](./txt-editing-tools.md)

> 中文语义为准；英文段落仅为同步摘要（由中文派生）。  
> 本文是"整体/综合"设计文档；运行时会把相同层级的综合指南注入到 `ws_mod` toolset 的系统提示里，因此每个工具自身的 `usageDescriptionI18n` 只保留"本工具接口契约"，不再重复综合工作流与大量示例。

## 0. 当前状态与实现入口

- 状态：已实现（breaking change：无旧工具兼容层）
- 主要实现文件：
  - 工具实现：`dominds/main/tools/txt.ts`
  - toolset 元信息（含 prompt）：`dominds/main/tools/builtins.ts`、`dominds/main/tools/registry.ts`、`dominds/main/tools/prompts/*`
  - prompt 注入机制：`dominds/main/tools/registry.ts`、`dominds/main/minds/load.ts`

## 1. 背景：为什么要"prepare-first + 单 apply"

历史上文本编辑工具存在"直接写入 vs 先 plan 再 apply"等多套心智并存，导致：

- agent 在低注意力状态下容易"误写"或难以复核（缺少 diff/evidence）。
- prepare→apply 之间存在竞态：同一条消息中工具并行执行，可能出现"prepare 基于旧文件，但另一工具已写入"的时序问题。
- apply 入口分裂，学习成本高、回归成本高。

因此统一为：

- **prepare-first**：所有增量编辑先规划（输出可审阅 diff + evidence + hunk_id）。
- **single apply**：所有计划类编辑仅通过 `apply_file_modification({ "hunk_id": "<hunk_id>" })` 落盘。
- **移除旧工具**：`append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace` 已彻底删除（无 alias、无兼容层）。

## 2. 目标与非目标

### 2.1 目标

- 把增量编辑统一为：`prepare_*` → `apply_file_modification`。
- 提供可复核输出：YAML summary + evidence（plan）/apply_evidence（apply） + unified diff。
- 明确并发/时序约束：避免在同一条消息中把 prepare 与 apply 混在一起。
- 给出稳定的失败模式与下一步建议（尤其是锚点歧义与 apply rejected）。

### 2.2 非目标

- 不做复杂 patch DSL（仍以 unified diff 为主）。
- 不保证跨进程/重启的 hunk 持久化（当前 hunk registry 为进程内内存 + TTL=1h）。
- 不承诺"自动格式化/自动空行风格对齐"；只做可观测（style_warning）与最小必要规范化（EOF 换行）。

## 3. 工具集提示（i18n）设计

### 3.1 需求

- "综合使用指南/示例/工作流"应由 toolset 提供（因为它是组合能力，不属于单一工具）。
- 单个工具的 `usageDescriptionI18n` 只需要描述该工具自身的接口契约与最小注意事项。

### 3.2 机制（当前实现）

- `ToolsetMeta` 支持 toolset 级 prompt（`I18nText`，目前 `en|zh`），用于 **man\_<toolset> 手册** 的按需读取（不自动注入 system prompt）。
- 当前实现使用 `promptFilesI18n`：把综合指南放到 markdown 文件中，**仅在调用 man\_<toolset> 时读取**（no cache）。
  - `ws_mod`：
    - `dominds/main/tools/prompts/ws_mod.zh.md`
    - `dominds/main/tools/prompts/ws_mod.en.md`

## 4. 工具面（ws_mod 内与文本编辑相关）

### 4.1 支撑工具（读/定位/审阅）

- `read_file`（函数工具）：带上限/可选行号装饰的只读查看（用于复核与定位）。
- `ripgrep_*`（函数工具）：定位锚点与候选片段（`ripgrep_snippets` 通常最有用）。

### 4.2 原始写入工具（例外）

- `create_new_file`（函数工具）：创建新文件（不走 prepare/apply），允许空内容。  
  设计定位：解决"创建空文件/新文件"不应被迫走增量编辑；同时避免误用 `overwrite_entire_file`（它的语义是覆盖既有文件）。  
  行为：若目标已存在则拒绝（`FILE_EXISTS`/`NOT_A_FILE`）；不存在则创建父目录并写入内容。  
  规范化：若 `content` 非空且末尾缺少 `\n`，则补齐并在输出中显示 `normalized_trailing_newline_added=true`。  
  输出：成功/失败均为 YAML（便于脚本化与回归）。

- `overwrite_entire_file`（函数工具）：整文件覆盖写入（**不走 prepare/apply**）。  
  使用建议：先用 `read_file` 获取 `total_lines/size_bytes` 作为 `known_old_total_lines/known_old_total_bytes` 的对账输入。  
  设计定位：用于"新内容很小（例如 <100 行）"或"明确为重置/生成物"的场景；其他情况优先 prepare/apply。  
  护栏（强制）：必须提供 `known_old_total_lines/known_old_total_bytes`（旧文件快照）才允许执行；若对账不匹配则拒绝覆盖。  
  `content_format`：可选文本提示，任意非空字符串都可接受（例如 `yaml` / `toml` / `json` / `markdown`）。  
  护栏（默认拒绝）：若正文疑似 diff/patch，且未显式声明 `content_format=diff|patch`，则默认拒绝并引导改用 prepare/apply（避免把 patch 文本误写进文件）。  
  限制：不负责创建文件；创建空文件/新文件请用 `create_new_file`；创建"带非空初始内容"的新文件可用 `prepare_file_append create=true` → `apply_file_modification`。

### 4.3 增量编辑（prepare-first）

- `prepare_file_range_edit`：按行号范围预览 replace/delete/append（append 通过 `N~` 且 `N=(last_line+1)`）。
- `prepare_file_append`：预览追加到 EOF（可选 `create=true|false`）。
- `prepare_file_insert_after` / `prepare_file_insert_before`：按锚点行预览插入（prepare 阶段严格处理歧义；锚点多次出现必须指定 `occurrence`）。
- `prepare_file_block_replace`：按 start/end 锚点预览块替换（可配置 `include_anchors` / `require_unique` / `strict` / `occurrence` 等）。
  - `include_anchors=true`（默认）：保留 start/end anchor 行，仅替换两者之间的内容。
  - `include_anchors=false`：替换范围包含 start/end anchor 行（会删除 anchor 行并以新内容替换）。
- `apply_file_modification`：唯一 apply，能应用来自上述任意 `prepare_*` 的 hunk（range/append/insert/block_replace）。

## 5. 关键并发约束与顺序建议

### 5.1 工具并行执行

同一条消息中的多个工具调用会并行执行，互相不可见输出/写入。因此：

- **prepare → apply 必须分两条消息**（否则 apply 可能"看不到"本轮刚生成的 hunk）。

### 5.2 apply 的并发安全（当前实现）

- 同一文件的多个 `apply_file_modification` 会在进程内按队列串行化（按 `createdAtMs`、再以 `hunkId` 作为 tie-breaker）。
- 不同文件的 apply 可并行，不共享锁。

## 6. hunk registry 与生命周期

### 6.1 生命周期与所有权

- 每个 plan hunk 带 TTL（输出 `expires_at_ms`）。
- hunk 存储于进程内内存；进程重启后丢失。
- prepare 结果在 apply 前不会落盘；此时再次读取文件仍只能看到旧内容。若想基于该结果继续下一笔修改，必须先 apply 当前 hunk，再重新 prepare。
- `apply_file_modification` 会检查：
  - hunk 是否存在且未过期
  - hunk 是否由当前成员规划（`WRONG_OWNER` 拒绝）
  - 当前成员是否有写权限（`hasWriteAccess`）

### 6.2 "覆写同一规划"的规则（重要）

支持"带 `existing_hunk_id` 重新 plan 覆写"的工具与规则：

- `prepare_file_range_edit`：支持 `existing_hunk_id`，但该 id 必须已存在、归属当前成员、且模式匹配（不能拿别的 prepare 模式的 id 来覆写）。
- `prepare_file_append` / `prepare_file_insert_after` / `prepare_file_insert_before`：同样支持 `existing_hunk_id` 覆写同模式预览。
- `prepare_file_block_replace`：支持 `existing_hunk_id` 覆写同模式预览（同 owner / 同 kind；跨模式拒绝）。
- 所有 plan 工具都**不允许自定义新 id**：只能通过"省略/清空 `existing_hunk_id`"来生成新规划；只有当你想覆写既有规划时才传入 `existing_hunk_id`。

> 注意：有些 provider（例如 Codex）会要求函数工具的参数字段都"必填"（schema 全 required）。  
> 如果你用的是这类 provider，但语义上想表达"未指定/使用默认"，再用哨兵值表达"未指定"；否则（大多数 provider）**省略可选字段即可**：
>
> - `existing_hunk_id: ""`：不覆写旧规划（生成新 hunk）。
> - `occurrence: ""` 或 `0`：不指定 occurrence。
> - `match: ""`：使用默认 `contains`（注意：`match` 是 match mode，不是要匹配的文本/正则）。
> - `read_file({ range: "", max_lines: 0 })`：分别表示"不指定范围 / 使用默认 500 行"。
> - `overwrite_entire_file({ content_format: "" })`：表示"未显式声明内容格式"（此时若正文强特征疑似 diff/patch 将默认拒绝写入）；若显式提供任意非空标签（例如 `yaml`），工具会原样接受，但只有 `diff` / `patch` 具有放行 diff/patch 字面量的特殊语义。
> - `ripgrep_*({ path: "", case: "", max_files: 0, max_results: 0 })`：分别表示"默认路径 '.' / 默认 smart-case / 使用默认上限"。

## 7. 规范化策略（当前实现）

### 7.1 EOF 换行规范化（硬规则）

写入遵循"每行以 `\n` 结尾（包括最后一行）"：

- 若文件末尾无换行，写入前会补齐 `\n`（`normalized_file_eof_newline_added`）。
- 若正文末尾无换行，写入前会补齐 `\n`（`normalized_content_eof_newline_added`）。
- 计划输出与应用输出都会带 `normalized.*` 字段以便复核。

### 7.2 空行风格（仅可观测）

对 append/insert，prepare 阶段会输出 `blankline_style` 与 `style_warning`，用于提示"可能产生双空行/粘行"等风险；当前不主动改变正文空行风格。

## 8. YAML 输出契约（以当前实现为准）

> 目标：低注意力可扫读；稳定字段便于工具链/回归。

### 8.1 Plan（共同字段）

- `status: ok|error`
- `mode: prepare_file_range_edit|prepare_file_append|prepare_file_insert_after|prepare_file_insert_before|prepare_file_block_replace`
- `path`
- `hunk_id`、`expires_at_ms`
- `action: replace|delete|append|insert|block_replace`
- `normalized.*`（EOF 换行分析）
- `summary`（1–2 句可扫读）
- 紧随 YAML 的 ` ```diff ` unified diff（审阅用）

### 8.2 Plan（按工具/动作的关键字段）

- `prepare_file_range_edit`：
  - `range.input` / `range.resolved.start|end`
  - `lines.old|new|delta`
  - `evidence.before|range|after`
- `prepare_file_append`：
  - `file_line_count_before|after`、`appended_line_count`
  - `blankline_style.file_trailing_blank_line_count` / `content_leading_blank_line_count`
  - `evidence_preview.before_tail|append_preview|after_tail`
- `prepare_file_insert_*`：
  - `position`、`anchor`、`match`
  - `candidates_count`、`occurrence_resolved`
  - `inserted_at_line`、`inserted_line_count`、`lines.old|new|delta`
  - `blankline_style.*`、`evidence_preview.*`
- `prepare_file_block_replace`：
  - `start_anchor` / `end_anchor` / `match`
  - `include_anchors` / `require_unique` / `strict`
  - `candidates_count` / `occurrence_resolved`
  - `block_range`、`replace_slice`、`lines.old|new|delta`
  - `evidence_preview.before_preview|old_preview|new_preview|after_preview`

### 8.3 Apply（共同字段）

- `status`
- `mode: apply_file_modification`
- `path`、`hunk_id`
- `action`
- `context_match: exact|fuzz|rejected`
- `apply_evidence`（必须）
- `summary` - 紧随 YAML 的 unified diff（基于 apply 时“当前文件 + 解析到的目标位置”重算；若 `context_match=exact` 则与 plan diff 一致）

### 8.4 Apply（按动作的关键字段）

- `append`：`append_range.start|end` + tail previews
- `insert`：`position` / `anchor` / `inserted_at_line` / `inserted_line_count`
- `replace|delete`（range）：`applied_range.start|end` + `lines.*`
- `block_replace`：`block_range` / `replace_slice` / `lines.*`

### 8.5 read_file / overwrite_entire_file（结构化头部）

为提升可脚本化与回归稳定性：

- `read_file` 输出开头包含 YAML header（随后是代码块正文），其中会给出：
  - `total_lines`（用于对账护栏：空文件为 0，可直接用于 `overwrite_entire_file.known_old_total_lines`）
- `overwrite_entire_file` 的成功/失败输出均使用 YAML（便于程序化处理与重试）。

## 9. Scratch Pad 决策记录与阶段实现

Scratch Pad 是 ws_mod 的大文本编辑缓冲区，目标是减少 LLM 在多轮编辑中反复输出同一大块文本，也减少 prepare/apply 因小错反复重做的成本。它不是普通 reminder 的新用法，而是隶属于 ws_mod 的专用工具能力；底层可以复用 reminder 的可见性、持久化与生命周期提示。

### 9.1 边界

- `add_reminder` / `update_reminder` / `delete_reminder` 保持现有语义和功能，不承接 pad 创建、修改或删除。
- pad 作为 `ws_mod` 专用对象，由 `pad_*` 工具管理；普通 reminder 工具不应修改 pad。
- pad 使用智能体自主分配的 `pad_id` slug 作为稳定句柄。实现时应限制为安全、可持久化的短标识（例如 `^[A-Za-z0-9_-]+$`），避免与普通 reminder id 混淆。
- pad 本体只保存 `pad_id + content`；不保存 `source` / `target` / `role` / `updatedAt`。
- 不提供 `role`，不提供自动过期；pad 用完必须由智能体主动删除。
- 默认作用域应偏当前对话。只有当文件编辑业务明确需要同一任务内协作复用时，才考虑更宽作用域。

### 9.2 上下文投影

- pad 以扎眼的特殊提醒项形式投影到 LLM generation context 的末尾、真实用户消息之前，让智能体总能看到有哪些临时缓冲区仍未清理。
- role=user 的 pad 投影只包含 `pad_id`、行数/字节数/hash 等元信息，不投影正文，也不放 `pad_delete(...)` 这类可执行工具调用文本，避免被误判成当前立即指令。
- pad 提醒项应由专用 owner/manager 管理，并通过 metadata 阻止普通 `update_reminder` / `delete_reminder` 误改；可执行维护通道通过现有 role=assistant 的 reminder maintenance reference 暴露，错误提示也应指向对应的 `pad_*` 工具。
- pad 投影的产品目的不是长期记忆，而是当前编辑工作台与清理压力：内容应用完成或不再需要后，智能体应尽快 `pad_delete`。

### 9.3 工具形态

当前阶段先落基础编辑工具，后续再扩展搬运和落盘工具；任何阶段都不提供观察工具：

- 当前已实现：`pad_write`、`pad_load_file_range`、`pad_edit`、`pad_delete`。
- 后续目标形态：`pad_insert`、`pad_delete_range`、`pad_copy`、`pad_move`、`pad_prepare_file_range_edit`。
- 不提供：`pad_read`、`pad_preview`、`pad_locate`、`pad_diff`、`pad_stat`、`pad_list` 等会把 pad 内容或额外观察路径带回对话历史的工具。
- 文件编辑工具应能直接把 pad 当作源或目标：文件范围可装入 pad，pad 范围可作为文件 range edit 的新内容，pad 之间可复制/剪切/移动文本。
- 工具结果默认只返回操作是否成功、受影响行数/字节数/hash 与下一步提示，不回显大块正文。

### 9.4 大文本入参的现实取舍

- 不能禁止 LLM 写出大块新内容；很多业务场景需要直接生成文案、代码或配置。
- `pad_write` / `pad_edit` / `pad_insert` 接收大文本时，这些正文仍会以函数调用参数形式进入持久历史；当前没有完美办法完全消除这类一次性成本。
- 设计目标不是让大文本从不进入持久上下文，而是避免同一大文本在后续编辑、搬运、应用阶段反复进入历史。
- 因此推荐路径是：必要时一次性写入 pad，之后尽量用 pad/file/pad 之间的句柄式搬运和 range edit 完成后续操作，最后主动删除 pad。

## 10. 错误与拒绝（稳定方向）

### 10.1 prepare 阶段（常见）

- `FILE_NOT_FOUND`：文件不存在（某些工具如 append 可用 `create=true` 处理）。
- `CONTENT_REQUIRED`：正文为空但该工具需要正文（insert/append/block_replace）。
- `ANCHOR_NOT_FOUND` / `ANCHOR_AMBIGUOUS`：锚点缺失或歧义（提示指定 occurrence 或换用更精确方法）。
- `OCCURRENCE_OUT_OF_RANGE`：occurrence 超范围。

### 10.2 apply 阶段（常见）

- `HUNK_NOT_FOUND`：hunk 过期/已应用/不存在。
- `WRONG_OWNER`：hunk 非当前成员规划。

## 11. 示例（copy/paste 可用）

- 末尾追加：

```text
按以下参数调用函数工具 `prepare_file_append`：
{ "path": "notes/prompt.md", "content": "## Tools\n- Use prepare_* + apply_file_modification for incremental edits.\n" }
```

- 行号范围替换（`content` 可为空字符串表示删除）：

```text
按以下参数调用函数工具 `prepare_file_range_edit`：
{ "path": "README.md", "range": "10~12", "content": "New line 10\nNew line 11\n" }
```

- 双锚点块替换：

```text
按以下参数调用函数工具 `prepare_file_block_replace`：
{ "path": "docs/spec.md", "start_anchor": "## Start", "end_anchor": "## End", "content": "NEW BLOCK LINE 1\nNEW BLOCK LINE 2\n" }
```

```text
按以下参数调用函数工具 `apply_file_modification`：
{ "hunk_id": "<hunk_id>" }
```

## 12. 与 `.minds/` 的关系（team_mgmt 版本）

`.minds/` 属于团队配置与 rtws（运行时工作区）记忆的核心，通常应通过 `team_mgmt` toolset 的镜像工具操作（例如 `team_mgmt_prepare_file_insert_after` 等）。  
本设计文档的"prepare-first + 单 apply"心智模型保持一致，但路径与权限语义由 team_mgmt 工具包装层决定（详见 team_mgmt 文档/工具说明）。
