# team_mgmt 核心原则

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

## 总原则

- **增量编辑（推荐）**：用 `team_mgmt_prepare_*` 先生成可复核的 YAML + diff + `hunk_id`，再用 `team_mgmt_apply_file_modification({ "hunk_id": "<hunk_id>" })` 显式写入
- **并行约束**：同一轮生成中的多个工具调用可能并行执行；**prepare → apply 必须分两轮**
- **shell 最小授权**：`os` toolset 包含 `shell_cmd` / `stop_daemon` / `get_daemon_output`；只授予少数专员成员，并在顶层 `shell_specialists` 显式列出这些成员 id
- **例外（创建）**：`team_mgmt_create_new_file` 只负责创建新文件（允许空内容），不做增量编辑、不走 prepare/apply；若文件已存在会拒绝（避免误用覆盖写入语义）
- **例外（整文件覆盖）**：`team_mgmt_overwrite_entire_file` 会直接写盘（不走 prepare/apply），必须提供 `known_old_total_lines/known_old_total_bytes` 作为对账护栏；建议先用 `team_mgmt_read_file` 从 YAML header 读取 `total_lines/size_bytes` 再填写
- **规范化**：写入遵循"每行以 `\n` 结尾（含最后一行）"；必要时会补齐并通过输出字段呈现（例如 `normalized_trailing_newline_added` / `normalized.*`）

## 路径规则（重要）

- 该 toolset 会把 `path` 解析到 `.minds/` 下：例如 `team.yaml` 会被解析为 `.minds/team.yaml`
- 任何最终解析不在 `.minds/` 内的路径都会被拒绝

## read_file 输出字段（重要）

`team_mgmt_read_file` 的 YAML header 会给出：

- `total_lines`：总行数（空文件为 0），可直接填入 `team_mgmt_overwrite_entire_file.known_old_total_lines`
- `size_bytes`：字节数（等于 stat().size），可直接填入 `team_mgmt_overwrite_entire_file.known_old_total_bytes`

## apply 语义（context_match）

- `exact`：文件与 prepare 时一致，或在原位匹配成功
- `fuzz`：文件有漂移但仍能安全应用；此时输出会给出 `file_changed_since_preview` 与（planned/current）digest 便于复核
- `rejected`：无法唯一定位/不安全，必须重新 prepare

## 哨兵值用法

> 注意：有些 provider（例如 Codex）会要求函数工具参数字段都"必填"（schema 全 required）。  
> 如果你用的是这类 provider，但语义上想表达"未指定/使用默认"，再用哨兵值；否则（大多数 provider）省略可选字段即可：

- `existing_hunk_id: ""`：不覆写旧规划（生成新 hunk）
- `occurrence: ""` 或 `0`：不指定 occurrence
- `match: ""`：默认 `contains`（注意：`match` 是 match mode，不是要匹配的文本/正则）

## 与 ws_mod 的对比

| 方面     | ws_mod         | team_mgmt               |
| -------- | -------------- | ----------------------- |
| 作用范围 | rtws 任意文件  | 仅限 `.minds/`          |
| 工具前缀 | 无             | `team_mgmt_`            |
| 路径解析 | 相对/绝对路径  | 自动加 `.minds/` 前缀   |
| 权限控制 | 依赖 rtws 权限 | 由 team_mgmt 包装层决定 |
