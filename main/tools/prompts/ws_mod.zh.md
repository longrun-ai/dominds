# ws_mod：文本编辑统一工作流（prepare-first + single apply）

你拥有工作区读写能力，但**所有增量文本编辑必须先 prepare，再 apply**：先生成可复核的 diff/evidence + `hunk_id`，再显式确认写入。

## 总原则

- 增量编辑：通过 `prepare_*` 生成可 apply 的 hunk；然后用 `apply_file_modification` 写入。
- 旧工具已移除（无兼容层）：`append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace`。
- 约束：`*.tsk/` 下的路径属于封装差遣牒，文件工具不可访问。
- 并行约束：同一轮对话中的多个工具调用可能并行执行；**prepare → apply 必须分两轮**（除非未来有顺序编排器）。
- 输出以 YAML + unified diff 为主：低注意力可复核（`summary` + `evidence`/`apply_evidence`）。
- 规范化：所有写入遵循"每行以 `\n` 结尾（含最后一行）"；EOF 换行会被补齐并通过 `normalized.*` 字段呈现。
- 例外：`overwrite_entire_file` 是"整文件覆盖写入"的函数工具（会直接写盘，不走 prepare/apply）。它要求提供 `known_old_total_lines/known_old_total_bytes` 作为对账护栏（建议从 `read_file` 的 YAML header 读取 `total_lines/size_bytes`），并且在正文疑似 diff/patch 且未显式声明 `content_format=diff|patch` 时默认拒绝。仅用于"新内容很小（例如 <100 行）"或"明确为重置/生成物"的场景；其他情况优先 prepare/apply。
  - 复制参数建议：对账参数请直接用 `read_file` 的 `total_lines/size_bytes`。
- 例外：`create_new_file` 只负责"创建新文件"（允许空内容），不做增量编辑、不走 prepare/apply；若文件已存在会拒绝（避免误用覆盖写入语义）。

## 该用哪个 `prepare_*`

- 精确范围改动（行号范围）：`prepare_file_range_edit({ path, range, content, existing_hunk_id })`
- 末尾追加：`prepare_file_append({ path, content, create, existing_hunk_id })`
- 锚点插入：`prepare_file_insert_after|prepare_file_insert_before({ path, anchor, content, occurrence, match, existing_hunk_id })`
- 双锚点块替换：`prepare_file_block_replace({ path, start_anchor, end_anchor, content, existing_hunk_id, occurrence, include_anchors, match, require_unique, strict })`
- 创建新文件（允许空内容）：`create_new_file({ path, content })`

> 注意：有些 provider（例如 Codex）会要求所有函数工具参数字段都"必填"（schema 全 required）。
> 如果你用的是这类 provider，但语义上想表达"未指定/使用默认"，需用特定值表达"未指定"；否则（大多数 provider）省略可选字段即可：
>
> - `existing_hunk_id: ""` 表示不覆写旧规划（生成新 hunk）。
> - `occurrence: ""` 或 `0` 表示不指定 occurrence（当候选不唯一时会被要求显式指定）。
> - `match: ""` 表示默认 `contains`（注意：`match` 是匹配模式，不是要匹配的文本/正则）。

## hunk id 规则（重要）

- `prepare_*` 会生成 `hunk_id`（TTL=1 小时）；apply 只能用仍然存在的 hunk。
- 过期/未使用的 hunk **不会产生任何副作用**，会在运行时自动清理；只需关注"最后一次准备的那个 `hunk_id`"。
- 部分 prepare 工具支持 `existing_hunk_id` 作为"覆写同一 prepare"的方式；**不支持自定义新 id**。

## apply 语义（context_match）

- `exact`：文件内容与 prepare 时一致。
- `fuzz`：文件已被修改，但仍能安全应用；此时输出会给出 `file_changed_since_preview` 与（planned/current）digest 便于复核。
- `rejected`：无法唯一定位或不安全；必须重新 prepare。

## 两步模板（复制即用）

1. Prepare（返回 `hunk_id` + unified diff）：

```text
Call the function tool `prepare_file_insert_after` with:
{ "path": "docs/spec.md", "anchor": "## Configuration", "content": "### Defaults\\n- provider: codex\\n" }
```

2. Apply（必须单独一轮/单独一步）：

```text
Call the function tool `apply_file_modification` with:
{ "hunk_id": "<hunk_id>" }
```

## 示例

- 末尾追加：

```text
Call the function tool `prepare_file_append` with:
{ "path": "notes/prompt.md", "content": "## Tools\\n- Use prepare_* + apply_file_modification for incremental edits.\\n" }
```

- 行号范围替换（`content` 可为空字符串表示删除）：

```text
Call the function tool `prepare_file_range_edit` with:
{ "path": "README.md", "range": "10~12", "content": "New line 10\\nNew line 11\\n" }
```

- 双锚点块替换：

```text
Call the function tool `prepare_file_block_replace` with:
{ "path": "docs/spec.md", "start_anchor": "## Start", "end_anchor": "## End", "content": "NEW BLOCK LINE 1\\nNEW BLOCK LINE 2\\n" }
```

## 常见失败与下一步

- `ANCHOR_AMBIGUOUS`：锚点多次出现且未指定 occurrence；请指定 occurrence 或改用行号范围（`prepare_file_range_edit`）。
- `ANCHOR_NOT_FOUND`：锚点未找到；必要时先 `read_file` 或用 `ripgrep_snippets` 定位。
- apply `context_match: rejected`：文件已被修改导致无法唯一定位；请重新 prepare（缩小范围或增加上下文）。
