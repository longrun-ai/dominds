# memory 错误处理

## 模板（错误）

### 错误行动链（必填）

1. 触发条件
2. 检测信号
3. 恢复步骤
4. 成功判据
5. 升级路径（可选）

## 错误代码

### MEMORY_ALREADY_EXISTS

**描述：** 路径已存在，无法使用 `add_memory` 创建新记忆。

**原因：**

- 尝试添加的路径已经被其他记忆占用

**解决方案：**

- 使用 `replace_memory` 更新已有记忆
- 或者使用不同的路径创建新记忆

**示例：**

```
错误：
status: error
error_code: MEMORY_ALREADY_EXISTS
message: 路径 "project/todo" 已存在，请使用 replace_memory 更新
```

### MEMORY_NOT_FOUND

**描述：** 路径不存在，无法执行操作。

**原因：**

- 尝试访问的记忆路径不存在
- 路径被删除或从未创建

**解决方案：**

- 如果是更新/删除操作，先使用 `add_memory` 创建
- 检查路径是否正确

**示例：**

```
错误：
status: error
error_code: MEMORY_NOT_FOUND
message: 路径 "project/todo" 不存在，请先使用 add_memory 创建
```

### MEMORY_PATH_INVALID

**描述：** 路径格式无效。

**原因：**

- 路径包含非法字符
- 路径长度超过限制

**解决方案：**

- 确保路径只包含字母、数字、下划线、斜杠
- 路径长度不超过 255 个字符

**示例：**

```
错误：
status: error
error_code: MEMORY_PATH_INVALID
message: 路径 "project/*invalid*" 包含非法字符
```

### MEMORY_CONTENT_TOO_LARGE

**描述：** 记忆内容过大。

**原因：**

- 单条记忆内容超过 1MB 限制

**解决方案：**

- 压缩内容
- 拆分为多条记忆
- 使用外部存储（如文件）

**示例：**

```
错误：
status: error
error_code: MEMORY_CONTENT_TOO_LARGE
message: 内容大小 1.2MB 超过 1MB 限制
```

### MEMORY_STORAGE_ERROR

**描述：** 存储错误。

**原因：**

- 磁盘空间不足
- 权限问题
- 文件系统错误

**解决方案：**

- 检查磁盘空间
- 检查文件权限
- 重试操作

**示例：**

```
错误：
status: error
error_code: MEMORY_STORAGE_ERROR
message: 无法写入存储，磁盘空间不足
```

## 常见问题

### Q: 记忆会自动保存吗？

A: 是的，所有记忆操作都会立即持久化到磁盘。不需要手动保存。

### Q: 记忆有数量限制吗？

A: 没有严格的数量限制，但建议保持记忆数量在合理范围内（建议少于 100 条）。

### Q: 记忆可以被其他成员看到吗？

A: 不可以，memory 是个人记忆工具，只有当前智能体可以访问。如果需要共享给团队成员，请使用 team_memory。

### Q: clear_memory 会删除所有记忆吗？

A: 是的，`clear_memory` 会删除所有个人记忆，此操作不可恢复。请谨慎使用。

### Q: 记忆会过期吗？

A: 不会，记忆会永久保存，直到被显式删除。

### Q: 如何查看当前所有记忆？

A: 智能体在生成回复时可以访问所有个人记忆。你可以直接询问智能体当前有哪些记忆。
