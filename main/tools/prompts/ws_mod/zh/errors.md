# ws_mod 错误处理

## 模板（错误）

### 错误行动链（必填）

1. 触发条件
2. 检测信号
3. 恢复步骤
4. 成功判据
5. 升级路径（可选）

## 错误分类

| 阶段    | 错误码                    | 说明                          | 解决方案                                             |
| ------- | ------------------------- | ----------------------------- | ---------------------------------------------------- |
| prepare | `PATH_REQUIRED`           | 缺少文件路径                  | 提供非空的 rtws 内相对路径                           |
| prepare | `INVALID_ARGS`            | 工具参数非法                  | 按错误信息修正参数结构                               |
| prepare | `INVALID_PATH`            | 路径越界或不合法              | 使用 rtws 内的规范化相对路径                         |
| prepare | `INVALID_FORMAT`          | 修改格式非法                  | 使用所选 prepare 工具要求的格式                      |
| prepare | `FILE_NOT_FOUND`          | 文件不存在                    | 使用 `create=true` 参数或先创建文件                  |
| prepare | `CONTENT_REQUIRED`        | 正文为空但该工具需要正文      | 为 insert/append/block_replace 提供 `content`        |
| prepare | `INVALID_HUNK_ID`         | hunkId 非法                   | 使用非空且不含换行的 hunkId                          |
| prepare | `WRONG_MODE`              | 既有 hunkId 属于其它模式      | 换用新 hunkId，或使用同一种 prepare 模式             |
| prepare | `HUNK_ID_CONFLICT`        | hunkId 与活跃 hunk 冲突       | 换用唯一 hunkId                                      |
| prepare | `ANCHOR_NOT_FOUND`        | 锚点行未找到                  | 检查锚点文本是否正确，或使用 `ripgrep_snippets` 定位 |
| prepare | `ANCHOR_AMBIGUOUS`        | 锚点有多个匹配                | 指定 `occurrence` 参数来明确是第几个匹配             |
| prepare | `OCCURRENCE_OUT_OF_RANGE` | occurrence 超范围             | 检查 occurrence 值是否在 `1~candidates_count` 范围内 |
| apply   | `HUNK_NOT_FOUND`          | hunk 过期/已应用/不存在       | 重新执行 prepare 生成新的 hunk                       |
| apply   | `WRONG_OWNER`             | hunk 非当前成员规划           | hunk 必须由当前成员生成                              |
| apply   | `WRONG_MODE`              | hunkId 属于其它模式           | 应用匹配的 hunk 模式，或重新执行 prepare             |
| apply   | `FILE_NOT_FOUND`          | 文件在 apply 时不存在         | 检查文件是否被删除或移动                             |
| apply   | `CONTENT_CHANGED`         | 文件在 prepare 后已漂移       | 基于最新文件重新执行 prepare                         |
| apply   | `AMBIGUOUS_MATCH`         | apply 时锚点变成多处匹配      | 使用更窄锚点或明确 occurrence 后重新 prepare         |
| apply   | `APPLY_REJECTED_*`        | apply 阶段安全检查拒绝 hunk   | 按拒绝后缀重新 prepare，并增强上下文                 |
| write   | `ACCESS_DENIED`           | rtws 保留路径被硬拒绝         | 使用错误信息中列出的专用工具/路径                    |
| write   | `FILE_EXISTS`             | 文件已存在（create_new_file） | 使用其他路径或先删除现有文件                         |
| write   | `NOT_A_FILE`              | 目标路径存在但不是普通文件    | 使用其他路径或先移除该非文件条目                     |
| write   | `STATS_MISMATCH`          | 整文件覆盖快照不匹配          | 重新读取文件，用最新快照重试                         |
| write   | `SUSPICIOUS_DIFF`         | 疑似 diff/patch 正文未声明    | 声明 `content_format`，或改用 prepare/apply 工具     |
| write   | `FAILED`                  | 文件系统或运行时失败          | 查看错误正文并修复底层条件                           |

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

### 2. hunk 相关错误

**HUNK_NOT_FOUND**

- 原因 1：hunk 已过期（TTL=1h）
- 原因 2：进程已重启，内存中的 hunk 丢失
- 解决：重新执行 prepare 生成新的 hunk

**WRONG_OWNER**

- 原因：尝试 apply 其他人生成的 hunk
- 解决：只能 apply 自己生成的 hunk

**`CONTENT_CHANGED` / `AMBIGUOUS_MATCH` / `APPLY_REJECTED_*`**

- 原因：文件在 prepare 后变化，或 apply 阶段锚点检查不再只有一个安全目标
- 解决：重新读取文件，并基于当前内容、更窄锚点或明确 occurrence 重新执行 prepare

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

1. **prepare → apply 必须分两条消息**：同一条消息中并行执行可能导致 apply 时 hunk 不可见

2. **先读取再写入**：使用 `overwrite_entire_file` 前先调用 `read_file` 获取旧文件快照

3. **使用唯一锚点**：避免使用过于通用的文本作为锚点，必要时用 `occurrence` 明确

4. **及时 apply**：hunk 有 1 小时 TTL，尽量在生成后尽快 apply

5. **检查输出字段**：特别是 `normalized.*` 字段，确认写入行为符合预期
