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

```yaml
status: ok|error
path: <记忆路径>
content_size: <内容字节数>
created_at: <创建时间戳>
```

**错误：**

- `MEMORY_ALREADY_EXISTS`：路径已存在，使用 `replace_memory` 更新

### 2. replace_memory

更新已有记忆（路径存在时）。

**参数：**

- `path`（必需）：记忆的唯一标识符
- `content`（必需）：新的记忆内容

**返回：**

```yaml
status: ok|error
path: <记忆路径>
content_size: <内容字节数>
updated_at: <更新时间戳>
```

**错误：**

- `MEMORY_NOT_FOUND`：路径不存在，使用 `add_memory` 创建

### 3. drop_memory

删除指定记忆。

**参数：**

- `path`（必需）：要删除的记忆路径

**返回：**

```yaml
status: ok|error
path: <记忆路径>
deleted_at: <删除时间戳>
```

**错误：**

- `MEMORY_NOT_FOUND`：路径不存在

### 4. clear_memory

清空所有个人记忆。

**警告：** 此操作不可恢复！

**参数：** 无

**返回：**

```yaml
status: ok|error
cleared_count: <删除的记忆数量>
cleared_at: <删除时间戳>
```

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

## YAML 输出契约

所有工具的输出都使用 YAML 格式，便于程序化处理：

- `status`：操作状态，`ok` 表示成功，`error` 表示失败
- `path`：记忆路径
- 其他字段：具体操作的附加信息

错误时返回：

```yaml
status: error
error_code: <错误代码>
message: <错误消息>
```
