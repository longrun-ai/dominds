# Idle Reminder Wake Design

Chinese version: [中文版](./idle-reminder-wake.zh.md)

This document defines a driver-level background coroutine mechanism: after a dialog enters `idle_waiting_user`, the runtime may wait for wake-worthy events from reminder owners. If an event arrives while the dialog is still idle, the runtime packages the event into a system-notice `role=user` message and continues driving the dialog.

This is a design document. It defines semantics, owner interfaces, cancellation, and the current implementation target; it does not prescribe the final code split.

---

## Background

Reminder owners already own the meaning of their reminders. For example, the `shell_cmd` daemon reminder can discover that a daemon has exited during the next reminder update and turn the reminder into a terminal snapshot.

The missing link is idle-time wakeup. If a daemon exits while the dialog is idle, Dominds currently notices only when the dialog is opened, reminders are displayed, or a later drive happens. From the user's perspective, the long-running command has completed, but the dialog does not automatically wake up or explain that the process exited.

The `shell_cmd` tool should not directly drive dialogs to solve this. The driver is the only component that should decide whether a dialog continues running. A reminder owner should only explain when one of its reminders has produced an environment event worth waking the model for.

---

## Goals

- Start a cancelable background await task only after the dialog truly enters `idle_waiting_user`.
- Let reminder owners expose wake-worthy events such as daemon exit.
- After an event arrives, briefly aggregate nearby events before forming one runtime `role=user` system notice.
- If the dialog is still idle after aggregation, continue through the normal driver path.
- Cancel the existing idle await task whenever any new drive starts.
- Preserve owner metadata encapsulation: framework code routes by owner but does not reinterpret owner meta.
- Guarantee idempotence: the same environment event must not insert duplicate system notices.

## Non-Goals

- Do not treat every reminder content change as a wake signal.
- Do not let reminder owners call `driveDialogStream` directly.
- Do not represent the idle await task as an `activeRun`, because the UI must not see environment waiting as proceeding.
- Do not auto-wake blocked, stopped, dead, completed, or archived dialogs.
- Do not wake on every daemon stdout/stderr growth; the current scenario only covers daemon lifecycle exit.

---

## Core Decisions

### 1. The driver owns the idle wake lifecycle

After `driveDialogStreamCore` finally sets display state to `idle_waiting_user`, the outer driver starts a dialog-scoped idle wake task.

The task:

- does not hold the dialog mutex
- does not create an active run
- does not change display state
- only waits for owner-provided wake events
- is canceled before a new drive begins

This keeps "waiting for an environment event" separate from "actively working" and avoids confusing user-visible run-control semantics.

### 2. Reminder owners only report wake events

`ReminderOwner` gains an optional interface:

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

`content` is owner-formatted system-notice text and must start with `【系统提示】` or `[System notice]`. It is not real user input, but because providers commonly lack a dedicated environment role, it is persisted through the runtime prompt path as a `role=user` message.

`eventId` is a stable idempotence key in the owner's domain. The owner must be able to record, in reminder meta or owner-owned state, that the event has already been delivered.

### 3. The first event opens a short aggregation window

The driver should not drive immediately after the first wake event. It should:

1. await the first wake event
2. open an aggregation window of about 500 ms
3. collect other wake events that arrive in the same idle wake task
4. stably sort and deduplicate the events
5. package them into one runtime prompt

This prevents several daemons that exit close together from causing several consecutive drive rounds. The user and model see one combined environment-status message instead of fragmented notices.

### 4. Wake must re-check fresh state

After the aggregation window, the driver must re-read persistence and verify:

- the dialog still exists and is running
- display state is still `idle_waiting_user`
- execution marker is not dead and not an interrupted state requiring human resume
- no pending Q4H exists
- no blocking pending sideDialog exists
- no active run exists

Only then may the driver continue with the wake prompt. Otherwise the wake is dropped, while owner idempotence/state updates may still be retained.

### 5. Any drive cancels the idle wake task

Before any new drive begins, runtime must cancel the dialog's existing idle wake task. This includes:

- user messages
- manual Continue / Resume All
- Q4H-answer resume
- sideDialog-response resume
- Diligence Push / other runtime auto-drive
- the wake drive from this mechanism

After cancellation, the old task must not produce side effects even if one of its promises resolves.

---

## Wake Message Format

Owner event `content` should state facts without inventing a user request.

Daemon exit example:

```text
【系统提示】
后台进程已退出。这是 runtime 环境事件，不是新的用户指令。

- PID: 12345
- 命令: pnpm run build
- 退出状态: code 0, signal null

请根据当前任务上下文判断是否需要查看最终 stdout/stderr 或向用户汇报结果；不要只回复“收到”。
```

When the driver aggregates multiple events, it should preserve each factual block and add a shared prefix:

```text
【系统提示】
以下是对话空闲期间发生的 runtime 环境事件。这些事件不是新的用户指令。

1. 后台进程已退出 ...
2. 后台进程已退出 ...

请结合当前任务上下文继续推进；若这些事件不影响当前工作，不要发送占位式确认。
```

---

## Current Target: Shell Daemon Exit

`shellCmdReminderOwner` implements `waitForReminderWakeEvent`.

Semantics:

- It only watches daemon reminders owned by this owner.
- It only emits a wake event when a daemon transitions from running to exited/gone.
- stdout/stderr growth does not emit a wake event.
- If reminder meta already marks the corresponding exit event as delivered, it returns `null`.
- When the event arrives, the owner also provides terminal reminder `updatedContent` / `updatedMeta`, and the driver persists them before delivering the wake prompt.

Required meta additions:

- `originRootId`: needed to restore the origin dialog.
- `originDialogId`: existing field; continues to mean self id.
- `exitWakeEventId`: stable event id, for example `shellCmd:daemonExited:<pid>:<startTime>`.
- `exitWakeNotifiedAt`: timestamp when runtime accepted and delivered the event.

If the daemon runner can provide an awaitable exit signal, use that as the primary path. If the current implementation can only use local IPC status checks, polling must stay encapsulated inside the owner; the driver must not gain daemon-specific scanning logic.

---

## Cancellation And Concurrency

There is at most one idle wake task per dialog.

Suggested runtime state:

```ts
type IdleReminderWakeTask = Readonly<{
  dialogKey: string;
  controller: AbortController;
  startedAt: string;
}>;
```

The first preflight step of a new drive cancels the old task. Cancellation is idempotent.

After an idle wake task resolves, it must also verify that it is still the current task. If it has been replaced or canceled, it returns without side effects.

---

## Crash Recovery

The idle wake task itself is not persisted. After backend restart, Dominds does not recover in-flight waiting promises.

The first normal driver/display/reminder update after restart still corrects reminder terminal state. If restart-time proactive waking is needed, Dominds can add bootstrap logic that reinstalls idle wake tasks for running idle dialogs. That capability is not required for the current mechanism to be complete.

---

## Observability And Error Handling

Owner wait interfaces are loud by default:

- Non-cancel errors should be structured logs with `rootId`, `selfId`, `ownerName`, `reminderId`, and `eventId` when available.
- Owners must not swallow unreasonable states, such as the same event id mapping to conflicting content.
- If the driver finds that an aggregated wake can no longer revive the dialog, it should record debug/warn diagnostics, but it must not surface the dropped wake as a user-visible message.

---

## Implementation Order

1. Add `ReminderWakeEvent` and optional `ReminderOwner.waitForReminderWakeEvent?` types.
2. Add driver-side idle wake task management: start/cancel/race/500 ms aggregation/fresh state checks.
3. Cancel the dialog's idle wake task in every drive preflight.
4. Start an idle wake task after the driver finally lands on `idle_waiting_user`.
5. Implement daemon-exit wake events in `shellCmdReminderOwner`.
6. Add `originRootId` and wake idempotence fields to daemon reminder meta.
7. Add tests: single daemon exit wake, multiple daemon exits aggregated within 500 ms, user message cancellation, blocked dialogs not waking, and idempotence.
