# control 使用场景

## 模板（场景）

### 场景格式

- 目标
- 前置条件
- 步骤
- 期望信号
- 失败分支处理
- 完成判据

## 场景 1：提醒项工作集跟踪

### 场景描述

使用 reminders 承接当前对话的工作集：下一步、临时阻塞、易丢的 bridge 细节，而不是把它写成面向全队同步的 Taskdoc 公告牌。

### 示例

```typescript
// 添加一条 dialog 级工作集提醒
add_reminder({
  content: '下一步：复核 control 手册是否已经完整表达 Taskdoc progress 的公告牌语义',
});

// 只有因为这是一条职责相关提示，且在所有由你主理的后续对话里也应继续看到，
// 才把它写成 personal
add_reminder({
  content: '常用部署自检命令：pnpm -C dominds run lint:types',
  scope: 'personal',
});

// 当本地工作集细节变化后更新
update_reminder({
  reminder_id: 'abc123de',
  content: '阻塞已解除：control 手册文案已与 Taskdoc progress 语义对齐',
});

// 删除已完成的提醒
delete_reminder({
  reminder_id: 'abc123de',
});
```

### 关键点

- 本地下一步、临时阻塞、一次性 bridge 细节默认都用 `dialog`
- 只有职责相关、且在所有由你主理的后续对话里也应继续看到的提醒才用 `personal`
- 如果信息需要向全队同步当前有效状态、关键决策、下一步或仍成立阻塞，应写入 Taskdoc `progress`
- 如果内容本质上是长期知识而不是当前工作集提示，应改存到 `personal_memory`

## 场景 2：支线已完成，按 assignment 头部要求调用 replyTellask

### 场景描述

当前支线处理完毕，assignment 头部明确写着“完成任务时必须调用 `replyTellask`”。

### 示例

```typescript
replyTellask({
  replyContent: '已核对实现与约束，结论：当前方案可接受，剩余风险为测试覆盖不足。',
});
```

### 关键点

- 不要再发一条普通最终消息代替
- `replyContent` 直接放最终交付正文
- 若 assignment 头部写的是 `replyTellaskSessionless`，则同结构替换函数名

## 场景 3：当前未完成，需要回问上游

### 场景描述

当前支线仍未完成，因此需要向上游补问缺失信息。

### 示例

```typescript
tellaskBack({
  tellaskContent: '还缺少生产环境端口与部署入口信息。请补充这两项后我再继续给出最终方案。',
});

// 等上游补充后，runtime 会在当前对话里继续推进
```

### 关键点

- 未完成态用 `tellaskBack`，不要用 `replyTellask*`
- `tellaskBack` 只负责把问题问回去，不负责最终交付

## 场景 4：收到 ask-back 续诉请后，用 replyTellaskBack 收口

### 场景描述

你之前发过 `tellaskBack`，上游现在补回了所需信息，runtime 暴露了 `replyTellaskBack`。

### 示例

```typescript
replyTellaskBack({
  replyContent: '已基于你补充的生产端口与入口信息完成检查；结论：发布脚本只需补一条端口注入配置。',
});
```

### 关键点

- 看到 `replyTellaskBack` 被暴露时，说明当前语义是“回复上一条 ask-back”
- 这时不要误用 `replyTellask` / `replyTellaskSessionless`

## 场景 5：差遣牒进度更新

### 场景描述

把当前有效状态、关键决策、下一步与仍成立阻塞公告给全队，而不是写个人流水账。

### 示例

```typescript
change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### 当前有效状态\n- 已完成三类记忆载体边界收口，准备补 Taskdoc 公告牌属性\n\n### 已生效决策\n- `personal_memory` 不再作为短期杂物柜\n- `team_memory` 只承接团队长期共识与不变量\n\n### 下一步\n- 在 control / team_mgmt 手册中补强 `progress` 的公告牌语义\n\n### 仍成立阻塞\n- 无',
});
```

## 场景 6：差遣牒目标更新

### 场景描述

更新任务目标。

### 示例

```typescript
change_mind({
  selector: 'goals',
  content:
    '## Goals\n\n- [ ] 创建所有工具集手册\n  - [x] ws_mod\n  - [x] team_mgmt\n  - [x] personal_memory\n  - [ ] control (进行中)\n- [ ] 编写工具描述',
});
```

## 场景 7：差遣牒约束更新

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

## 场景 8：读取差遣牒

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

## 场景 9：差遣牒维护

### 场景描述

维护差遣牒的完整性和一致性，并确保 `progress` 始终是可供全队扫读的当前真相快照。

### 示例

```typescript
// 更新 progress（保持 goals / constraints / progress 一致）
change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### 当前有效状态\n- 边界口径已统一到手册源头与测试\n\n### 已生效决策\n- 角色级资产 / personal_memory / team_memory / Taskdoc-progress / reminders 的职责已经切开\n\n### 下一步\n- 复验 control 手册、Taskdoc 展示文案与边界测试\n\n### 仍成立阻塞\n- 无',
});
```
