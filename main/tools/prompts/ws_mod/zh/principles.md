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

## 1. 背景：为什么是 direct range edit + prepare/apply

历史上文本编辑工具存在"直接写入 vs 先 plan 再 apply"等多套心智并存，导致：

- agent 在低注意力状态下容易"误写"或难以复核（缺少 diff/evidence）
- prepare→apply 之间存在竞态：同一条消息中工具并行执行，可能出现"prepare 基于旧文件，但另一工具已写入"的时序问题
- apply 入口分裂，学习成本高、回归成本高

第一版 prepare-first + single apply 改善了审阅性，但也让确定行号范围的大文本编辑变得拖沓。因此当前统一为：

- **direct range edit**：精确行号范围用 `file_range_edit` 直接写入；默认 YAML-only/redacted，不回显正文
- **direct single-block edit**：末尾追加、锚点插入、锚点块替换分别使用 `file_append`、`file_insert_after` / `file_insert_before`、`file_block_replace` 直接写入
- **预览是显示选项**：需要审阅时显式 `preview/show_diff`；否则 direct 工具直接写入
- **移除旧工具**：`append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace` 已彻底删除（无 alias、无兼容层）

## 2. 目标与非目标

### 2.1 目标

- 把确定行号范围编辑统一为：`file_range_edit`
- 把单块追加/插入/块替换统一为 direct `file_*` 工具
- 提供可复核输出：direct 工具默认 YAML-only；显式 `preview/show_diff` 才输出 diff
- 明确并发/时序约束：同一文件写入在进程内串行化
- 给出稳定的失败模式与下一步建议（尤其是锚点歧义）

### 2.2 非目标

- 不做复杂 patch DSL（仍以 unified diff 为主）
- 不承诺"自动格式化/自动空行风格对齐"；只做可观测（style_warning）与最小必要规范化（EOF 换行）

## 3. 关键并发约束与顺序建议

### 3.1 工具并行执行

同一条消息中的多个工具调用会并行执行，互相不可见输出/写入。因此：

- 精确行号范围用 `file_range_edit`；追加/锚点插入/块替换用对应 direct `file_*` 工具
- 需要审阅时显式 `preview/show_diff`

### 3.2 写入并发安全（当前实现）

- 同一文件的多个 direct 写入会在进程内串行化
- 不同文件的写入可并行，不共享锁

> 可选字段默认可省略。  
> 若你想显式表达"未指定/使用默认"，可用以下哨兵值：
>
> - `existing_hunk_id: ""`：不覆写旧规划（生成新 hunk）
> - `occurrence: ""` 或 `0`：不指定 occurrence
> - `match: ""`：使用默认 `contains`（注意：`match` 是 match mode，不是要匹配的文本/正则）
> - `read_file({ range: "", max_lines: 0 })`：分别表示"不指定范围 / 使用默认 500 行"
> - `overwrite_entire_file({ content_format: "" })`：表示"未显式声明内容格式"（此时若正文强特征疑似 diff/patch 将默认拒绝写入）。任意非空标签（例如 `yaml`）都会被原样接受，但只有 `diff` / `patch` 具有特殊语义。
> - `ripgrep_*({ path: "", case: "", max_files: 0, max_results: 0 })`：分别表示"默认路径 '.' / 默认 smart-case / 使用默认上限"

## 5. 规范化策略

### 5.1 EOF 换行规范化（硬规则）

写入遵循"每行以 `\n` 结尾（包括最后一行）"：

- 若文件末尾无换行，写入前会补齐 `\n`（`normalized_file_eof_newline_added`）
- 若正文末尾无换行，写入前会补齐 `\n`（`normalized_content_eof_newline_added`）
- 计划输出与应用输出都会带 `normalized.*` 字段以便复核

### 5.2 空行风格（仅可观测）

对 append/insert，prepare 阶段会输出 `blankline_style` 与 `style_warning`，用于提示"可能产生双空行/粘行"等风险；当前不主动改变正文空行风格
