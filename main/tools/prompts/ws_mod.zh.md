# ws_mod：文本编辑统一工作流（preview-first + single apply）

你拥有工作区读写能力，但**所有增量文本编辑必须先 preview，再 apply**：先生成可复核的 diff/evidence + `hunk_id`，再显式确认写入。

## 总原则

- 增量编辑：通过 `preview_*` 生成可 apply 的 hunk；然后用 `apply_file_modification` 写入。
- 旧工具已移除（无兼容层）：`append_file` / `insert_after` / `insert_before` / `replace_block` / `apply_block_replace`。
- 约束：`*.tsk/` 下的路径属于封装差遣牒，文件工具不可访问。
- 并行约束：同一条消息中的多个工具调用会并行执行；**preview → apply 必须分两条消息**（除非未来有顺序编排器）。
- 输出以 YAML + unified diff 为主：低注意力可复核（`summary` + `evidence`/`apply_evidence`）。
- 规范化：所有写入遵循“每行以 `\n` 结尾（含最后一行）”；EOF 换行会被补齐并通过 `normalized.*` 字段呈现。
- 例外：`replace_file_contents` 是“整文件覆盖写入”的原始工具（会直接写盘，不走 preview/apply）。仅用于明确需要整文件覆盖的场景（例如初始化/重置 scratch 文件）。

## 该用哪个 `preview_*`

- 精确范围改动（行号范围）：`preview_file_modification <path> <range> [!hunk]`
- 末尾追加：`preview_file_append <path> [create=true|false] [!hunk]`
- 锚点插入：`preview_insert_after|preview_insert_before <path> <anchor> [options] [!hunk]`
- 双锚点块替换：`preview_block_replace <path> <start_anchor> <end_anchor> [options]`

## hunk id 规则（重要）

- `preview_*` 会生成 `hunk_id`（有 TTL）；apply 只能用仍然存在的 hunk。
- 部分 preview 工具支持 `[!existing-hunk-id]` 作为“覆写同一 preview”的方式；**不支持自定义新 id**。

## apply 语义（context_match）

- `exact`：文件内容与 preview 时一致或在原位匹配成功。
- `fuzz`：文件有漂移，但仍能唯一定位目标并安全应用。
- `rejected`：无法唯一定位或不安全；必须重新 preview。

## 两步模板（复制即用）

1. Preview（返回 `hunk_id` + unified diff）：

```plain-text
!?@preview_insert_after docs/spec.md "## Configuration" occurrence=1
!?### Defaults
!?- provider: codex
```

2. Apply（必须单独一条消息）：

```plain-text
!?@apply_file_modification !<hunk_id>
```

## 示例

- 末尾追加：

```plain-text
!?@preview_file_append notes/prompt.md
!?## Tools
!?- Use preview_* + apply_file_modification for incremental edits.
```

- 行号范围替换（正文可为空表示删除）：

```plain-text
!?@preview_file_modification README.md 10~12
!?New line 10
!?New line 11
```

- 双锚点块替换：

```plain-text
!?@preview_block_replace docs/spec.md "## Start" "## End" include_anchors=true
!?NEW BLOCK LINE 1
!?NEW BLOCK LINE 2
```

## 常见失败与下一步

- `ANCHOR_AMBIGUOUS`：锚点多次出现且未指定 occurrence；请指定 occurrence 或改用行号范围（`preview_file_modification`）。
- `ANCHOR_NOT_FOUND`：锚点未找到；必要时先 `read_file` 或用 `ripgrep_snippets` 定位。
- apply `context_match: rejected`：文件变化导致无法唯一定位；请重新 preview（缩小范围或增加上下文）。
