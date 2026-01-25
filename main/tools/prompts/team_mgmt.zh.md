# team-mgmt：管理 `.minds/`（preview-first + single apply）

你拥有对 `.minds/**` 的读写能力，但该 toolset **只允许操作 `.minds/` 子树**（不会也不应触碰工作区其他文件）。

## 总原则

- 增量编辑（推荐）：用 `team_mgmt_preview_*` 先生成可复核的 YAML + diff + `hunk_id`，再用 `team_mgmt_apply_file_modification({ "hunk_id": "<hunk_id>" })` 显式写入。
- 并行约束：同一轮生成中的多个工具调用可能并行执行；**preview → apply 必须分两轮**。
- 例外（创建）：`team_mgmt_create_new_file` 只负责创建新文件（允许空内容），不做增量编辑、不走 preview/apply；若文件已存在会拒绝（避免误用覆盖写入语义）。
- 例外（整文件覆盖）：`team_mgmt_overwrite_entire_file` 会直接写盘（不走 preview/apply），必须提供 `known_old_total_lines/known_old_total_bytes` 作为对账护栏；建议先用 `team_mgmt_read_file` 从 YAML header 读取 `guardrail_total_lines/guardrail_total_bytes` 再填写。
- 规范化：写入遵循“每行以 `\\n` 结尾（含最后一行）”；必要时会补齐并通过输出字段呈现（例如 `normalized_trailing_newline_added` / `normalized.*`）。

## read_file 输出里的 guardrail 字段（重要）

`team_mgmt_read_file` 的 YAML header 会同时给出：

- `display_total_lines`：用于阅读稳定性（空文件显示为 1 行空行）
- `guardrail_total_lines` / `guardrail_total_bytes`：用于对账护栏（空文件为 0 行；bytes 取 stat().size），可直接填入 `team_mgmt_overwrite_entire_file.known_old_total_lines/known_old_total_bytes`

## 路径规则（重要）

- 该 toolset 会把 `path` 解析到 `.minds/` 下：例如 `team.yaml` 会被解析为 `.minds/team.yaml`。
- 任何最终解析不在 `.minds/` 内的路径都会被拒绝。

## 该用哪个工具

- 读取定位：`team_mgmt_read_file` / `team_mgmt_list_dir` / `team_mgmt_ripgrep_*`
- 创建新文件（允许空内容）：`team_mgmt_create_new_file({ path, content })`
- 小改动（行号范围）：`team_mgmt_preview_file_modification({ path, range, content, existing_hunk_id })`
- 末尾追加：`team_mgmt_preview_file_append({ path, content, create, existing_hunk_id })`
- 锚点插入：`team_mgmt_preview_insert_after|team_mgmt_preview_insert_before({ path, anchor, content, occurrence, match, existing_hunk_id })`
- 双锚点块替换：`team_mgmt_preview_block_replace({ path, start_anchor, end_anchor, content, existing_hunk_id, occurrence, include_anchors, match, require_unique, strict })`
- 应用写入：`team_mgmt_apply_file_modification({ hunk_id })`
- 修改完 `.minds/team.yaml`：务必运行 `team_mgmt_validate_team_cfg({})`，并清空 Problems 面板里的 team.yaml 错误后再继续。

> 注意：有些 provider（例如 Codex）会要求函数工具参数字段都“必填”（schema 全 required）。  
> 如果你用的是这类 provider，但语义上想表达“未指定/使用默认”，再用哨兵值；否则（大多数 provider）省略可选字段即可：
>
> - `existing_hunk_id: ""`：不覆写旧规划（生成新 hunk）。
> - `occurrence: ""` 或 `0`：不指定 occurrence。
> - `match: ""`：默认 `contains`（注意：`match` 是 match mode，不是要匹配的文本/正则）。

## apply 语义（context_match）

- `exact`：文件与 preview 时一致，或在原位匹配成功。
- `fuzz`：文件有漂移但仍能安全应用；此时输出会给出 `file_changed_since_preview` 与（planned/current）digest 便于复核。
- `rejected`：无法唯一定位/不安全，必须重新 preview。

## 两步模板（复制即用）

1. Preview：

```text
Call the function tool `team_mgmt_preview_file_modification` with:
{ "path": "team.yaml", "range": "10~12", "content": "..." }
```

2. Apply（必须单独一轮）：

```text
Call the function tool `team_mgmt_apply_file_modification` with:
{ "hunk_id": "<hunk_id>" }
```

## 创建空文件示例

```text
Call the function tool `team_mgmt_create_new_file` with:
{ "path": "team/domains/new-domain.md", "content": "" }
```
