# control 工具参考

## 模板（工具）

### 阅读方式

- 工具函数定义是参数/返回的权威来源；本手册只补充使用指导。

### 单工具字段顺序

1. 用途
2. 调用签名
3. 参数（仅在需要补充用法指导时摘要说明）
4. 前置条件
5. 成功信号
6. 失败/错误
7. 可直接执行示例
8. 常见误用

## 工具列表

## 跨对话 reply 速查

这些函数的**工具自身说明**刻意保持最小规格风格；这里负责补充“何时会出现、出现后怎么选”的最小速查。

| 函数                      | 最小参数契约                 | runtime 何时暴露                                                     | 调用后语义                          |
| ------------------------- | ---------------------------- | -------------------------------------------------------------------- | ----------------------------------- |
| `replyTellask`            | `{ replyContent: string }`   | 当前支线承接的是 sessioned `tellask`，且已进入可交付完成态           | 把最终结果回复给当前 `tellask` 会话 |
| `replyTellaskSessionless` | `{ replyContent: string }`   | 当前支线承接的是 one-shot `tellaskSessionless`，且已进入可交付完成态 | 把最终结果回复给当前一次性诉请      |
| `replyTellaskBack`        | `{ replyContent: string }`   | 当前对话持有一条未完成的 `tellaskBack` 回复指令                      | 把对上一条回问的最终答复送回诉请者  |
| `tellaskBack`             | `{ tellaskContent: string }` | 当前支线必须回问诉请者，且现有团队规程无法直接判责到其他负责人       | 向诉请者发起续诉请，不算最终交付    |

### 最小使用规则

- 先专注把当前任务做对；只有真到最终对诉请者交付时，才进入 `reply*` 收口
- 看见哪一个 `reply*` 被 runtime 暴露，就调用哪一个；不要自行改选别的 reply 变体
- assignment 头部若已点名 reply 函数名，以那个名字为准
- `replyContent` 只放最终交付正文，不要再包一层“我现在调用了 replyXXX”
- 如果你直接输出普通文本而没调 reply 工具，runtime 可能插入一条 `role=user` 的 runtime reminder 纠正你

### 1. add_reminder

添加提醒。

**适用：**

- 添加新的临时工作集条目
- 若准备 `clear_mind`，主线对话先把应由下一程知会的未落文档讨论细节补进差遣牒，再新建接续包提醒项；支线对话直接维护足够详尽的接续包提醒项。若当前程已被系统置于吃紧/告急处置态，支线提醒项长度没有技术限制，先记粗略过桥信息也可以

**参数：**

- `content`（必需）：提醒内容
- `position`（可选）：插入位置（1-based，默认追加；仅 `dialog` 范围支持）
- `scope`（可选）：`dialog` 或 `personal`；默认 `dialog`。只有在所有由你主理的后续对话里也应该继续看到这条提醒时才用 `personal`；否则保持 `dialog`。

**返回：**

```yaml
status: ok|error
reminder_id: <提醒 id>
content: <提醒内容>
position: <插入位置>
created_at: <创建时间戳>
```

### 2. delete_reminder

删除指定提醒。

**参数：**

- `reminder_id`（必需）：提醒 id

**返回：**

```yaml
status: ok|error
reminder_id: <提醒 id>
deleted_at: <删除时间戳>
```

**错误：**

- `REMINDER_NOT_FOUND`：提醒 id 不存在

### 3. update_reminder

更新提醒内容。

**适用：**

- 压缩/合并现有提醒项
- 把换程前需要保留的信息整理成接续包；若当前程已被系统置于吃紧/告急处置态，也可先保留多条粗略提醒项
- 删除已写入差遣牒、无需在提醒项重复保留的内容

**参数：**

- `reminder_id`（必需）：提醒 id
- `content`（必需）：新的提醒内容

**返回：**

```yaml
status: ok|error
reminder_id: <提醒 id>
content: <新提醒内容>
updated_at: <更新时间戳>
```

**错误：**

- `REMINDER_NOT_FOUND`：提醒 id 不存在

### 4. clear_mind

开启新一程对话。

**适用：**

- 当前程上下文噪音太大，需要换程继续
- 已经把接续信息放进现有 reminder，此时直接 `clear_mind({})` 即可
- 还差一条额外接续信息没写进 reminder，可用 `reminder_content` 一并带过去

**参数：**

- `reminder_content`（可选）：额外接续信息；只在该信息尚未写入现有 reminder 时再传

**返回：**

```yaml
status: ok|error
```

**最小规则：**

- 若你刚刚已经 `add_reminder` / `update_reminder` 完同一份接续信息，优先直接 `clear_mind({})`
- 若不确定是否重复，少量重复可以接受；不要为了“绝不重复”而冒信息丢失风险

### 5. do_mind

创建新的差遣牒章节。若目标章节已存在，会失败。

**参数：**

- `selector`（必需）：章节选择器（goals/constraints/progress）
- `category`（可选）：额外章节目录；与 `selector` 组合定位 `<category>/<selector>.md`
- `content`（必需）：新章节内容

**特点：**

- 只创建，不覆盖已有内容
- 适合创建缺失的常驻章节，或新增额外章节来保留细节，同时不触碰已有差遣牒正文
- 若目标已存在且只需少量补充，用 `mind_more`；若需要整章改写/合并，用 `change_mind`
- 不开启新 course
- 变更对所有队友可见

### 6. change_mind

更新差遣牒章节。

**参数：**

- `selector`（必需）：章节选择器（goals/constraints/progress）
- `category`（可选）：额外章节目录；与 `selector` 组合定位 `<category>/<selector>.md`
- `content`（必需）：新内容（整段替换）

**返回：**

```yaml
status: ok|error
selector: <章节选择器>
updated_at: <更新时间戳>
```

**特点：**

- 每次调用替换已有的整个章节；不会创建缺失章节
- 不开启新 course
- 变更对所有队友可见
- 约束规则：`constraints` 只写任务特有硬要求，不得重复系统提示/工具文档中的全局规则；一经发现重复，必须删除并告知用户

### 7. mind_more

向差遣牒章节追加条目；默认追加到 `progress`，用于降低整章替换压力。

**参数：**

- `items`（必需）：要追加的条目数组，每项必须是非空字符串
- `sep`（可选）：条目之间以及原内容与新增内容之间的分隔符，默认 `\n`
- `selector`（可选）：章节选择器，默认 `progress`；可用 `goals` / `constraints` / `progress`
- `category`（可选）：额外章节目录；与 `selector` 组合定位 `<category>/<selector>.md`

**示例：**

```typescript
mind_more({
  items: ['- 下一步：复核验证结果（详见 <文档路径>#<章节>）', '- 阻塞：等待 API 验收口径确认'],
});
```

**特点：**

- 只追加，不会自动去重、改写或压缩旧内容
- 适合给 `progress` 补一两条当前仍有效的状态、决策、下一步或阻塞
- 不适合把每一步调查过程、长日志、完整方案或验收记录当流水账追加进去；这些细节应写入 rtws 正式文档，差遣牒只写摘要和文档定位 pointer
- 若需要删除陈旧项、重排结构或压缩公告牌，仍使用 `change_mind` 做整章替换；若要删除整个章节文件，使用 `never_mind`
- 当同一主题已经有多条阶段记录时，优先 `change_mind` 合并成当前仍有效的简明公告，而不是继续 `mind_more`

### 8. never_mind

删除差遣牒章节文件。

**参数：**

- `selector`（必需）：章节选择器；顶层章节可用 `goals` / `constraints` / `progress`
- `category`（可选）：额外章节目录；与 `selector` 组合定位 `<category>/<selector>.md`

**特点：**

- 只删除整章文件，不做内容编辑
- 仅用于章节整体不再成立；如果只是删除几条陈旧项或压缩结构，优先用 `change_mind` 写回整理后的全文
- 不开启新 course

### 9. recall_taskdoc

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

### 换程但复用现有 reminder

```typescript
update_reminder({
  reminder_id: 'abc123de',
  content: '下一程先跑 smoke，再对照端口注入配置复核发布脚本。',
});

clear_mind({});
```

### 换程时补一条额外接续信息

```typescript
clear_mind({
  reminder_content: '下一程先跑 smoke，再对照端口注入配置复核发布脚本。',
});
```

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
  reminder_id: 'abc123de',
});
```

### 更新提醒

```typescript
update_reminder({
  reminder_id: 'abc123de',
  content: '等待 @fullstack 确认 API 设计 [已确认]',
});
```

### 更新差遣牒进度

```typescript
mind_more({
  items: ['- 下一步：补齐 Taskdoc `progress` 的公告牌属性说明（详见 <文档路径>#<章节>）'],
});
```

### 整章替换差遣牒进度

```typescript
change_mind({
  selector: 'progress',
  content:
    '## Progress\n\n### 当前有效状态\n- 手册边界方案已确定：角色级资产 / 个人长期经验 / Taskdoc-progress / reminders 分流；细节见 <文档路径>#<章节>\n\n### 已生效决策\n- `persona / knowhow / pitfalls` 不承接成员日常经验\n- `personal_memory` 只承接成员自己的长期可复用经验\n\n### 下一步\n- 补齐 Taskdoc `progress` 的公告牌属性说明\n\n### 仍成立阻塞\n- 无',
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

## 说明分层

- 工具 description：只保留最小规格
- 本章：提供最小速查和输入输出骨架
- `principles`：讲边界与决策规则
- `scenarios`：给复制即用的情景示例
- `clear_mind` 的设计目标是“优先保全接续信息”；正确引导优先于程序化去重

## 提醒项内容建议

- 默认提醒项应保持短、新、能直接指导下一步，常见 1–3 条
- 若用于接续包，默认优先结构化内容：下一步行动、关键定位、运行/验证、容易丢的临时细节
- 若已吃紧/告急：主线对话先把尚未落实到文档、且下一程需要知会的讨论细节写入差遣牒合适章节，再保留必要的接续包提醒项；支线对话不要维护差遣牒，也不要整理差遣牒更新提案，直接维护足够详尽的接续包提醒项，长度没有技术限制；多条粗略提醒项也可以，系统真正开启新一程后第一步再收敛整理
- 接续包只保留差遣牒仍未覆盖的细节；不要重复团队共享状态。要向全队同步“现在到哪了 / 哪些决策已生效 / 下一步是什么 / 哪些阻塞仍成立”，请写回 Taskdoc `progress`
- 不要把长日志、大段 tool output、原始材料直接塞进提醒项
