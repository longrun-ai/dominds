# codex_style_tools 使用场景

## 模板（场景）

### 场景格式

- 目标
- 前置条件
- 步骤
- 期望信号
- 失败分支处理
- 完成判据

## 场景 1：应用代码补丁

### 场景描述

应用代码补丁来修复问题。

### 示例

```typescript
apply_patch({
  patch:
    "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,3 +1,4 @@\n console.log('hello');\n+console.log('world');\n",
});
```

## 场景 2：只读命令执行

### 场景描述

执行只读命令查看系统状态。

### 示例

```typescript
readonly_shell({
  command: 'git status',
});
```

## 场景 3：任务计划管理

### 场景描述

使用 update_plan 管理任务计划。

### 示例

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

## 场景 4：文件状态检查

### 场景描述

检查文件状态。

### 示例

```typescript
readonly_shell({
  command: 'ls -la',
});
```

## 场景 5：Git 操作

### 场景描述

使用只读 Git 命令。

### 示例

```typescript
readonly_shell({
  command: 'git log --oneline -5',
});
```
