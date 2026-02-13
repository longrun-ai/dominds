# control 使用场景

## 模板（场景）
### 场景格式
- 目标
- 前置条件
- 步骤
- 期望信号
- 失败分支处理
- 完成判据

## 场景 1：任务进度跟踪

### 场景描述

使用提醒跟踪当前任务进度。

### 示例

```typescript
// 添加任务提醒
add_reminder({
  content: '当前任务: 创建 i18n 手册 [进行中]',
});

// 任务完成后更新
update_reminder({
  reminder_no: 1,
  content: '已完成: 创建 i18n 手册 [完成]',
});

// 删除已完成的提醒
delete_reminder({
  reminder_no: 1,
});
```

## 场景 2：阻塞问题记录

### 场景描述

记录当前遇到的阻塞问题。

### 示例

```typescript
add_reminder({
  content: '阻塞: 等待后端 API 文档确认',
});

// 阻塞解决后
update_reminder({
  reminder_no: 1,
  content: '阻塞已解决: 后端 API 文档已确认',
});
```

## 场景 3：差遣牒进度更新

### 场景描述

更新任务进度到差遣牒。

### 示例

```typescript
change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### 已完成\n- [x] 创建 ws_mod 手册\n- [x] 创建 team_mgmt 手册\n- [x] 创建 memory 手册\n\n### 进行中\n- [ ] 创建 control 手册 [50%]\n\n### 待改进\n- [ ] 编写工具描述',
});
```

## 场景 4：差遣牒目标更新

### 场景描述

更新任务目标。

### 示例

```typescript
change_mind({
  selector: 'goals',
  content:
    '## Goals\n\n- [ ] 创建所有工具集手册\n  - [x] ws_mod\n  - [x] team_mgmt\n  - [x] memory\n  - [ ] control (进行中)\n- [ ] 编写工具描述',
});
```

## 场景 5：差遣牒约束更新

### 场景描述

更新任务约束条件。

### 示例

```typescript
change_mind({
  selector: 'constraints',
  content:
    '## Constraints\n\n- man 函数必须根据 team.yaml 动态过滤工具集\n- 运行时生效：team.yaml 配置变更后立即可见\n- 工具集名称使用下划线格式\n- 新增约束：每个工具集需要 5 个 topic × 2 个语言',
});
```

## 场景 6：读取差遣牒

### 场景描述

读取差遣牒章节内容。

### 示例

```typescript
// 读取 bearinmind/runbook
recall_taskdoc({
  category: 'bearinmind',
  selector: 'runbook',
});

// 读取 bearinmind/contracts
recall_taskdoc({
  category: 'bearinmind',
  selector: 'contracts',
});
```

## 场景 7：差遣牒维护

### 场景描述

维护差遣牒的完整性和一致性。

### 示例

```typescript
// 更新进度（保持 goals 和 progress 一致）
change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### 已完成\n- [x] 创建 ws_mod 手册 [100%]\n- [x] 创建 team_mgmt 手册 [100%]\n- [x] 创建 memory 手册 [100%]\n\n### 进行中\n- [ ] 创建 control 手册 [60%]\n\n### 下一步\n- 完成 control 手册\n- 创建 os 手册',
});
```
