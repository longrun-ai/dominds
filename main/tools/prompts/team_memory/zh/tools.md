# team_memory 工具参考

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

### 1. add_team_memory

创建新共享记忆（路径不存在时）。

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

- 目标路径已存在：使用 `replace_team_memory` 更新

### 2. replace_team_memory

更新已有共享记忆（路径存在时）。

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

- 目标路径不存在：使用 `add_team_memory` 创建

### 3. drop_team_memory

删除指定共享记忆。

**参数：**

- `path`（必需）：要删除的记忆路径

**返回：**

```yaml
status: ok|error
path: <记忆路径>
deleted_at: <删除时间戳>
```

**错误：**

- `SHARED_MEMORY_NOT_FOUND`：路径不存在

### 4. clear_team_memory

清空所有共享记忆。

**警告：** 此操作不可恢复！会影响所有团队成员。

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

### 添加团队约定

```typescript
add_team_memory({
  path: 'team/conventions/commit-message',
  content:
    '## 提交信息规范\n\n格式: <type>(<scope>): <description>\n\n### 类型\n- feat: 新功能\n- fix: 修复\n- docs: 文档\n- style: 格式\n- refactor: 重构\n- test: 测试\n- chore: 维护\n\n### 示例\nfeat(auth): 添加登录验证\nfix(ui): 修复按钮样式',
});
```

### 更新项目状态

```typescript
replace_team_memory({
  path: 'team/project/status',
  content:
    '## 项目状态\n\n- 当前迭代: Sprint 15\n- 发布目标: 2024-02-01\n- 阻塞问题: 无\n- 待审查: 3 个 PR',
});
```

### 删除过时信息

```typescript
drop_team_memory({
  path: 'team/deprecated/api-v1',
});
```

## 输出与语言

- 输出是**纯文本**，不是结构化 JSON/YAML。
- 文本语言跟随“工作语言（work language）”。
