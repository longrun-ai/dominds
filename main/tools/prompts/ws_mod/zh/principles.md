# ws_mod 核心原则

## 模板（原则）
### 设计目标
- <目标 1>
- <目标 2>
### 契约原则
- <输入/输出契约规则>
### 安全与边界
- <访问约束/护栏>
### 失败与恢复
- <调用失败时的行动>
### 术语表
- <该工具集特有术语>

## 1. 背景：为什么要 "prepare-first + 单 apply"

历史上文本编辑工具存在"直接写入 vs 先 plan 再 apply"等多套心智并存，导致：

- agent 在低注意力状态下容易"误写"或难以复核（缺少 diff/evidence）
- prepare→apply 之间存在竞态：同一条消息中工具并行执行，可能出现"prepare 基于旧文件，但另一工具已写入"的时序问题
- apply 入口分裂，学习成本高、回归成本高

因此统一为：

- **prepare-first**：所有增量编辑先规划（输出可审阅 diff + evidence + hunk_id）
- **single apply**：所有计划类编辑仅通过 `apply_file_modification({ "hunk_id": "<hunk_id>" })` 落盘
- **移除旧工具**：`append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace` 已彻底删除（无 alias、无兼容层）

## 2. 目标与非目标

### 2.1 目标

- 把增量编辑统一为：`prepare_*` → `apply_file_modification`
- 提供可复核输出：YAML summary + evidence（plan）/apply_evidence（apply） + unified diff
- 明确并发/时序约束：避免在同一条消息中把 prepare 与 apply 混在一起
- 给出稳定的失败模式与下一步建议（尤其是锚点歧义与 apply rejected）

### 2.2 非目标

- 不做复杂 patch DSL（仍以 unified diff 为主）
- 不保证跨进程/重启的 hunk 持久化（当前 hunk registry 为进程内内存 + TTL=1h）
- 不承诺"自动格式化/自动空行风格对齐"；只做可观测（style_warning）与最小必要规范化（EOF 换行）

## 3. 关键并发约束与顺序建议

### 3.1 工具并行执行

同一条消息中的多个工具调用会并行执行，互相不可见输出/写入。因此：

- **prepare → apply 必须分两条消息**（否则 apply 可能"看不到"本轮刚生成的 hunk）

### 3.2 apply 的并发安全（当前实现）

- 同一文件的多个 `apply_file_modification` 会在进程内按队列串行化（按 `createdAtMs`、再以 `hunkId` 作为 tie-breaker）
- 不同文件的 apply 可并行，不共享锁

## 4. hunk registry 与生命周期

### 4.1 生命周期与所有权

- 每个 plan hunk 带 TTL（输出 `expires_at_ms`）
- hunk 存储于进程内内存；进程重启后丢失
- `apply_file_modification` 会检查：
  - hunk 是否存在且未过期
  - hunk 是否由当前成员规划（`WRONG_OWNER` 拒绝）
  - 当前成员是否有写权限（`hasWriteAccess`）

### 4.2 "覆写同一规划"的规则（重要）

支持"带 `existing_hunk_id` 重新 plan 覆写"的工具与规则：

- `prepare_file_range_edit`：支持 `existing_hunk_id`，但该 id 必须已存在、归属当前成员、且模式匹配（不能拿别的 prepare 模式的 id 来覆写）
- `prepare_file_append` / `prepare_file_insert_after` / `prepare_file_insert_before`：同样支持 `existing_hunk_id` 覆写同模式预览
- `prepare_file_block_replace`：支持 `existing_hunk_id` 覆写同模式预览（同 owner / 同 kind；跨模式拒绝）
- 所有 plan 工具都**不允许自定义新 id**：只能通过"省略/清空 `existing_hunk_id`"来生成新规划；只有当你想覆写既有规划时才传入 `existing_hunk_id`

> 注意：有些 provider（例如 Codex）会要求函数工具的参数字段都"必填"（schema 全 required）。  
> 如果你用的是这类 provider，但语义上想表达"未指定/使用默认"，再用哨兵值表达"未指定"；否则（大多数 provider）**省略可选字段即可**：
>
> - `existing_hunk_id: ""`：不覆写旧规划（生成新 hunk）
> - `occurrence: ""` 或 `0`：不指定 occurrence
> - `match: ""`：使用默认 `contains`（注意：`match` 是 match mode，不是要匹配的文本/正则）
> - `read_file({ range: "", max_lines: 0 })`：分别表示"不指定范围 / 使用默认 500 行"
> - `overwrite_entire_file({ content_format: "" })`：表示"未显式声明内容格式"（此时若正文强特征疑似 diff/patch 将默认拒绝写入）
> - `ripgrep_*({ path: "", case: "", max_files: 0, max_results: 0 })`：分别表示"默认路径 '.' / 默认 smart-case / 使用默认上限"

## 5. 规范化策略

### 5.1 EOF 换行规范化（硬规则）

写入遵循"每行以 `\n` 结尾（包括最后一行）"：

- 若文件末尾无换行，写入前会补齐 `\n`（`normalized_file_eof_newline_added`）
- 若正文末尾无换行，写入前会补齐 `\n`（`normalized_content_eof_newline_added`）
- 计划输出与应用输出都会带 `normalized.*` 字段以便复核

### 5.2 空行风格（仅可观测）

对 append/insert，prepare 阶段会输出 `blankline_style` 与 `style_warning`，用于提示"可能产生双空行/粘行"等风险；当前不主动改变正文空行风格
