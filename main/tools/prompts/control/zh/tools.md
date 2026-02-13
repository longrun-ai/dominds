# control 工具参考

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

### 1. add_reminder

添加提醒。

**参数：**

- `content`（必需）：提醒内容
- `position`（可选）：插入位置（1-based，默认追加）

**返回：**

```yaml
status: ok|error
reminder_no: <提醒编号>
content: <提醒内容>
position: <插入位置>
created_at: <创建时间戳>
```

### 2. delete_reminder

删除指定提醒。

**参数：**

- `reminder_no`（必需）：提醒编号（1-based）

**返回：**

```yaml
status: ok|error
reminder_no: <提醒编号>
deleted_at: <删除时间戳>
```

**错误：**

- `REMINDER_NOT_FOUND`：提醒编号不存在

### 3. update_reminder

更新提醒内容。

**参数：**

- `reminder_no`（必需）：提醒编号（1-based）
- `content`（必需）：新的提醒内容

**返回：**

```yaml
status: ok|error
reminder_no: <提醒编号>
content: <新提醒内容>
updated_at: <更新时间戳>
```

**错误：**

- `REMINDER_NOT_FOUND`：提醒编号不存在

### 4. change_mind

更新差遣牒章节。

**参数：**

- `selector`（必需）：章节选择器（goals/constraints/progress）
- `content`（必需）：新内容（整段替换）

**返回：**

```yaml
status: ok|error
selector: <章节选择器>
updated_at: <更新时间戳>
```

**特点：**

- 每次调用替换整个章节
- 不重置对话轮次
- 变更对所有队友可见
- 约束规则：`constraints` 只写任务特有硬要求，不得重复系统提示/工具文档中的全局规则；一经发现重复，必须删除并告知用户

### 5. recall_taskdoc

读取差遣牒章节。

**参数：**

- `category`（必需）：类别目录
- `selector`（必需）：章节选择器

**返回：**

```yaml
status: ok|error
category: <类别>
selector: <选择器>
content: <章节内容>
retrieved_at: <读取时间戳>
```

## 使用示例

### 添加提醒

```typescript
add_reminder({
  content: '等待 @fullstack 确认 API 设计',
  position: 1,
});
```

### 删除提醒

```typescript
delete_reminder({
  reminder_no: 1,
});
```

### 更新提醒

```typescript
update_reminder({
  reminder_no: 1,
  content: '等待 @fullstack 确认 API 设计 [已确认]',
});
```

### 更新差遣牒进度

```typescript
change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### 已完成\n- [x] 创建 ws_mod 手册\n- [x] 创建 team_mgmt 手册\n\n### 进行中\n- [ ] 创建 memory 手册 [80%]\n\n### 待开始\n- [ ] 创建 control 手册',
});
```

### 读取差遣牒章节

```typescript
recall_taskdoc({
  category: 'bearinmind',
  selector: 'runbook',
});
```

## YAML 输出契约

所有工具的输出都使用 YAML 格式，便于程序化处理：

- `status`：操作状态，`ok` 表示成功，`error` 表示失败
- 其他字段：具体操作的附加信息

错误时返回：

```yaml
status: error
error_code: <错误代码>
message: <错误消息>
```
