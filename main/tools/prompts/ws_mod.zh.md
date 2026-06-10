# ws_mod：文本编辑统一工作流（direct range edit + prepare/apply）

你拥有 rtws（运行时工作区）读写能力。精确行号范围编辑优先直接用 `file_range_edit` 一步写入；锚点、多 occurrence、候选不唯一或需要先审阅 diff 的编辑，再使用 `prepare_*` 生成 `hunk_id`，随后 `apply_file_modification` 写入。

## 总原则

- 精确行号范围：用 `file_range_edit({ path, range, content })` 或 `file_range_edit({ path, range, pad_id, pad_range })` 直接写入；默认只返回 redacted YAML，不回显正文。需要审阅时显式 `preview: true` 或 `show_diff: true`。
- 不确定目标/批量 occurrence：通过 `prepare_*` 生成可 apply 的 hunk；然后用 `apply_file_modification` 写入。
- LLM 顺序硬约束：`prepare_*` 只生成内存中的预览，不会写盘；在 `apply_file_modification` 之前再次读取文件仍只能读到旧内容。若要基于本次改动继续修改，必须先 apply 当前 hunk，再重新 read/prepare 新改动。`file_range_edit` 是直接写盘工具，不受这条 prepare 顺序约束。
- 旧工具已移除（无兼容层）：`append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace`。
- 约束：`*.tsk/` 下的路径属于封装差遣牒，文件工具不可访问。
- 并行约束：同一轮对话中的多个工具调用可能并行执行；**prepare → apply 必须分两轮**（除非未来有顺序编排器）。同一文件的写入工具会在工具侧串行化，但语义上仍应避免让多个直接编辑依赖彼此未读到的结果。
- 输出以 YAML 为主：直接 range edit 默认不回显正文；prepare/apply 输出低注意力可复核的 `summary` + `evidence`/`apply_evidence` + unified diff。pad-sourced 写入默认 redacted，避免回显大块正文。
- 规范化：所有写入遵循"每行以 `\n` 结尾（含最后一行）"；EOF 换行会被补齐并通过 `normalized.*` 字段呈现。
- 例外：`overwrite_entire_file` 是"整文件覆盖写入"的函数工具（会直接写盘，不走 prepare/apply）。它要求提供 `known_old_total_lines/known_old_total_bytes` 作为对账护栏（建议从 `read_file` 的 YAML header 读取 `total_lines/size_bytes`）；`content_format` 可填写任意非空文本标签（例如 `yaml`），但若正文疑似 diff/patch，仍只有显式声明 `content_format=diff|patch` 才会放行。仅用于"新内容很小（例如 <100 行）"或"明确为重置/生成物"的场景；大块精确范围改动优先用 pad + `file_range_edit`。
  - 复制参数建议：对账参数请直接用 `read_file` 的 `total_lines/size_bytes`。
- 例外：`create_new_file` 只负责"创建新文件"（允许空内容），不做增量编辑、不走 prepare/apply；若文件已存在会拒绝（避免误用覆盖写入语义）。
- 二进制图片工具：用 `read_picture({ path })` 把 PNG/JPEG/WebP/GIF 图片作为真实图片上下文读入；用 `write_picture({ path, data_base64, mime_type, overwrite })` 从 base64 写图片。它们是二进制图片操作，不走 prepare/apply。

## Scratch Pad（大文本临时缓冲）

Scratch Pad 是 ws_mod 专用的大文本编辑缓冲区，用来减少同一大块文本在多轮编辑中反复进入对话历史。pad 会以扎眼的特殊提醒项出现在上下文末尾，但 role=user 的投影只显示 `pad_id`、行数/字节数/hash，不显示正文，也不放可执行工具调用文本。

- 普通提醒工具语义不变：不要用 `add_reminder` / `update_reminder` / `delete_reminder` 创建、修改或删除 pad；用 `pad_*` 工具。
- 不提供读取/观察工具：没有 `pad_read`、`pad_preview`、`pad_locate`、`pad_diff`、`pad_stat`、`pad_list`。当前有哪些 pad 以提醒项为准。
- 可用基础工具：`pad_write`、`pad_load_file_range`、`pad_edit`、`pad_insert`、`pad_delete_range`、`pad_copy`、`pad_move`、`pad_prepare_file_range_edit`、`pad_delete`。
- `pad_write` / `pad_edit` 可以接收大文本；这些正文仍会作为函数调用参数进入持久历史。现实目标不是完全消除一次性成本，而是后续尽量用 pad 句柄操作，避免反复输出同一大块正文。
- 工具结果不回显 pad 正文，只返回行数、字节数、hash 和摘要；pad 之间转移大块文本优先用 `pad_copy` / `pad_move`。要把 pad 内容写入文件行范围，优先用 `file_range_edit({ path, range, pad_id, pad_range })`；只有需要先生成 hunk 预览时才用 `pad_prepare_file_range_edit`，再 `apply_file_modification`。
- pad 删除/更新通道由 role=assistant 的 reminder maintenance reference 暴露；不要从 role=user 的 pad 投影里寻找可执行删除指令。
- pad 是临时工作台，不是长期记忆；应用完成或不再需要后，尽快 `pad_delete({ pad_id })`。

## 该用哪个编辑路径

- 精确范围改动（行号范围）：`file_range_edit({ path, range, content })`
- 大块精确范围改动：先 `pad_write` 或 `pad_load_file_range` 准备 pad，再 `file_range_edit({ path, range, pad_id, pad_range })`
- 精确范围但必须先审阅 diff：`file_range_edit({ path, range, content, preview: true, show_diff: true })`
- 多 occurrence / 锚点 / 候选不唯一的编辑：使用对应 `prepare_*`，然后 `apply_file_modification`
- 末尾追加（已知 EOF 行号）：`file_range_edit({ path, range: "<last_line+1>~", content })`
- 末尾追加（需要 create 或 hunk 预览）：`prepare_file_append({ path, content, create, existing_hunk_id })`
- 锚点插入：`prepare_file_insert_after|prepare_file_insert_before({ path, anchor, content, occurrence, match, existing_hunk_id })`
- 双锚点块替换：`prepare_file_block_replace({ path, start_anchor, end_anchor, content, existing_hunk_id, occurrence, include_anchors, match, require_unique, strict })`
  - `include_anchors: true`（默认）：**保留 anchor 行**，仅替换两者之间的内容（start/end 行不被删除）。
  - `include_anchors: false`：替换范围**包含** start/end anchor 行（会删除并以新内容替换）。
- 创建新文件（允许空内容）：`create_new_file({ path, content })`

> 可选字段默认可省略。
> 若你想显式传入“未指定/默认”，支持以下哨兵值写法：
>
> - `existing_hunk_id: ""` 表示不覆写旧规划（生成新 hunk）。
> - `occurrence: ""` 或 `0` 表示不指定 occurrence（当候选不唯一时会被要求显式指定）。
> - `match: ""` 表示默认 `contains`（注意：`match` 是匹配模式，不是要匹配的文本/正则）。

## hunk id 规则（重要）

- `prepare_*` 会生成 `hunk_id`（TTL=1 小时）；apply 只能用仍然存在的 hunk。
- 过期/未使用的 hunk **不会产生任何副作用**，会在运行时自动清理；只需关注"最后一次准备的那个 `hunk_id`"。
- 部分 prepare 工具支持 `existing_hunk_id` 作为"覆写同一 prepare"的方式；**不支持自定义新 id**。
- 若只是修订同一个未落盘预览，可用同一 prepare 工具配合 `existing_hunk_id` 覆写；若想基于这次改动继续做下一笔修改，必须先 apply 当前 hunk，再重新 prepare。

## apply 语义（context_match）

- `exact`：文件内容与 prepare 时一致。
- `fuzz`：文件已被修改，但仍能安全应用；此时输出会给出 `file_changed_since_preview` 与（planned/current）digest 便于复核。
- `rejected`：无法唯一定位或不安全；必须重新 prepare。

## 直接 range edit 模板（复制即用）

```text
按以下参数调用函数工具 `file_range_edit`：
{ "path": "README.md", "range": "10~12", "content": "New line 10\\nNew line 11\\n" }
```

使用 pad 作为来源：

```text
按以下参数调用函数工具 `file_range_edit`：
{ "path": "README.md", "range": "10~12", "pad_id": "rewrite_intro", "pad_range": "~" }
```

## prepare/apply 模板（多 occurrence 或需 hunk 预览）

1. Prepare（返回 `hunk_id` + unified diff）：

```text
按以下参数调用函数工具 `prepare_file_insert_after`：
{ "path": "docs/spec.md", "anchor": "## Configuration", "content": "### Defaults\\n- provider: codex\\n" }
```

2. Apply（必须单独一轮/单独一步）：

```text
按以下参数调用函数工具 `apply_file_modification`：
{ "hunk_id": "<hunk_id>" }
```

在这一步之前，prepare 结果还没有落盘；如果此时再次 `read_file`，读到的仍是旧内容。

## 示例

- 末尾追加（需要 hunk 预览或 create）：

```text
按以下参数调用函数工具 `prepare_file_append`：
{ "path": "notes/prompt.md", "content": "## Tools\\n- Use file_range_edit for precise ranges; prepare/apply for uncertain targets.\\n" }
```

- 行号范围替换（`content` 可为空字符串表示删除）：

```text
按以下参数调用函数工具 `file_range_edit`：
{ "path": "README.md", "range": "10~12", "content": "New line 10\\nNew line 11\\n" }
```

- 双锚点块替换：

```text
按以下参数调用函数工具 `prepare_file_block_replace`：
{ "path": "docs/spec.md", "start_anchor": "## Start", "end_anchor": "## End", "content": "NEW BLOCK LINE 1\\nNEW BLOCK LINE 2\\n" }
```

## 常见失败与下一步

- `ANCHOR_AMBIGUOUS`：锚点多次出现且未指定 occurrence；请指定 occurrence 或改用行号范围（`file_range_edit`）。
- `ANCHOR_NOT_FOUND`：锚点未找到；必要时先 `read_file` 或用 `ripgrep_snippets` 定位；若能确认行号范围，改用 `file_range_edit`。
- apply `context_match: rejected`：文件已被修改导致无法唯一定位/不安全；请重新 prepare（缩小范围或增加上下文）。
- apply 失败：输出会包含失败原因与关键诊断信息；按提示重新 prepare（必要时缩小范围、增加上下文或指定 `occurrence`）。
