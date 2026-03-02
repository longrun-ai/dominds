# memory 工具参考

## 模板（工具）

### 阅读方式

- "工具契约（Schema）" 为参数/返回的权威来源。

### 单工具字段顺序

1. 用途
2. 调用签名
3. 参数（参见 schema）
4. 前置条件
5. 成功信号
6. 失败/错误
7. 可直接执行示例
8. 常见误用

## 工具列表

### 1. add_memory

创建新记忆（路径不存在时）。

**参数：**

- `path`（必需）：记忆的唯一标识符
- `content`（必需）：记忆内容

**返回：**

- 成功：返回简短文本（按工作语言），例如 `已添加`。
- 失败：返回错误文本（通常以 `错误：` 开头），并包含可执行的下一步（例如提示改用 `replace_memory`）。

**错误：**

- `MEMORY_ALREADY_EXISTS`：路径已存在，使用 `replace_memory` 更新

### 2. replace_memory

更新已有记忆（路径存在时）。

**参数：**

- `path`（必需）：记忆的唯一标识符
- `content`（必需）：新的记忆内容

**返回：**

- 成功：返回简短文本（按工作语言），例如 `已更新`。
- 失败：返回错误文本（通常以 `错误：` 开头），并包含可执行的下一步（例如提示改用 `add_memory`）。

**错误：**

- `MEMORY_NOT_FOUND`：路径不存在，使用 `add_memory` 创建

### 3. drop_memory

删除指定记忆。

**参数：**

- `path`（必需）：要删除的记忆路径

**返回：**

- 成功：返回简短文本（按工作语言），例如 `已删除`。
- 失败：返回错误文本（通常以 `错误：` 开头）。

**错误：**

- `MEMORY_NOT_FOUND`：路径不存在

### 4. clear_memory

清空所有个人记忆。

**警告：** 此操作不可恢复！

**参数：** 无

**返回：**

- 成功：返回简短文本（按工作语言），例如 `已清空`；若没有可清空内容，会返回类似 `没有可清空的个人记忆。`。
- 失败：返回错误文本。

**错误：**

- 无（即使没有记忆也会返回成功）

## 使用示例

### 添加新记忆

```typescript
add_memory({
  path: 'project/todo',
  content: '- 完成 i18n 文档\n- 编写测试用例\n- 更新 README',
});
```

### 更新已有记忆

```typescript
replace_memory({
  path: 'project/todo',
  content: '- 完成 i18n 文档 [DONE]\n- 编写测试用例 [IN PROGRESS]\n- 更新 README',
});
```

### 删除记忆

```typescript
drop_memory({
  path: 'project/todo',
});
```

### 清空所有记忆

```typescript
clear_memory({});
```

## 输出与语言

- 输出是**纯文本**，不是结构化 JSON/YAML。
- 文本语言跟随“工作语言（work language）”。
