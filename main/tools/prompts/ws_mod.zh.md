# ws_mod：文本编辑统一工作流（preview-first + single apply）

你拥有工作区读写能力，但**所有增量文本编辑必须先 preview，再 apply**：先生成可复核的 diff/evidence + `hunk_id`，再显式确认写入。

## 总原则

- 增量编辑：通过 `preview_*` 生成可 apply 的 hunk；然后用 `apply_file_modification` 写入。
- 旧工具已移除（无兼容层）：`append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace`。
- 约束：`*.tsk/` 下的路径属于封装差遣牒，文件工具不可访问。
- 并行约束：同一轮生成中的多个工具调用可能并行执行；**preview → apply 必须分两轮**（除非未来有顺序编排器）。
- 输出以 YAML + unified diff 为主：低注意力可复核（`summary` + `evidence`/`apply_evidence`）。
- 规范化：所有写入遵循“每行以 `\n` 结尾（含最后一行）”；EOF 换行会被补齐并通过 `normalized.*` 字段呈现。
- 例外：`overwrite_entire_file` 是“整文件覆盖写入”的函数工具（会直接写盘，不走 preview/apply）。它要求提供 `known_old_total_lines/known_old_total_bytes` 作为对账护栏，并且在正文疑似 diff/patch 且未显式声明 `content_format=diff|patch` 时默认拒绝。仅用于“新内容很小（例如 <100 行）”或“明确为重置/生成物”的场景；其他情况优先 preview/apply。

## 该用哪个 `preview_*`

- 精确范围改动（行号范围）：`preview_file_modification({ path, range, content, existing_hunk_id })`
- 末尾追加：`preview_file_append({ path, content, create, existing_hunk_id })`
- 锚点插入：`preview_insert_after|preview_insert_before({ path, anchor, content, occurrence, match, existing_hunk_id })`
- 双锚点块替换：`preview_block_replace({ path, start_anchor, end_anchor, content, occurrence, include_anchors, match, require_unique, strict })`

> Codex provider 要求所有函数工具参数字段都“必填”（schema 全 required）。当你想表达“未指定/使用默认”时，用哨兵值：
>
> - `existing_hunk_id: ""` 表示不覆写旧规划（生成新 hunk）。
> - `occurrence: ""` 或 `0` 表示不指定 occurrence（当候选不唯一时会被要求显式指定）。
> - `match: ""` 表示默认 `contains`。

## hunk id 规则（重要）

- `preview_*` 会生成 `hunk_id`（TTL=1 小时）；apply 只能用仍然存在的 hunk。
- 过期/未使用的 hunk **不会产生任何副作用**，会在运行时自动清理；你只需要关注“自己最后一次想 apply 的那个 hunk_id”。
- 部分 preview 工具支持 `existing_hunk_id` 作为“覆写同一 preview”的方式；**不支持自定义新 id**。

## apply 语义（context_match）

- `exact`：文件内容与 preview 时一致或在原位匹配成功。
- `fuzz`：文件有漂移，但仍能唯一定位目标并安全应用。
- `rejected`：无法唯一定位或不安全；必须重新 preview。

## 两步模板（复制即用）

1. Preview（返回 `hunk_id` + unified diff）：

```text
Call the function tool `preview_insert_after` with:
{ "path": "docs/spec.md", "anchor": "## Configuration", "occurrence": 1, "match": "", "existing_hunk_id": "", "content": "### Defaults\\n- provider: codex\\n" }
```

2. Apply（必须单独一轮/单独一步）：

```text
Call the function tool `apply_file_modification` with:
{ "hunk_id": "<hunk_id>" }
```

## 示例

- 末尾追加：

```text
Call the function tool `preview_file_append` with:
{ "path": "notes/prompt.md", "create": true, "existing_hunk_id": "", "content": "## Tools\\n- Use preview_* + apply_file_modification for incremental edits.\\n" }
```

- 行号范围替换（`content` 可为空字符串表示删除）：

```text
Call the function tool `preview_file_modification` with:
{ "path": "README.md", "range": "10~12", "existing_hunk_id": "", "content": "New line 10\\nNew line 11\\n" }
```

- 双锚点块替换：

```text
Call the function tool `preview_block_replace` with:
{ "path": "docs/spec.md", "start_anchor": "## Start", "end_anchor": "## End", "occurrence": "", "include_anchors": true, "match": "", "require_unique": true, "strict": true, "content": "NEW BLOCK LINE 1\\nNEW BLOCK LINE 2\\n" }
```

## 常见失败与下一步

- `ANCHOR_AMBIGUOUS`：锚点多次出现且未指定 occurrence；请指定 occurrence 或改用行号范围（`preview_file_modification`）。
- `ANCHOR_NOT_FOUND`：锚点未找到；必要时先 `read_file` 或用 `ripgrep_snippets` 定位。
- apply `context_match: rejected`：文件变化导致无法唯一定位；请重新 preview（缩小范围或增加上下文）。
