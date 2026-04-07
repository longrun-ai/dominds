# Issue: `Global dialog event broadcaster missing`

## Summary

在没有初始化全局 dialog event broadcaster 的运行环境里，发布 `new_q4h_asked` / `q4h_answered` / `subdialog_created_evt` / `dlg_touched_evt` 会直接抛错：

```text
Global dialog event broadcaster missing: cannot publish new_q4h_asked for dialog=<id>
```

这不只是噪音日志。对于 `askHuman` / Q4H 链路，这个异常会被上层当作“Q4H 注册失败”处理，导致：

- Q4H 状态文件其实已经写入
- 但 runtime 仍然走失败分支
- 追加 `stream_error_evt`
- 向当前对话注入失败型 tellask result
- 造成“持久化成功、广播缺失、业务语义却被当作失败”的错位

## Observed In

- `tests/recovery/reply-special-after-restart.ts`
- 其它不启动完整 websocket server、但会触发 Q4H runtime 的脚本型 / test 型运行环境

## Current Call Chain

1. `main/llm/kernel-driver/tellask-special.ts`
   `executeTellaskCall()` 在 Q4H 分支先调用 `DialogPersistence.appendQuestion4HumanState()` 落盘
2. 同一分支随后调用 `postDialogEvent(dlg, { type: 'new_q4h_asked', ... })`
3. `main/evt-registry.ts`
   `dispatchGloballyIfNeeded()` 发现 `new_q4h_asked` 属于 global-only event
4. 若 `globalDialogEventBroadcaster === null`，则直接 `throw`
5. 异常被 `tellask-special.ts` 的 Q4H `try/catch` 捕获
6. 上层误判为“Q4H register invariant violation”，转入失败补偿路径

## Correct Contract

这里应明确：**global dialog event broadcaster 不是可选增强，而是 runtime 必要基础设施**。

也就是说：

- 任何支持 dialog runtime 的运行环境，在进入对话驱动 / Q4H / 子对话逻辑前，都必须先完成 broadcaster bootstrap
- WebUI server 只是其中一种 runtime；将来其它 runtime 也必须在位
- 测试运行环境同样应按 runtime bootstrap 的方式安装 broadcaster，而不是在业务 helper 里零散补丁

因此，这个问题的根因不是“event layer 应该 graceful degrade”，而是**存在未完成 broadcaster bootstrap 的 runtime**，并且这个缺陷直到业务路径中途才暴露。

## Why It Happened

此前全局 broadcaster 只在 `main/server/websocket-handler.ts` 的 websocket server 初始化阶段通过 `setGlobalDialogEventBroadcaster(...)` 安装。

但脚本 / 测试 / recovery 运行环境也会直接触发同一批 global-only event。于是形成了：

- dialog-scoped event registry 已可用
- global broadcaster 尚未安装
- `postDialogEvent()` 处理 global-only event 时立刻抛错
- 上层业务把该异常误判成 Q4H 注册失败 / 业务失败

## Impact

### User-visible / behavior impact

- `askHuman` 在未完成 runtime bootstrap 的环境下会被错误地当作失败处理
- 当前对话会收到失败型 tellask result，而不是保持正常 pending Q4H 语义

### Persistence / state consistency impact

- Q4H state 已经写入，但 runtime 业务语义被标成失败
- 形成“状态已存在、当前轮回答却说失败”的不一致

### Test / diagnostics impact

- 用例可能通过，但日志出现误导性错误
- 排障时很难第一眼区分“runtime 缺少 broadcaster bootstrap”还是“Q4H 真的注册失败”

## Repro

1. 在不启动 websocket server、且未安装 recording broadcaster 的脚本环境里创建 dialog
2. 触发 `askHuman`
3. 观察日志出现 `Global dialog event broadcaster missing`
4. 观察上层继续记录 `Q4H register invariant violation`

## Root Cause

根因不是 Q4H 注册本身，而是 runtime contract 与 bootstrap 现实不一致：

- 契约上：broadcaster 是 mandatory infra
- 现实里：只有 websocket server 显式安装，其它 runtime 没有统一 bootstrap

于是“基础设施未初始化”在业务路径中被表象成“Q4H 注册失败”。

## Resolution Direction

按下面原则修：

1. 保持 event layer 的强约束：global-only event 没有 broadcaster 时仍然应 loud fail
2. 修复点应放在 runtime bootstrap，而不是在 Q4H/子对话业务链路里做“广播失败 best-effort”
3. 所有 runtime 入口都必须在业务逻辑前安装 broadcaster
   - WebUI server：安装 websocket fanout broadcaster
   - tests / script runtimes：安装 recording broadcaster，可抓取广播内容，也可在无断言需求时忽略
4. 测试不得再通过业务 helper 临时塞 `() => {}` 绕过问题；应通过统一 runtime bootstrap 安装 recorder
5. 若 future runtime 漏装 broadcaster，应在 bootstrap 阶段或运行环境初始化阶段尽早暴露，而不是等到 `askHuman` 中途再炸

## Rejected Direction

以下方向不再采用：

- 让 `dispatchGloballyIfNeeded()` graceful degrade
- 在 `askHuman` 链路里把 broadcast 当成 best-effort
- 允许测试/business helper 就地注入 noop broadcaster 掩盖 bootstrap 缺口

这些做法都会继续模糊“mandatory infra”契约，让问题从 runtime 初始化阶段滑落到业务中途。

## Applied Fix Direction

当前约定下，正确修法是：

- 新增统一 broadcaster bootstrap API
- WebUI server 改为通过统一 bootstrap API 安装 websocket broadcaster
- rtws tests 改为通过统一 runner 安装 recording broadcaster
- kernel-driver helpers 不再偷偷安装 noop broadcaster，而是断言 runtime 已完成 bootstrap

## Related Files

- `main/bootstrap/global-dialog-event-broadcaster.ts`
- `main/evt-registry.ts`
- `main/server/websocket-handler.ts`
- `tests/rtws-script-runner.ts`
- `tests/kernel-driver/helpers.ts`
