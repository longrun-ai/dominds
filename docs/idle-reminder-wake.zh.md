# Idle reminder wake 设计

英文版：[English](./idle-reminder-wake.md)

本文定义一种 driver 级后台协程机制：当对话进入 `idle_waiting_user` 后，runtime 可以等待 reminder owner 产生的可唤醒事件；若事件到达时对话仍处于 idle，则把事件打包成一条 `role=user` 的系统提示消息，并继续驱动对话。

本文是设计文档。它描述业务语义、owner 接口、取消模型与当前落地场景，不规定最终代码拆分。

---

## 背景

现有 reminder owner 已负责维护提醒项的真实语义，例如 `shell_cmd` daemon reminder 能在下一次 reminder 更新时发现 daemon 已退出，并把提醒项更新为终态。

但这条链路有一个缺口：如果 daemon 在对话 idle 期间退出，系统只会在下一次打开对话、显示 reminders 或新一轮 drive 时发现。对用户而言，长期运行的 shell 命令已经完成，但对话没有被自动唤醒，也不会主动说明进程已退出。

这个问题不应由 `shell_cmd` 工具直接驱动对话解决。driver 是唯一应决定对话是否继续运行的组件；reminder owner 只负责解释自己拥有的 reminder 何时产生了值得唤醒模型的环境事件。

---

## 目标

- 在对话真正进入 `idle_waiting_user` 后，启动一个可取消的后台 await 协程。
- 允许 reminder owner 暴露“可唤醒事件”，例如 daemon exited。
- 事件到达时先短暂聚合，再形成一条 runtime `role=user` 系统提示消息。
- 若聚合完成后对话仍是 idle，使用普通 driver 路径继续驱动。
- 任意新的继续驱动动作都取消已有 idle await 协程。
- 保持 owner metadata 语义封装：framework 只按 owner 路由，不偷看 owner meta。
- 保证幂等：同一个环境事件不能重复插入系统提示。

## 非目标

- 不把普通 reminder 内容变更都视为唤醒信号。
- 不让 reminder owner 直接调用 `driveDialogStream`。
- 不把 idle await 协程纳入 `activeRun`，以免 UI 把等待环境事件误判为 proceeding。
- 不在对话 blocked、stopped、dead 或 completed/archived 时自动唤醒。
- 不把 daemon stdout/stderr 的每次增长都作为唤醒事件；当前场景只处理 daemon lifecycle exit。

---

## 核心结论

### 1. Driver 拥有 idle wake 生命周期

当 `driveDialogStreamCore` 最终把 display state 设置为 `idle_waiting_user` 后，driver 外层启动一个 dialog-scoped idle wake task。

该 task：

- 不持有 dialog mutex
- 不创建 active run
- 不改变 display state
- 只等待 owner 提供的 wake event
- 在新一轮 drive 开始前被取消

这样可以保证“等待环境事件”不是“正在工作”，也不会抢占用户可见的运行控制语义。

### 2. Reminder owner 只报告 wake event

`ReminderOwner` 增加可选接口：

```ts
export type ReminderWakeEvent = Readonly<{
  eventId: string;
  reminderId: string;
  content: string;
  updatedContent?: string;
  updatedMeta?: JsonValue;
}>;

export interface ReminderOwner {
  readonly name: string;
  updateReminder(dlg: Dialog, reminder: Reminder): Promise<ReminderUpdateResult>;
  renderReminder(dlg: Dialog, reminder: Reminder): Promise<ChatMessage>;

  waitForReminderWakeEvent?(
    dlg: Dialog,
    reminders: readonly Reminder[],
    signal: AbortSignal,
  ): Promise<ReminderWakeEvent | readonly ReminderWakeEvent[] | null>;
}
```

`content` 是 owner 已经格式化好的系统提示正文，必须以 `【系统提示】` / `[System notice]` 开头。它不是用户真实输入，但当前 provider role 限制下会经 runtime prompt 路径持久化为 `role=user` 消息。

`eventId` 是 owner 范围内稳定幂等键。owner 必须能在 reminder meta 或 owner 自己的状态中记录该事件已经投递，防止重复 wake。

### 3. 首个事件到达后进入短聚合窗口

driver 不应在第一个 wake event 到达后立刻 drive。它应：

1. await 到第一个 wake event
2. 打开一个约 500ms 的聚合窗口
3. 收集同一 dialog 当前 idle wake task 下其它 owner/reminder 已经到达的 wake event
4. 对收集到的事件做稳定排序与去重
5. 打包形成一条 runtime prompt

这样可以避免多个 daemon 在相近时间退出时连续触发多轮 drive。用户和模型看到的是一条合并的环境状态消息，而不是多条碎片化系统提示。

### 4. Wake 后必须重新检查真实状态

聚合窗口结束后，driver 必须重新从 persistence 检查：

- dialog 仍存在且 status 为 running
- display state 仍是 `idle_waiting_user`
- execution marker 不是 dead，也不是需要人工 resume 的 interrupted
- 没有 pending Q4H
- 没有 blocking pending sideDialog
- 当前没有 active run

只有这些条件都满足，才允许以 wake prompt 继续驱动。否则丢弃本次 wake，并只保留 owner 的幂等/状态更新。

### 5. 任意 drive 都取消 idle wake task

进入任何新 drive 前，runtime 必须取消该 dialog 已存在的 idle wake task。包括：

- 用户发送新消息
- 手动 Continue / Resume All
- Q4H answer 恢复
- sideDialog response 恢复
- Diligence Push / 其它 runtime auto-drive
- 本机制自己的 wake drive

取消后，旧 task 即使有 promise resolve，也不得产生副作用。

---

## Wake 消息格式

owner event 的 `content` 应聚焦事实，不给模型伪造用户诉求。

daemon exit 示例：

```text
【系统提示】
后台进程已退出。这是 runtime 环境事件，不是新的用户指令。

- PID: 12345
- 命令: pnpm run build
- 退出状态: code 0, signal null

请根据当前任务上下文判断是否需要查看最终 stdout/stderr 或向用户汇报结果；不要只回复“收到”。
```

driver 聚合多条事件时，应保留每条事件的事实块，并加一个总前缀：

```text
【系统提示】
以下是对话空闲期间发生的 runtime 环境事件。这些事件不是新的用户指令。

1. 后台进程已退出 ...
2. 后台进程已退出 ...

请结合当前任务上下文继续推进；若这些事件不影响当前工作，不要发送占位式确认。
```

---

## Shell daemon exit 当前落地场景

`shellCmdReminderOwner` 实现 `waitForReminderWakeEvent`。

语义：

- 只关注该 owner 拥有的 daemon reminders。
- 只在 daemon 从 running 进入 exited/gone 时产生 wake event。
- stdout/stderr 增长不产生 wake event。
- 如果 reminder meta 已标记对应 exit event 已投递，则返回 `null`。
- event 到达后，owner 同时提供终态 reminder 的 `updatedContent` / `updatedMeta`，由 driver 在投递 wake 前持久化。

需要补充的 meta：

- `originRootId`：恢复 origin dialog 时必须知道 root。
- `originDialogId`：已有字段，继续表示 self id。
- `exitWakeEventId`：稳定事件 id，例如 `shellCmd:daemonExited:<pid>:<startTime>`。
- `exitWakeNotifiedAt`：该事件已被 runtime 采纳并投递的时间。

daemon runner 如果能提供可 await 的 exit 信号，应优先使用；如果当前只能通过本地 IPC 状态检查实现，轮询必须封装在 owner 内部，driver 不承担 daemon 专属扫描逻辑。

---

## 取消与并发模型

每个 dialog 最多一个 idle wake task。

建议 runtime 维护：

```ts
type IdleReminderWakeTask = Readonly<{
  dialogKey: string;
  controller: AbortController;
  startedAt: string;
}>;
```

新 drive preflight 的第一步取消旧 task。取消是幂等的。

idle wake task resolve 后也必须再次检查自己仍是当前 task；如果已经被替换或取消，直接返回。

---

## 崩溃恢复

idle wake task 本身不持久化。后端重启后不会恢复“正在等待”的 promise。

恢复后的首次正常 driver/display/reminder 更新仍会修正 reminder 终态。若需要重启后也主动唤醒 idle dialog，可以补充“启动时对 running idle dialogs 重新安装 idle wake task”的 bootstrap。该能力不是当前机制闭环的必要条件。

---

## 观测与错误处理

owner wait 接口必须 loud by default：

- 非取消错误应 structured log，字段包含 `rootId`、`selfId`、`ownerName`、`reminderId`、`eventId`（若有）。
- owner 不得吞掉不合理状态，例如重复 event id 与不同内容冲突。
- driver 若发现聚合后的状态不允许 revive，应记录 debug/warn 级别诊断，但不应把被丢弃的 wake 作为用户可见消息。

---

## 实现顺序

1. 增加 `ReminderWakeEvent` 与 `ReminderOwner.waitForReminderWakeEvent?` 类型。
2. 增加 driver 侧 idle wake task 管理：start/cancel/race/500ms 聚合/状态复检。
3. 在所有 drive 入口 preflight 取消该 dialog 的 idle wake task。
4. 在 driver 最终落到 `idle_waiting_user` 后启动 idle wake task。
5. 实现 `shellCmdReminderOwner` 的 daemon exit wake event。
6. 为 daemon reminder meta 补充 `originRootId` 与 wake 幂等字段。
7. 补测试：单 daemon 退出唤醒、多 daemon 500ms 聚合、用户消息取消、blocked 不唤醒、幂等不重复。
