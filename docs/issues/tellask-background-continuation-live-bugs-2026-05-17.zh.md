# Tellask 后台续推与状态推送现场 bug 记录（2026-05-17）

本文记录 `tellask-background-continuation-refactor.zh.md` 重构过程中暴露的现场 bug，避免后续实现时遗失上下文。中文语义为准。

## 0. 统一原则

- caller/callee 是运行时业务关系，不是父子层级关系。实现命名已开始把 `parentDialog` 收敛为 `callerDialog`；剩余历史命名只应出现在明确的旧语义说明或尚未触达的内部实现细节中。
- 任何会影响前端 badge / run-control / dialog list 的 dialog 状态变化，都必须有实时广播事件或全局状态推送，不能只依赖下一次列表刷新。
- backend loop 不能全量扫描 root 下所有历史支线。root 长期运行并累积成千上万个支线是正常场景；需要维护 root-local 精确 watch index，只记录当前需要监护的支线子集。
- recoverable 一致性问题优先保活：日志要 loud，带 rootId/selfId/course/genseq/callId/batchId 等结构化字段；能继续对话时不要 hard stop。

## 1. 鞭策机制在 active callee 存在时误发

症状：

- root dialog 正在等待 active callee 时，不应注入鞭策语保持主线空转。
- UI 把“鞭策”从未勾选改为勾选状态时，也会触发鞭策发送，即使对应 root dialog 正在等 active callee。

期望：

- 统一到一个判断函数：只要 dialog 有 pending active callee / background callee boundary，Diligence Push 不应成为主线续推动力。
- “勾选鞭策”只影响可调用工具约束，不绕过 active callee gate。

## 2. caller/callee badge 与状态推送不及时

症状：

- root 开始 tellask 后，dialog list 节点没有自动打上“电话听筒” badge。
- 所有 callee 都已回复后，caller 节点仍未去掉 badge。
- 对支线宣布卡死后，其 caller 应去掉 badge，但 UI 没刷新。
- 支线等待自己的 callee 时，疑似被主线 caller 的停止状态污染，显示“已停止（可继续）”。

当前修复方向：

- 新增 `dlg_background_callee_summary_evt`，在 active callee 增删、resolve、declare-dead 路径广播 pending 数量。
- 前端收到该事件后更新 running dialog list 的 `backgroundCalleeDialogCount` / `backgroundFreshBootsReasoningCalleeCount`。
- 已覆盖 root tellask 开始、callee resolve、registered tellask 替换旧 owner、declare-dead 重试等高风险路径；后续新增 active-callee mutation 时必须同步维护 summary 广播。
- 回归脚本：`kernel-driver:root-tellask-background-callee-badge-event`。

## 3. duplicate pending replyDelivery 不应 hard stop

现场样本：

- rtws: `/ws/AiWorks/daowei2026/chatgpt-workstation/.dialogs`
- error:
  `persistTellaskCall invariant violation: duplicate pending reply delivery (rootId=cb/d9/30f2a99b, selfId=09/62/31c3bfab, existing=tool_UAU0mx13ap5tS7oheJQ5bTEN, incoming=tool_Uw5ITM0NrLfYD6Dh6s6quXoB)`

已定位根因：

- callee 已写 `tellask_reply_resolution_record` 和 response anchor，但 `latest.replyDelivery.status` 仍停在 `pending`。
- 后续同一支线产生新的 `replyTellask*` 时，被误判为 duplicate pending delivery。

期望：

- 成功交付 reply 后同步 `markReplyDeliveryDelivered()`。
- 如果遇到 stale pending replyDelivery，而新 reply call 对应当前有效 reply obligation，应 loud warn 并替换 pending delivery，继续对话。

## 4. 支线 caller 收到 callee 回贴后没有 revive

现场样本：

- rtws: `/ws/AiWorks/daowei2026/chatgpt-workstation/.dialogs`
- caller dialog: `rootId=cb/d9/30f2a99b selfId=3e/d1/31cc4b41`
- callee dialog: `selfId=7e/c5/31decb1f`
- UI link: `course=1&genseq=3&rootId=cb%2Fd9%2F30f2a99b&selfId=7e%2Fc5%2F31decb1f`

现场事实：

- callee `7e/c5/31decb1f` 在 course 1 genseq 3 调用了 `replyTellaskSessionless`。
- caller `3e/d1/31cc4b41/course-001.jsonl` 已写入 `tellask_result_record`。
- caller `latest.yaml` 仍有：
  - `nextStep.triggers[0].kind = result_arrival`
  - `batchId = dispatch:cb/d9/30f2a99b:3e/d1/31cc4b41:c1:g34`
- caller `active-callees.json` 中对应 batch 已是 `resolved/final`，但仍未进入下一轮 generation。

当前判断：

- root backend loop 只照顾 root dialog，不扫描支线 `latest.nextStep`。
- 支线 caller 的 revive 依赖 `supplyResponseToAskerDialog()` 当场直接 `scheduleDrive(callerDialog)`；一旦 fire-and-forget drive 丢失、被 gate 拦截、实例不是 live，durable `result_arrival` 没有后续兜底。

目标修复：

- 维护 root-local `drive-watch.json`，只记录需要 backend 监护的支线 selfId 子集。
- 当支线写入 `nextStep` trigger、open generation 或未完成 `replyDelivery` 时加入 watch；当 trigger 消费、generation closed 且 replyDelivery 完整 recorded 后移除。
- backend loop 仍由 root wake 唤醒，但只扫描 root 本身 + `drive-watch.json` 中的支线，不全量遍历历史支线目录。
- 支线 `result_arrival` 写入后应 wake root backend loop，保证 durable trigger 可恢复。
- 回归脚本：`kernel-driver:sideDialog-caller-result-arrival-backend-watch`。

## 5. 文档/实现状态需更新

文档位置：

- `docs/tellask-background-continuation-refactor.zh.md`

需要同步：

- kernel-driver 已基本不再用 course JSONL 作为 active callee / reply recovery 运行源。
- `latest.tellaskResults`、`replyDelivery`、`active-callees.json`、`nextStep.triggers`、drive watch index 是目标运行源。
- `needsDrive` projection 已删除；`backend_queue` 旧术语仍需继续收敛为显式 next-step API。
- malformed 边界仍未完全完成：`nextStep` 缺失仍会初始化，尚未做到所有必要状态机元信息缺失均转 malformed。
- `sideDialog_created_evt` wire 字段已从 `parentDialog` / `parentBackground...` 收敛为 `callerDialog` / `callerBackground...`。
