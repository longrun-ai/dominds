# ws_mod 工具参考

## 模板（工具）

### 阅读方式

- 工具函数定义是参数/返回的权威来源；本手册只补充使用指导。

### 单工具字段顺序

1. 用途
2. 调用签名
3. 参数（仅在需要补充用法指导时摘要说明）
4. 前置条件
5. 成功信号
6. 失败/错误
7. 可直接执行示例
8. 常见误用

## 1. 支撑工具（读/定位/审阅）

- `read_file`（函数工具）：带上限/可选行号装饰的只读查看（用于复核与定位）
- `read_symlink`（函数工具）：读取 symlink 目标且不跟随链接
- `ripgrep_*`（函数工具）：定位锚点与候选片段（`ripgrep_snippets` 通常最有用）

## 2. 原始写入工具（例外）

### 2.1 create_new_file

创建新文件，允许空内容。

- **设计定位**：解决"创建空文件/新文件"不应被迫走增量编辑；同时避免误用 `overwrite_entire_file`（它的语义是覆盖既有文件）
- **行为**：若目标已存在则拒绝（`FILE_EXISTS`/`NOT_A_FILE`）；不存在则创建父目录并写入内容
- **规范化**：若 `content` 非空且末尾缺少 `\n`，则补齐并在输出中显示 `normalized_trailing_newline_added=true`
- **输出**：成功/失败均为 YAML（便于脚本化与回归）

### 2.2 overwrite_entire_file

整文件覆盖写入（直接写盘）。

- **使用建议**：先用 `read_file` 获取 `total_lines/size_bytes` 作为 `known_old_total_lines/known_old_total_bytes` 的对账输入
- **设计定位**：用于"新内容很小（例如 <100 行）"或"明确为重置/生成物"的场景；大正文优先先进入 pad，再传 `pad_id/pad_range`
- **来源**：小正文可直接传 `content`；大正文优先传 `pad_id/pad_range`
- **护栏（强制）**：必须提供 `known_old_total_lines/known_old_total_bytes`（旧文件快照）才允许执行；若对账不匹配则拒绝覆盖
- `content_format`：可选文本提示，任意非空标签都可接受（例如 `yaml`、`toml`、`json`、`markdown`）
- **护栏（默认拒绝）**：若正文疑似 diff/patch，且未显式声明 `content_format=diff|patch`，则默认拒绝；实际编辑应使用 direct edit 工具，只有要把 patch 文本按字面量写入时才声明 diff/patch
- **限制**：不负责创建文件；创建空文件/新文件请用 `create_new_file`

### 2.3 create_symlink / rm_symlink

创建或删除 symlink 路径。

- **设计定位**：把 symlink 操作显式化，避免混入普通文件/目录编辑语义
- **行为**：`create_symlink` 会按传入值原样写入 target 字符串；相对 target 由文件系统按 link 父目录解析
- **删除**：`rm_symlink` 删除链接路径本身，不触碰目标，也可删除 broken symlink
- **输出**：成功/失败均为 YAML，包含 `mode: create_symlink` / `mode: rm_symlink`

## 3. 增量编辑（direct edit）

- `file_range_edit`：按精确行号范围直接 replace/delete/append（append 通过 `N~` 且 `N=(last_line+1)`）
- `file_append`：直接追加到 EOF，可选 `create=true|false`
- `file_insert_after` / `file_insert_before`：按锚点行直接插入；锚点多次出现必须指定 `occurrence`
- `file_block_replace`：按 start/end 锚点直接块替换（可配置 `include_anchors` / `require_unique` / `strict` / `occurrence` 等）
  - `include_anchors=true`（默认）：保留 start/end anchor 行，仅替换两者之间的内容
  - `include_anchors=false`：替换范围包含 start/end anchor 行（会删除 anchor 行并以新内容替换）
- `create_new_file` / `overwrite_entire_file` / `file_range_edit` / `file_append` / `file_insert_*` / `file_block_replace` 都支持 `content` 与 `pad_id/pad_range` 两类来源；小正文直供 `content`，大正文优先使用 pad 来源
- `pad_load_file_range({ pad_id, path })` 可省略 `range`，默认把整个文件装入 pad；指定 `range` 时只装入文件片段
- 需要审阅时对 direct 工具显式传 `preview: true, show_diff: true`；默认直接写入且不回显正文

## 4. YAML 输出契约

> 目标：低注意力可扫读；稳定字段便于工具链/回归

### 4.1 Direct 写入（共同字段）

- `status: ok|error`
- `mode: file_range_edit|file_append|file_insert_after|file_insert_before|file_block_replace`
- `path`
- `action: replace|delete|append|insert|block_replace`
- `normalized.*`（EOF 换行分析）
- `summary`（1–2 句可扫读）
- 只有 `show_diff=true` 时才追加 unified diff

### 4.2 Direct 写入（按工具/动作的关键字段）

- `file_append`：
  - `file_line_count_before|after`、`appended_line_count`
  - `blankline_style.file_trailing_blank_line_count` / `content_leading_blank_line_count`
  - `evidence_preview.before_tail|append_preview|after_tail`
- `file_insert_*`：
  - `position`、`anchor`、`match`
  - `candidates_count`、`occurrence_resolved`
  - `inserted_at_line`、`inserted_line_count`、`lines.old|new|delta`
  - `blankline_style.*`、`evidence_preview.*`
- `file_block_replace`：
  - `start_anchor` / `end_anchor` / `match`
  - `include_anchors` / `require_unique` / `strict`
  - `candidates_count` / `occurrence_resolved`
  - `block_range`、`replace_slice`、`lines.old|new|delta`
  - `evidence_preview.before_preview|old_preview|new_preview|after_preview`

### 4.5 read_file / overwrite_entire_file（结构化头部）

- `read_file` 输出开头包含 YAML header（随后是代码块正文），其中会给出：
  - `total_lines`（用于对账护栏：空文件为 0，可直接用于 `overwrite_entire_file.known_old_total_lines`）
- `overwrite_entire_file` 的成功/失败输出均使用 YAML（便于程序化处理与重试）

## 5. 与 .minds/ 的关系

`.minds/` 属于团队配置与 rtws（运行时工作区）记忆的核心，通常应通过 `team_mgmt` toolset 的镜像工具操作（例如 `team_mgmt_file_insert_after` 等）。
本工具集的 direct edit 心智模型保持一致，但路径与权限语义由 team_mgmt 工具包装层决定（详见 team_mgmt 文档/工具说明）
