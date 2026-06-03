# control 错误处理

## 模板（错误）

### 错误行动链（必填）

1. 触发条件
2. 检测信号
3. 恢复步骤
4. 成功判据
5. 升级路径（可选）

## 错误代码

### REMINDER_NOT_FOUND

**描述：** 提醒 id 不存在。

**原因：**

- 尝试访问的提醒 id 不存在
- 提醒已被删除

**解决方案：**

- 使用正确的提醒 id
- 先使用 `add_reminder` 创建提醒

### TASKDOC_CATEGORY_INVALID

**描述：** 差遣牒类别无效。

**原因：**

- 类别目录不存在
- 类别名称错误

**解决方案：**

- 使用有效的类别名称
- 常用类别：goals、constraints、progress（顶层无需 category）

### TASKDOC_SELECTOR_INVALID

**描述：** 差遣牒选择器无效。

**原因：**

- 选择器不存在
- 选择器格式错误

**解决方案：**

- 使用有效的选择器名称
- 顶层章节：goals、constraints、progress
- 额外章节：查看差遣牒结构

### TASKDOC_UPDATE_FAILED

**描述：** 差遣牒更新失败。

**原因：**

- 写入权限问题
- 磁盘空间不足

**解决方案：**

- 检查磁盘空间
- 检查文件系统权限

## 常见问题

### Q: `dialog` / `task` / `agent` 提醒和 memory 有什么区别？

A: `dialog` 提醒只用于当前对话的手头工作；`task` 提醒用于同一差遣牒任务内的手头工作，也是 `add_reminder` 默认范围；`agent` 提醒会在由你主理的后续对话里继续可见，只适合紧急、短期、全局刺眼提醒。它们都不是长期知识库。`personal_memory` 用于保存持久稳定事实和可复用知识；如果信息需要向全队同步当前有效状态、关键决策、下一步或仍成立阻塞，应写入 Taskdoc `progress`，而不是提醒项。

### Q: `dialog`、`task` 和 `agent` 怎么选？

A: 默认用 `task`，让同一差遣牒任务换新对话继续时仍可见。只有真正对话局部的提醒才用 `dialog`；只有紧急、短期、全局刺眼提醒才用 `agent`。

### Q: do_mind / mind_more / change_mind / never_mind 会开启新 course 吗？

A: 不会。`do_mind` / `mind_more` / `change_mind` / `never_mind` 仅更新差遣牒内容，不开启新 course。

### Q: 差遣牒更新后立即对所有队友可见吗？

A: 是的，差遣牒更新后会立即对所有队友可见。

### Q: 可以读取其他人的差遣牒吗？

A: 可以，使用 `recall_taskdoc` 可以读取差遣牒章节内容。

### Q: 提醒有数量限制吗？

A: 没有严格限制，但建议保持提醒数量在合理范围内（建议少于 20 条）。

### Q: 如何查看当前所有提醒？

A: 智能体在生成回复时可以访问所有当前对你可见、带 `reminder_id` 的提醒。这包括当前对话提醒，以及你当前可见的 task/agent/system 提醒。
