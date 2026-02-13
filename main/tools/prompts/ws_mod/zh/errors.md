# ws_mod 错误处理

## 模板（错误）
### 错误行动链（必填）
1) 触发条件
2) 检测信号
3) 恢复步骤
4) 成功判据
5) 升级路径（可选）

## 错误分类

| 阶段    | 错误码                    | 说明                          | 解决方案                                             |
| ------- | ------------------------- | ----------------------------- | ---------------------------------------------------- |
| prepare | `FILE_NOT_FOUND`          | 文件不存在                    | 使用 `create=true` 参数或先创建文件                  |
| prepare | `CONTENT_REQUIRED`        | 正文为空但该工具需要正文      | 为 insert/append/block_replace 提供 `content`        |
| prepare | `ANCHOR_NOT_FOUND`        | 锚点行未找到                  | 检查锚点文本是否正确，或使用 `ripgrep_snippets` 定位 |
| prepare | `ANCHOR_AMBIGUOUS`        | 锚点有多个匹配                | 指定 `occurrence` 参数来明确是第几个匹配             |
| prepare | `OCCURRENCE_OUT_OF_RANGE` | occurrence 超范围             | 检查 occurrence 值是否在 `1~candidates_count` 范围内 |
| apply   | `HUNK_NOT_FOUND`          | hunk 过期/已应用/不存在       | 重新执行 prepare 生成新的 hunk                       |
| apply   | `WRONG_OWNER`             | hunk 非当前成员规划           | hunk 必须由当前成员生成                              |
| apply   | `FILE_NOT_FOUND`          | 文件在 apply 时不存在         | 检查文件是否被删除或移动                             |
| apply   | `CONTEXT_REJECTED`        | 文件内容已漂移，无法安全应用  | 重新执行 prepare                                     |
| write   | `PERMISSION_DENIED`       | 无写权限                      | 检查路径权限                                         |
| write   | `FILE_EXISTS`             | 文件已存在（create_new_file） | 使用其他路径或先删除现有文件                         |

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

**CONTEXT_REJECTED**

- 原因：文件在 prepare 后被修改，锚点位置已变化
- 解决：重新执行 prepare

### 3. 内容格式错误

**默认拒绝 diff/patch**

- 原因：使用 `overwrite_entire_file` 时，正文疑似 diff/patch 格式但未声明
- 解决：
  - 方案 1：改用 `prepare_*` + `apply_file_modification`
  - 方案 2：显式声明 `content_format: "diff"` 或 `content_format: "patch"`

### 4. 权限错误

**PERMISSION_DENIED**

- 原因：对目标路径没有写权限
- 解决：检查文件/目录权限设置

### 5. 路径错误

**FILE_NOT_FOUND**

- 原因：文件路径不存在
- 解决：
  - 如果是 append：使用 `create: true` 参数
  - 其他情况：先创建文件或检查路径是否正确

## 错误预防建议

1. **prepare → apply 必须分两条消息**：同一条消息中并行执行可能导致 apply 时 hunk 不可见

2. **先读取再写入**：使用 `overwrite_entire_file` 前先调用 `read_file` 获取旧文件快照

3. **使用唯一锚点**：避免使用过于通用的文本作为锚点，必要时用 `occurrence` 明确

4. **及时 apply**：hunk 有 1 小时 TTL，尽量在生成后尽快 apply

5. **检查输出字段**：特别是 `normalized.*` 字段，确认写入行为符合预期
