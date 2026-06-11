# ws_mod 错误处理

## 模板（错误）

### 错误行动链（必填）

1. 触发条件
2. 检测信号
3. 恢复步骤
4. 成功判据
5. 升级路径（可选）

## 错误分类

| 阶段   | 错误码                       | 说明                               | 解决方案                                             |
| ------ | ---------------------------- | ---------------------------------- | ---------------------------------------------------- |
| direct | `PATH_REQUIRED`              | 缺少文件路径                       | 提供非空的 rtws 内相对路径                           |
| direct | `INVALID_ARGS`               | 工具参数非法                       | 按错误信息修正参数结构                               |
| direct | `INVALID_PATH`               | 路径越界或不合法                   | 使用 rtws 内的规范化相对路径                         |
| direct | `INVALID_FORMAT`             | 修改格式非法                       | 使用所选工具要求的格式                               |
| direct | `FILE_NOT_FOUND`             | 文件不存在                         | append 可用 `create=true`；其它情况先创建或读取文件  |
| direct | `CONTENT_REQUIRED`           | 正文为空但该工具需要正文           | 为编辑提供 `content` 或 `pad_id/pad_range`           |
| direct | `ANCHOR_NOT_FOUND`           | 锚点行未找到                       | 检查锚点文本是否正确，或使用 `ripgrep_snippets` 定位 |
| direct | `ANCHOR_AMBIGUOUS`           | 锚点有多个匹配                     | 指定 `occurrence` 参数来明确是第几个匹配             |
| direct | `OCCURRENCE_OUT_OF_RANGE`    | occurrence 超范围                  | 检查 occurrence 值是否在 `1~candidates_count` 范围内 |
| direct | `OCCURRENCE_NOT_FOUND`       | 字面量没有匹配                     | 用 `ripgrep_fixed` 复核 `find`，或重新查看文件       |
| apply  | `FILE_CHANGED_SINCE_PREPARE` | occurrence plan 目标文件已漂移     | 重新读取并重新 `prepare_occurrence_replace`          |
| apply  | `PLAN_NOT_FOUND`             | occurrence plan 过期/已应用/不存在 | 重新 `prepare_occurrence_replace`                    |
| write  | `ACCESS_DENIED`              | rtws 保留路径被硬拒绝              | 使用错误信息中列出的专用工具/路径                    |
| write  | `FILE_EXISTS`                | 文件已存在（create_new_file）      | 使用其他路径或先删除现有文件                         |
| write  | `NOT_A_FILE`                 | 目标路径存在但不是普通文件         | 使用其他路径或先移除该非文件条目                     |
| write  | `STATS_MISMATCH`             | 整文件覆盖快照不匹配               | 重新读取文件，用最新快照重试                         |
| write  | `SUSPICIOUS_DIFF`            | 疑似 diff/patch 正文未声明         | 声明 `content_format`，或改用 direct edit 工具       |
| write  | `FAILED`                     | 文件系统或运行时失败               | 查看错误正文并修复底层条件                           |

## 常见错误场景与排查

### 1. 锚点相关错误

**ANCHOR_NOT_FOUND**

- 原因：锚点文本在文件中不存在
- 排查：使用 `ripgrep_snippets` 搜索确认锚点存在
- 注意：锚点匹配区分大小写，除非使用 `match: "contains"`（默认）

**ANCHOR_AMBIGUOUS**

- 原因：锚点在文件中出现多次
- 排查：使用 `ripgrep_snippets` 查看所有匹配位置
- 解决：添加 `occurrence` 参数（如 `occurrence: 2` 表示第二个匹配）

**OCCURRENCE_OUT_OF_RANGE**

- 原因：指定的 occurrence 大于实际匹配数
- 解决：将 occurrence 值改为有效范围内的数字

### 成功 notice

**NOT_MULTI_OCCURRENCE**

- 含义：`prepare_occurrence_replace` 只选中了单个 occurrence；工具仍会成功生成 plan
- 建议：单点编辑通常使用 `file_range_edit` 或 `file_block_replace`；多点同字面量替换使用 `prepare_occurrence_replace`

**PAD_INTENT_MISSING**

- 含义：pad 工具已经成功，但当前 pad 没有 `intent` 元信息
- 建议：用 `pad_write` / `pad_load_file_range` / `pad_copy` / `pad_move` 补充 `intent`，并尽量补充 `completion` / `source_note`，让后续模型轮次和人类 UI 都能看懂此 pad 的用途与删除条件

### 2. direct edit 漂移错误

direct edit 默认立即写入，除非显式 `preview: true`。如果 direct edit 因锚点或行号范围与意图不再匹配而失败，请重新读取当前文件，收紧范围/锚点；需要审阅时用 `preview: true, show_diff: true` 重试。

### 2.1 occurrence plan 漂移错误

**FILE_CHANGED_SINCE_PREPARE**

- 原因：目标文件在 `prepare_occurrence_replace` 后发生变化
- 解决：重新读取文件，重新 `prepare_occurrence_replace`，再应用新的 plan

**PLAN_NOT_FOUND**

- 原因：plan 已过期、已应用，或进程重启后丢失
- 解决：重新 `prepare_occurrence_replace`

### 3. 内容格式错误

**默认拒绝 diff/patch**

- 原因：使用 `overwrite_entire_file` 时，正文疑似 diff/patch 格式但未声明
- 解决：
  - 方案 1：若确实要保存 diff/patch 字面量，显式声明 `content_format: "diff"` 或 `content_format: "patch"`
  - 方案 2：若只是想审阅改动，请在 direct 工具上使用 `preview: true, show_diff: true`

**STATS_MISMATCH**

- 原因：整文件覆盖使用了过期快照
- 解决：重新读取文件，并用最新文件统计/内容重试

### 4. 权限错误

**FAILED**

- 原因：文件系统或运行时失败，包括操作系统级权限错误
- 解决：查看错误正文，修复底层条件后重试

**ACCESS_DENIED**

- 原因：目标路径触发 rtws 保留边界，例如 `.minds/**`、根 `.dialogs/**` 或 `*.tsk/`
- 解决：对 `.minds/**`，在团队配置了对应工具集时使用 `team_mgmt_*` 工具；排查对话时在嵌套 rtws 下复现，例如 `ux-rtws/.dialogs/**`；不要通过通用 ws_mod 工具编辑 `*.tsk/` 包

### 5. 路径错误

**FILE_NOT_FOUND**

- 原因：文件路径不存在
- 解决：
  - 如果是 append：使用 `create: true` 参数
  - 其他情况：先创建文件或检查路径是否正确

**NOT_A_FILE**

- 原因：目标路径存在，但指向目录、符号链接或其它非普通文件条目
- 解决：改用其它文件路径，或先移除/改名已有非文件条目后再创建文件

## 错误预防建议

1. **避免依赖型并行写入**：同一文件写入会在工具侧串行化，但同一轮的多个工具调用无法看到彼此输出；后续编辑依赖前一次结果时先重新读取

2. **先读取再写入**：使用 `overwrite_entire_file` 前先调用 `read_file` 获取旧文件快照

3. **使用唯一锚点**：避免使用过于通用的文本作为锚点，必要时用 `occurrence` 明确

4. **有意识地使用 preview**：需要审阅时才设置 `preview: true, show_diff: true`；否则 direct 工具会立即写入

5. **检查输出字段**：特别是 `normalized.*` 字段，确认写入行为符合预期
