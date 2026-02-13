# codex_style_tools 工具参考

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

### 1. apply_patch

应用代码补丁。

**参数：**

- `patch`（必需）：补丁内容

**返回：**

```yaml
status: ok|error
path: <文件路径>
patch_applied: <是否应用成功>
applied_at: <应用时间戳>
```

**错误：**

- `PATCH_INVALID`：补丁格式无效
- `FILE_NOT_FOUND`：目标文件不存在

### 2. readonly_shell

执行只读 Shell 命令。

**参数：**

- `command`（必需）：要执行的命令

**返回：**

```yaml
status: ok|error
command: <执行的命令>
output: <命令输出>
exit_code: <退出码>
executed_at: <执行时间戳>
```

**错误：**

- `COMMAND_NOT_ALLOWED`：命令不允许执行

### 3. update_plan

更新任务计划。

**参数：**

- `plan`（必需）：计划项数组（`[{ step, status }]`）
- `explanation`（可选）：计划更新说明

**返回：**

```yaml
status: ok|error
plan: <计划内容>
updated_at: <更新时间戳>
```

## 使用示例

### 应用补丁

```typescript
apply_patch({
  patch: '--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,4 @@\n line1\n line2\n+line3\n',
});
```

### 执行只读命令

```typescript
readonly_shell({
  command: 'ls -la',
});
```

### 更新计划

```typescript
update_plan({
  explanation: '今日任务',
  plan: [
    { step: '完成代码审查', status: 'in_progress' },
    { step: '修复 bug', status: 'pending' },
    { step: '编写文档', status: 'pending' },
  ],
});
```

## YAML 输出契约

所有工具的输出都使用 YAML 格式，便于程序化处理：

- `status`：操作状态，`ok` 表示成功，`error` 表示失败
- 其他字段：具体操作的附加信息
