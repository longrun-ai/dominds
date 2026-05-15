# Tellask 后台继续语义与崩溃恢复对齐重构计划

## 背景

本计划记录一次围绕 `tellask` 后台诉请续推行为的语义收敛，并把它扩展到后台进程崩溃/重启后的自动恢复逻辑。

触发案例来自一个真实运行时工作区：

- rtws：某真实运行时工作区（具体路径已脱敏）
- 主线对话：`rootId=bd%2F86%2F0d197a16&selfId=bd%2F86%2F0d197a16`
- 课程：`course=30`
- 关注气泡：`genseq=1845`

现场关键序列：

1. `genseq=1842`：LLM 只调用了一次 `tellask`，向 `@fullstack` 发起 `network-diagnostic-impl` 长线诉请。
2. runtime 创建 Side Dialog，登记 pending sideDialog，并写入 pending `func_result_record`。
3. `genseq=1843`：主线无新用户输入地继续生成。
4. `genseq=1844`：主线再次调用 `tellask`，向 `@doc-editor` 发起 handbook 草稿诉请。
5. `genseq=1845`：主线继续执行本地工具。

业务直觉上，单个 pending `tellask` 后可以自然停在当前边界；后续是否保活应由 Diligence Push 独立决定，而不是由 pending tellask 的 tool result 自动驱动下一轮 LLM generation。

### 现场证据锚点

`course-030.jsonl` 中的 durable events 支持以下判断：

- `genseq=1842` 已写入 `tellask_call_record`、`sideDialog_created_record`、pending `func_result_record`，且该 generation 后续已有 `gen_finish_record`。这说明“诉请发出”这一轮本身已经闭合。
- `genseq=1844` 再次出现单个 `tellask` dispatch ack，并在 `gen_finish_record` 后约 3 秒出现 `genseq=1845` 的新 `gen_start_record`。因此 `genseq=1845` 不是同一 LLM generation 内自然延续，而是外层 drive 又把主线调起。
- 同一 rtws 的 `latest.yaml` 后续落在 `generating: false`、`needsDrive: true`、`displayState: blocked/waiting_for_sideDialogs`。这说明当前系统把“后台诉请仍 pending”误投影成了“诉请者正在等待被诉请者”的运行状态；大多数场景看起来会停，靠的是这个旧误投影，而不是最终原则。

这三个事实共同说明：最终原则不是要修复一个单点 if，而是要把 `tellask` background fact、下一步动作判定、Diligence Push、restart recovery 四套语义拆清楚。这里的 dialog 不是只指主线；任意对话都可能作为 caller 发起后台诉请，也都可能通过 `tellaskBack` / ask-back 路径成为 callee 并承担回贴义务。

## 最终原则

### 核心语义

`tellask` 的业务语义固定为后台并行委派：

- `tellask` / `tellaskSessionless` / registered Type-B assignment 只产生后台诉请事实。
- pending tellask 不表示 caller dialog 必须停下；caller 可以是主线，也可以是支线。
- pending tellask 不要求 caller dialog 等待回贴。
- pending tellask 不等价于 `waiting_for_sideDialogs` 显示/运行状态。
- caller dialog 可以继续，也可以自然 idle；这由智能体后续动作、用户输入、queued prompt、Diligence Push 等通用机制决定。
- callee dialog 的 active reply obligation 是另一种事实：它表示“当前 dialog 最终必须交付回贴”，但不妨碍该 dialog 自己发起下游 pending tellask。

### 角色相对性

同一个 dialog 可能同时处在多个相对角色中，不能用“主线/支线”静态划分控制流：

- 作为 caller：它发起 `tellask` / `tellaskSessionless` / `tellaskBack`。它发出的 pending tellask 对它自己是后台事实，不决定“现在必须停下”。
- 作为 callee：它因为上游诉请或 ask-back 而承担 active reply obligation。这个义务用于完成判定、reply tool 引导、direct-fallback 交付和崩溃恢复。
- 作为 reply result owner：它等待某个 reply tool 写回 canonical result。`replyTellaskBack` 尤其要区分“执行 reply 的 dialog”“等待 tellaskBack result 的 dialog”“最终接收业务回贴的上游 dialog”。
- 作为 dispatch batch owner：它在同一次 LLM move 中一次性发出多个 `tellask` 时，负责按这组派发批次的整体结果边界收口。单个 `tellask` 只是 dispatch batch size = 1 的特例。

因此规则必须按“当前 dialog 相对于某条诉请/回贴链路的角色”判定，而不能写成“主线停、支线停”或“所有 sideDialogs 都等待”。主线被 `tellaskBack` 时同样是 callee；支线发起下游 `tellask` 时同样是 caller。

### 主线 / 支线差异边界

业务上，主线 / 支线差异应收敛为白名单，而不是散落在 run-control 语义里：

- 主线承担编排责任：维护全局推进叙事、拆分/合并工作、协调多路诉请。
- 主线与其它主线共同维护差遣牒；支线只读差遣牒，不能把自己的局部视角写成全局事实。
- 支线承担被委派事项的交付责任；如果需要影响全局计划，应通过 reply / tellaskBack / 明确回贴把信息交给具备编排责任的 dialog。
- 技术上，主线是归档单位：由人类用户手工标记完成/归档，归档时定义一组运行记录的生命周期边界。

除此之外，主线和支线不应在以下机制中拥有业务语义差异：

- `tellask` background delegation。
- active reply obligation / reply recovery。
- 派发批次回贴齐备后的 result-arrival handling。
- Q4H：等待用户回答。
- crash/restart recovery。
- post-tool immediate continuation。
- displayState / run-control 状态投影。

Diligence Push 是例外：它只作用于主线对话，因为它是编排保活机制。callee 不被运行时鞭策；callee 如果出现非本意的直接回复并停止驱动，应通过 direct-fallback 把事实交回 caller，由 caller 智能判断是续推原诉请、发起 `tellaskBack`，还是另开其它诉请对话。

实现上存在入口形态差异，例如主线通常由用户创建，支线通常由诉请创建；WebUI 把主线作为归档、导航、课程聚合入口。这些是 lifecycle / presentation 差异，不影响 dialog drive 语义。

### 三层边界

1. `tellask` 层：只登记后台工作事实和回贴义务。
2. post-tool auto-continue 层：只处理真正需要当前 LLM 立刻消化的 tool result、queued prompt、错误恢复、reply 工具收口等通用驱动事实。
3. Diligence Push 层：主线编排保活机制；可把 pending tellask 作为判断输入，但不改变 `tellask` 的业务语义，也不作用于支线。

### 不再抽象 `blocker`

目标设计不需要把业务状态先反向抽象成 `blocker`，再由 `blocker` 推导行动。更顺直的表达是：

- 现在是否有用户问题要等：有则等待用户。
- 现在是否有 runtime prompt / queued prompt 要消费：有则消费。
- 当前工具轮是否产生了需要模型立刻消化的结果：有则继续本轮后续 generation。
- 是否有后台诉请回贴结果到达：有则按派发批次 complete 触发等待方处理。
- 是否还有后台诉请 pending：只更新可观测状态；主线可被 Diligence Push 保活，callee 不由运行时鞭策。
- 当前 dialog 是否欠上游交付：记录 completion obligation，并引导 reply/direct-fallback 收口；它不改写后台诉请的语义。

因此 `blocker` 只应作为旧代码命名或旧 displayState 的迁移对象被提及，不应成为新设计里的业务概念。

### 同类概念也要降级

类似 `blocker`，下面几个词也容易把技术症状误升级成业务机制：

- `needsDrive`：业务上不是“这个 dialog 需要被驱动”的抽象状态，而是有一个具体下一步动作来源：用户输入、queued prompt、主线 Diligence Push、回贴结果到达、open generation 续跑等。实现上保留 boolean 投影，但必须能追溯到具体来源。
- `entitlement` / `revive`：业务上不是某个 dialog 获得“恢复权”，而是“有新事实到达，等待方应处理”。目标实现以 `result_arrival` trigger 表达这件事；若底层仍保留 entitlement token，只能作为防重入/防误续推的内部令牌，并必须携带同一个 `dispatchBatchId`。
- `wait-group`：业务上不是 caller 正在等待一组 callee，而是“同一次派发批次的回贴结果要成组收口”。因此设计用 dispatch batch / 派发批次描述，不再新增 `waitGroupId` 这类等待语义字段名。
- `proceeding recovery`：业务上不是恢复 proceeding 状态，而是“上一次 generation 确认未闭合，所以继续同一轮”。已闭合 generation 只能从状态快照重新投影状态。
- `latest` / `displayState`：业务事实的来源应是状态机转移时维护的结构化元信息；`displayState`、run-control counts 都只是投影，不能反向决定业务事实。

### 状态机携带判定元信息，杜绝历史回扫

这次重构要一并清理旧技术债：以前为了做某些判断，会重新扫描聊天记录、course JSONL、历史 tool calls 或 pending records 来推导当前状态。目标态禁止这种设计。

原则：

- 每一次状态机转移都必须同步写入后续判断所需的最小充分元信息。
- 状态事件写入和状态快照更新必须在同一个事务/临界区完成；不能出现 event 已落盘但判定元信息未更新的半状态。
- runtime 下一步判定、Diligence Push、result-arrival handling、restart recovery、display projection 都只读当前状态快照和显式 pending records。
- 不用“回扫历史聊天记录”来推导 open generation、dispatch batch completion、reply delivery 是否完成、active reply obligation、needsDrive 来源等运行判定。
- 历史事件日志仍然保留为审计、调试、人类追查、一次性迁移和一致性校验输入；它不是常态业务判定的数据源。
- 如果当前状态快照缺少必要元信息，应按 loud error policy 报错并停止不安全路径，而不是静默扫描历史补猜。

状态机至少需要携带：

- active generation 元信息：`course`、`genseq`、`phase`、是否已写入 finish、最后一次 tool round 分类。
- user wait 元信息：是否正在等待 Q4H / askHuman 的用户回答、对应 questionId、等待来源 course/genseq。
- next-step trigger 元信息：`needsDrive` 的具体来源、来源 course/genseq/callId、是否一次性消费。
- dispatch batch 元信息：`dispatchBatchId`、owner dialog、call site、成员 callIds、每个 call 的 pending/resolved/final 状态、batch 是否 complete。
- reply delivery 元信息：active reply obligation、expected reply tool、target dialog/callId、delivery status、tool-result status。
- background work 元信息：pending tellask 摘要、与 dispatch batch 的关联、用于主线 Diligence 的只读上下文。

next-step trigger 使用显式 union，而不是裸 boolean：

```ts
type NextStepTrigger =
  | { triggerId: string; kind: 'user_input'; course: number; genseq: number }
  | { triggerId: string; kind: 'queued_prompt'; promptId: string; course: number }
  | { triggerId: string; kind: 'backend_queue'; reason: string; course: number }
  | {
      triggerId: string;
      kind: 'mainline_diligence';
      diligenceId: string;
      pendingTellaskCount: number;
    }
  | { triggerId: string; kind: 'result_arrival'; dispatchBatchId: string; ownerDialogId: string }
  | { triggerId: string; kind: 'open_generation_recovery'; course: number; genseq: number }
  | {
      triggerId: string;
      kind: 'reply_delivery_recovery';
      replyDeliveryId: string;
      targetDialogId: string;
    };

type NextStepTriggerState = {
  triggers: NextStepTrigger[];
};
```

`needsDrive=true` 只是 `triggers.length > 0` 的投影，表示“有未消费的新事实”，不等价于“此刻允许启动 drive”。backend loop / run-control 必须同时读取 user wait 等先决等待事实；只有先决等待为空时，未消费 trigger 才能进入 runnable drive。触发源被消费后必须从 `triggers` 删除，避免崩溃重启后重复执行；不保留长期 consumed trigger 账本。

`userWait` 使用独立状态表达先决等待：

```ts
type UserWaitState = {
  kind: 'awaiting_user_answer';
  questionId: string;
  callId: string;
  course: number;
  genseq?: number;
  askedAt: string;
};
```

`userWait.kind === 'awaiting_user_answer'` 是先决等待事实，不是 trigger。等待用户期间到达的 `result_arrival` 等新事实仍要写入 `NextStepTriggerState`，但 backend driver 不能越过 user wait 自动启动；用户回答到达并清除 user wait 后，再按未消费 trigger 继续处理。

迁移期可以写一次性 reconciler 从历史事件补齐这些字段，但补齐完成后，线上运行路径不得继续依赖回扫。

这条规则可以作为后续重构的命名约束：若一个新概念不能回答“哪个业务事实到了、下一步应做什么”，就不要把它放进目标设计；最多把它留在模块级迁移说明里。

### 规约句

`pendingSideDialogs` is an observability fact and, for mainline dialogs only, a Diligence Push input. It must not decide whether the dialog can keep working.

中文表达：

> pending tellask 只是后台进行中事实；它只参与 observability、主线 Diligence Push 是否保活、以及回贴到达后的 result-arrival handling，不决定 caller dialog 是否继续工作。

## 当前实现事实

### 为什么大部分场景看起来符合原则

当前实现中，普通单个 `tellask` 后多数情况下会停住，但原因不是最终原则，而是旧“pending sideDialog 等同诉请者等待被诉请者”的投影机制。

路径：

1. `tellask-special.ts` 创建/更新 Side Dialog，并把 pending sideDialog 写入 `pending-sideDialogs.json`。
2. 如果没有立即获得回贴，`processTellaskFunctionRound` 会为 callId 生成 pending `func_result_msg`。
3. `drive.ts` 在工具轮结束后执行：

```ts
const suspensionAfterToolRound = await dlg.getSuspensionStatus({
  allowPendingSideDialogs: routed.hasImmediateFollowupToolCalls,
});
if (!suspensionAfterToolRound.canDrive) {
  await preserveDiligenceBudgetAcrossQ4H(dlg);
  break;
}
```

4. `Dialog.getSuspensionStatus()` 当前把 pending sideDialogs 当成不能继续驱动的原因：

```ts
const blockingSideDialogs = hasSideDialogs && options?.allowPendingSideDialogs !== true;
```

因此多数单个 pending `tellask` 后会因为 `canDrive=false` break。这种结果表面接近“发完诉请自然停”，但底层语义是“诉请者等待被诉请者”，与最终原则不一致。

### 为什么触发案例不符合原则

触发案例中，`genseq=1842` 后仍出现 `genseq=1843` 无 prompt 续推，说明不是同一 LLM generation 内自然继续，而是外层调度又启动了主线 drive。

当前可解释路径：

1. backend loop 会驱动 `globalDialogRegistry.needsDrive=true` 的主线对话。
2. `loop.ts` 对 `latest.generating === true` 的主线对话使用 `resumeInProgressGeneration`：

```ts
const resumeInProgressGeneration = latest?.generating === true;
if (!resumeInProgressGeneration && !(await mainDialog.canDrive())) {
  continue;
}
```

3. 这会绕过 `mainDialog.canDrive()`。
4. `flow.ts` 在 no-prompt resume 路径中又允许 `resumeInProgressGeneration` 越过 pending sideDialogs：

```ts
allowPendingSideDialogs: driveOptions?.resumeInProgressGeneration === true,
```

所以当前实现出现了两种不一致：

- 普通路径：pending tellask 被当成“需要等待”，诉请者停。
- proceeding/recovery 路径：这个“需要等待”的判断被绕过，诉请者续推。

这解释了“多数场景符合，但该现场不符合”：多数场景靠旧误投影恰好停住；该现场被 queued/proceeding recovery 绕过了旧误投影。

更精确地说，当前实现存在一个“结果偶然正确、控制语义错误”的组合：

- 普通路径用 `pendingSideDialogs -> canDrive=false` 让诉请者停，这是错因对果。
- resume/proceeding 路径用 `resumeInProgressGeneration -> allowPendingSideDialogs=true` 绕过同一判断，让诉请者继续，这是错因错果。
- 最终重构后，二者都不应依赖 pending tellask：普通路径停，是因为 pending dispatch ack 不构成 immediate post-tool generation；resume/proceeding 路径不应重放已经 `gen_finish` 的 generation。

## 与最终原则的 Gap

### Gap 1：pending sideDialog 被误当成“caller 正在等待”

位置：

- `Dialog.getSuspensionStatus()`
- `computeIdleDisplayState()`
- `computeIdleDisplayStateFromPersistence()`
- `blockerDisplayState()` 及相关显示投影
- run-control snapshot 计数
- restart reconciliation projection

问题：

- 诉请者的 pending tellask 被显示成 `blocked/waiting_for_sideDialogs`。
- 任意 callee 如果自己再作为 caller 发起下游诉请，也会被相同的 pending sideDialog 机制当成“正在等待下游被诉请者”，而这同样不符合 background delegation 语义。
- Continue / resumable 计数把 pending tellask 当成暂停原因，且无法区分“caller 后台诉请 pending”和“callee active reply obligation 未完成”。
- backend loop 用 `canDrive()` 把 pending tellask 当作不可驱动条件。

目标：

- 对任意 caller dialog，pending tellask 不应导致 `canDrive=false`。
- 对任意 caller dialog，pending tellask 不应投影为 `blocked/waiting_for_sideDialogs`。
- 任意 dialog 作为 callee 的 active reply obligation 需独立建模为 completion obligation；它说明当前 dialog 还欠上游交付，但不说明当前 dialog 不能继续工作。
- Q4H 等真正需要外部输入的状态应表达为“等待用户回答”，而不是混进 pending tellask。

### Gap 1.5：主线/支线推进规则没有统一到角色模型

当前代码里主线/支线推进逻辑散落在：

- `flow.ts` 的 fresh suspension reload、interjection pause resume、result revive entitlement。
- `runtime.ts` 中旧 sideDialog diligence recovery 路径已按最终原则移除；不要重新引入支线鞭策注入。
- `tellask-special.ts` 的 reply obligation、replyTellask\*、tellaskBack 处理。
- `recovery/proceeding-drive.ts` 和 `recovery/reply-special.ts`。

问题：

- 任意 dialog 作为 callee 时，受 active reply obligation 约束最终交付；但它仍能用普通工具、向下游 `tellask`，并在非本意 direct response 时把 fallback 交给 caller 判断。
- 任意 dialog 作为 caller 时，它发出的 pending tellask 是后台事实，不应让自身 `canDrive=false`。
- 主线被 `tellaskBack` 时也可能是 callee；这时它需要按 active reply obligation 完成 ask-back 回答，而不是按“主线永远只接收最终结果”的假设处理。
- 直接自然语言回复、thinking-only、函数调用后继续、replyTellask\* 成功后的 stop-current-round，这些完成判定依赖 active reply obligation 和最新 generation 状态，不能被 pendingSideDialogs 混淆。
- result revive entitlement 是当前实现里表达“回贴结果到达”的技术令牌，不是“仍有 pending sideDialog”驱动；二者现在容易在 display/run-control 里混到一起。

目标：

- 建一个所有 dialog 共用的“业务事实 -> 下一步动作”分类：等待用户回答、处理已到达用户输入、欠上游交付、后台诉请进行中、已有新结果可处理、可继续本轮工具结果消化、自然 idle。
- active reply obligation 属于 completion obligation；pending downstream tellask 属于 background work。
- 移除 callee 运行时鞭策语义；callee direct-fallback 交由 caller 决策，不由 runtime 代替 callee 续推。
- 任何 dialog 的 pending background work 都不进入暂停/可恢复计数。

### Gap 2：pending tellask 的 tool result 语义不够显式

当前 pending `tellask` 会成为 `func_result_record`，内容为“诉请已发出，当前仍在等待回贴”。这条记录是事实回执，不是需要 LLM 立刻推理的业务输出。

目标：

- pending tellask result 应归类为 background dispatch acknowledgment。
- 单个 pending tellask result 不触发 immediate post-tool generation。
- 如果同一轮还有普通 tool result、invalid tool call、queued prompt、reply recovery，则仍按对应机制继续。

### Gap 2.5：多路 `tellask` 的派发批次边界不够显式

业务上，同一次 LLM move 可以发出多个 `tellask`。这时 caller 的“后台结果到达后自动恢复”应按整组 callee 回复收口：

- 同一 dispatch batch 内任意单个 callee 回贴，只更新该 call 的结果事实和 pending 状态。
- 只有该批次所有 callee 都已有最终结果，caller 才获得 result-arrival trigger。
- 单个 `tellask` 是 dispatch batch size = 1 的特殊情况，因此看起来像“单个回贴即触发”，但实现上仍应走同一批次收口规则。
- 如果同一 generation 里同时有多组不同语义的 dispatch，需要 durable batch identity 区分；不能只靠“当前 pendingSideDialogs 为空/非空”粗判。

当前 `PendingSideDialogStateRecord` 有 `callSiteCourse` / `callSiteGenseq` / `callId`，可以弱推导“同一 generation 发出的 pending tellask”，但缺少显式 `dispatchBatchId`。重构目标是补一个 durable batch identity，并把 `(ownerDialogId, callSiteCourse, callSiteGenseq, rootGenseq)` 作为校验字段；持久化、恢复、测试统一使用 `dispatchBatchId`，不再新增 `waitGroupId` 这类等待语义字段名。

### Gap 3：Diligence Push 与“等待被诉请者”投影混杂

Diligence Push 是主线编排保活机制。它可以参考 pending tellask，但不应复用“等待被诉请者”投影，也不应扩展成 callee reply-recovery 机制。

当前：

- `maybeContinueWithDiligencePrompt()` 先调用 `getSuspensionStatus()`。
- pending sideDialog 会让 Diligence Push break。
- idle reminder wake 也要求 pending sideDialogs 为空。

目标：

- Diligence Push 只在主线对话触发，独立读取 pending tellask 事实，判断是否保活。
- pending tellask 可影响主线 Diligence prompt 文案，例如提醒“仍有后台诉请未回贴，不要宣布全局完成；如无本地可做事项，可以等待”。
- pending tellask 不应通过 `canDrive=false` 间接影响主线 Diligence Push。
- 支线不触发 Diligence Push；支线直接回复或停驱动时，按 direct-fallback/result fact 交回 caller。

### Gap 4：崩溃/重启恢复把 `generating=true` 视为可自动续跑

启动顺序：

1. `reconcileDisplayStatesAfterRestart()`
2. `recoverProceedingDrivesAfterRestart()`
3. `recoverPendingReplyTellaskCallsAfterRestart()`
4. `runBackendDriver()`

当前规则：

- `isRecoverableGeneratingLatest(latest)` 对 `generating=true` 且没有强 interrupted/dead marker 的 dialog 返回 true。
- restart reconciliation 把它设为 `needsDrive=true`、`displayState=proceeding`。
- 主线 proceeding recovery 将主线对话标记为 needsDrive。
- backend loop 发现 `latest.generating=true` 时用 `resumeInProgressGeneration=true` 自动 drive。

风险：

- 如果进程在单个 pending tellask 刚发出后崩溃，重启后可能把这个“已完成 dispatch 的边界”误判为 in-progress generation，并继续主线。
- 如果 latest 中 `generating` 未及时清 false，普通 runtime 也可能出现类似 proceeding resume 绕过。

目标：

- 重启恢复要区分“LLM 正在真正未完成 streaming/tool round”与“上一轮已经持久化 gen_finish / pending tellask dispatch boundary”。
- 对已存在 `gen_finish_record` 的 latest generation，不应用 `resumeInProgressGeneration` 继续。
- 对最后一轮只有 background `tellask` dispatch ack 且已 finished 的 dialog，恢复后应进入 idle + pending tellask observability，而不是 proceeding。

### Gap 5：`needsDrive` 队列含义过宽

当前 `latest.needsDrive` / `globalDialogRegistry.needsDrive` 既可能表示：

- 有 queued prompt / pending runtime prompt 需要消费；
- 有回贴结果到达，需要等待方 dialog 处理结果；
- 有 restart recovery 需要恢复真正 open generation；
- 也可能只是 pending sideDialog 被误投影后导致 backend loop 保持 queued。

最后一种不应继续存在。pending tellask 是后台事实，不是“待驱动队列”的理由。重构后 `needsDrive=true` 必须是 `NextStepTriggerState.triggers.length > 0` 的投影，且每个 trigger 必须是显式 union variant：`user_input`、`queued_prompt`、`mainline_diligence`、`result_arrival`、`open_generation_recovery`、`reply_delivery_recovery`。

## 重构目标

### 行为目标

1. 单个 pending `tellask` 后当前 drive 停在边界，不自动开下一轮 LLM generation。
2. UI 显示诉请者自身的 idle 或 proceeding/保活状态，不显示 `waiting_for_sideDialogs`。
3. pending tellask 状态通过 pendingTellask reminder / pending sideDialog panel / call bubble / 后台被诉请者 badge 展示。
4. 主线 Diligence Push 可以因为 pending tellask 存在而保活，但这是独立 prompt 驱动；支线不触发 Diligence。
5. 崩溃重启后，已完成的 dispatch boundary 不被误恢复成 proceeding auto-drive。
6. replyTellask\*、askHuman、tellaskBack、active reply obligation 等真正交付/恢复语义不退化。

### 非目标

- 不引入 `tellask` continuation policy 字段。
- 不把 nextAction 做成协议字段。
- 不改变 replyTellask\* 的正式交付机制。
- 不把 pending tellask 静默丢弃或降级为不可观测状态。
- 不引入“主线/支线各一套 drive 规则”；除编排/差遣牒/归档生命周期外，按统一 dialog 语义处理。

## 设计方案

### 1. 按业务事实决定下一步动作

新增或重命名内部查询，避免一个 `getSuspensionStatus()` 同时服务所有业务：

```ts
type DialogNextStepFacts = {
  userWait: DialogUserWaitState;
  nextStep: NextStepTriggerState;
  completionObligation: DialogCompletionObligationState;
  backgroundWork: PendingBackgroundWork;
};

type DialogUserWaitState =
  | { kind: 'none' }
  | { kind: 'awaiting_user_answer'; questionId: string; course: number; genseq: number };

type DialogCompletionObligationState =
  | { kind: 'none' }
  | {
      kind: 'active_reply_obligation';
      expectedReplyCallName: 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack';
      targetDialogId: string;
      targetCallId: string;
    };

type PendingBackgroundWork = {
  pendingTellaskCount: number;
  pendingTellaskRecords: PendingSideDialogStateRecord[];
};

type TellaskDispatchBatch = {
  ownerDialogId: string;
  dispatchBatchId: string;
  callSiteCourse: number;
  callSiteGenseq: number;
  pendingCallIds: string[];
  resolvedCallIds: string[];
  isComplete: boolean;
};
```

下一步动作按事实直接判定：

- `userWait.kind === 'awaiting_user_answer'`：等待用户回答；不触发 Diligence，也不把 pending tellask 混进等待原因。
- `nextStep.triggers` 中有 `user_input`：处理已经到达的用户输入；Q4H 仍由独立的等待用户回答状态表达。
- `nextStep.triggers` 中有 `queued_prompt`：消费 runtime prompt / queued prompt。
- `nextStep.triggers` 中有 `mainline_diligence`：注入主线 Diligence prompt。
- `nextStep.triggers` 中有 `result_arrival`：让等待方处理 dispatch batch 回贴结果。
- `nextStep.triggers` 中有 `open_generation_recovery`：继续未闭合 generation。
- `nextStep.triggers` 中有 `reply_delivery_recovery`：完成未交付 reply。
- 有 immediate tool result：继续当前 drive 让 LLM 消化结果。
- 只有 background pending tellask：更新 observability；主线可由 Diligence Push 保活；否则自然 idle。
- 有 active reply obligation：在已有驱动中引导 reply/direct-fallback 收口；它不是“必须暂停”或“必须立刻开新一轮”的事实。

completion 判断使用 `DialogCompletionObligationState`：

- active reply obligation：对任意需要 reply 工具收口的 callee 上下文生效，包括主线被 `tellaskBack` 的场景。
- 它要求当前 dialog 最终交付，但不阻止当前 dialog 使用工具、发起下游 tellask、或继续推理。

pending tellask observability 使用 `PendingBackgroundWork`。四者不可混用：

- user wait facts 决定“是否正在等用户回答”。
- next-step facts 决定“已经有哪个新事实需要处理”。
- completion obligations 决定“这个 dialog 是否还欠上游交付”。
- background work 决定“有哪些后台诉请仍在进行中”。

### 2. 调整 dialog display projection

`computeIdleDisplayState()` 对任意 dialog：

- 有 Q4H：显示等待用户回答。
- 没 Q4H，仅有 pending tellask：`idle_waiting_user`。
- 有 active reply obligation：不把它显示成 `waiting_for_sideDialogs`；dialog 仍可 idle/proceeding，completion obligation 通过 reply guide / call bubble / direct-fallback path 表达。
- UI 表达“后台进行中”时，走 pendingTellask reminder / panel，不复用暂停态。

本轮不新增 `background_work_pending`；后台进行中只通过 pendingTellask reminder / panel 表达。

### 3. 调整 post-tool continuation 判断

在 `drive.ts` 工具轮后：

- `replyTellask*` 成功：仍 stop current round。
- `dlg.hasUpNext()`：仍消费 queued prompt。
- `routed.hasImmediateFollowupToolCalls`：只由普通工具、invalid call、真正需要模型消化的结果决定。
- pending tellask ack 不计入 immediate followup。
- pending tellask ack 不让 `allowPendingSideDialogs` 变成 true，也不作为是否继续的判断输入。

新增显式命名：

```ts
const shouldStartImmediatePostToolGeneration =
  routed.hasImmediateFollowupToolCalls ||
  routed.hasTellaskResolvedToolOutputs ||
  invalidFuncCallCount > 0;
```

其中 pending dispatch ack 不属于 `hasTellaskResolvedToolOutputs`。

### 4. Diligence Push 接入 pending tellask

主线 Diligence Push 的前置判定只检查需要先处理的业务事实，pending tellask 作为 context 传入。支线不触发 Diligence Push。

新增 Diligence context：

```ts
type MainlineDiligenceContext = {
  pendingTellaskCount: number;
  pendingTellaskSummaries: string[];
  localRunnableWork: { kind: 'known'; hasRunnableWork: boolean } | { kind: 'unknown' };
};
```

prompt 文案原则：

- pending tellask 存在时，不催促“必须继续本地工作”。
- 应提醒：
  - 后台还有诉请未回贴；
  - 不要声称全局已完成；
  - 若有独立本地事项，继续推进；
  - 若没有本地可做事项，可以等待回贴或向用户报告当前后台状态。
- callee 非本意直接回复停止驱动时，不注入鞭策 prompt；direct-fallback 交给 caller 处理。

### 5. 后台进程崩溃/重启恢复

恢复逻辑必须基于状态机维护的 generation 元信息，而不是只看 `latest.generating`，也不是重启时回扫 course events 推导。

#### 5.1 判定 latest generation 是否已经完整结束

新增状态字段和 helper：

```ts
type GenerationRunState =
  | {
      kind: 'closed';
      course: number;
      genseq: number;
      finishRecordId: string;
      lastToolRoundKind:
        | 'background_dispatch_only'
        | 'ordinary_tool_result'
        | 'reply_delivery'
        | 'none';
    }
  | {
      kind: 'open';
      course: number;
      genseq: number;
      phase: 'streaming' | 'tool_round' | 'finishing';
      openedAt: string;
    };
```

判定方式：

- `gen_start_record` 写入时，同步把 `generationRunState` 设为 `open`，记录 course/genseq/phase。
- streaming/tool round/finishing 每个阶段推进时，只更新当前 genseq 的 phase；若 genseq 不匹配，按 loud error policy 失败。
- `gen_finish_record` 写入时，同步把同一 genseq 的 `generationRunState` 设为 `closed`，记录 finish id 和最后 tool round 分类。
- `func_result_record`、`tellask_callee_record`、`reminders_reconciled_record` 等后续事件不能改变 closed/open 判定；若需要影响下一步动作，必须写独立 next-step trigger 元信息。
- 如果 latest 中缺失 `generationRunState`、genseq 回退、重复 open、finish 与 active genseq 不一致，按 loud error policy 记录结构化错误并停止该 dialog 的 unsafe recovery，而不是静默 fallback 到 proceeding 或回扫历史补猜。

注意：`DialogLatestFile` 当前没有保存 active genseq 是需要偿还的技术债。迁移脚本可以从 durable event stream 一次性补齐 `generationRunState`；目标运行路径不能每次重启都扫描历史来推导 latest generation closure。

#### 5.2 closed / missing generation state 不进入 proceeding recovery

`generating=true` 是投影，不是恢复事实。当前代码已把 open-generation recovery 的判定收敛到 `getRecoverableGenerationRunState(latest)`：只有 `generationRunState.kind === 'open'` 且 interruption marker 允许自动恢复时，才写入 `open_generation_recovery` trigger 并进入 proceeding recovery。

目标态仍可把该 helper 扩展为带诊断返回值的 decision helper：

```ts
async function resolveRecoverableGenerationAfterRestart(
  dialogId,
  latest,
): Promise<RestartGenerationRecoveryDecision>;
```

规则：

- `generationRunState.kind === 'open'`：recover proceeding。
- `generationRunState.kind === 'closed'`：不 recover proceeding；清 stale generating，并按状态快照投影 displayState。
- `generationRunState` 缺失：不 recover proceeding；清 stale generating，并按 server restart / user wait / explicit interruption 等状态快照投影 displayState；不扫描历史补猜。
- latest.generating 与 `generationRunState` 冲突：发 loud diagnostic，停止该 dialog 的 unsafe recovery；迁移/repair 工具可以离线修复，runtime 不回扫补猜。

返回结构携带诊断字段，便于日志与测试断言：

```ts
type RestartGenerationRecoveryDecision =
  | {
      kind: 'recover_open_generation';
      course: number;
      genseq: number;
      reason: 'generation_state_open';
    }
  | {
      kind: 'clear_stale_generating';
      course: number;
      genseq: number;
      reason: 'generation_state_closed';
    }
  | {
      kind: 'no_generation_recovery';
      reason: 'not_generating' | 'dead_marker' | 'interrupted_non_recoverable';
    };
```

结构化日志字段至少包含 `rootId`、`selfId`、`course`、`genseq`、`latestGenerating`、`latestNeedsDrive`、`decision.kind`、`decision.reason`。

#### 5.3 closed background tellask boundary 的恢复投影

若最后 closed generation 的 tool calls 全部是 pending background tellask dispatch ack：

- 清 `generating=false`。
- 清不必要 `needsDrive=false`，除非存在 queued prompt、pending course start 转换出的 `queued_prompt` trigger、或 reply recovery trigger。
- displayState 对普通 idle dialog 为 `idle_waiting_user`；若同一 dialog 仍有 active reply obligation，则按 callee completion obligation 投影。
- pending tellask reminder 保留并在下一次 reminder reconcile 中显示。

#### 5.4 pending replyTellask\* 恢复仍优先

第一阶段时 `recoverPendingReplyTellaskCallsAfterRestart()` 通过扫描历史 call-without-result 推导未交付 reply；第二阶段已改为读取 `latest.replyDelivery`。目标态继续要求 reply delivery 元信息记录完整 `deliveryStatus`，重启后直接读取状态快照恢复未完成交付。

要求：

- reply recovery 可以完成交付并触发等待方处理新事实。
- 但普通 pending `tellask` dispatch 不应走 reply recovery。
- `replyTellaskBack` recovery 必须按 reply delivery 元信息中的 target dialog/callId 写回 canonical `tellaskBack` result；不能假设 target 一定是支线对话，也不能假设主线只会作为最终接收者。
- 启动顺序中，closed-generation reconciliation 应先清掉 stale generating，再做 reply recovery，避免 backend loop 抢先误续推。

启动顺序调整为：

1. load/quarantine persistence
2. project closed/stale generation flags from state snapshot
3. recover pending replyTellask\* deliveries from reply delivery state
4. recover genuinely open generations from generationRunState
5. start backend driver

当前实现已把 reply recovery 调整到 proceeding/open-generation recovery 之前；closed/stale generation projection 仍需继续收敛为更明确的 decision helper。

#### 5.5 restart 后 `needsDrive` 的收敛规则

closed-generation projection 清掉 stale `generating` 后，要同步处理 `needsDrive`：

- 如果存在 `pendingCourseStartPrompt`：转成 `queued_prompt` trigger；display 为对应 stopped/resumable 状态。
- 如果存在 pending reply delivery：由 `recoverPendingReplyTellaskCallsAfterRestart()` 负责产生/保留 `reply_delivery_recovery` trigger。
- 如果只是 pending tellask / pending sideDialogs：设置 `needsDrive=false`，display 投影为 `idle_waiting_user`，pending tellask 通过 reminder/panel 表达。
- 如果状态快照缺少必要元信息：发 loud diagnostic，不要把 `needsDrive=true` 当兜底保活，也不要回扫历史补猜。

### 6. result-arrival handling 语义

回贴完成后，等待该结果的 dialog 应处理新事实，这是另一条正当自动继续路径。常见情况是 callee 回贴后让 caller 处理结果；`tellaskBack` 中也可能是主线或其它上游 dialog 等待 ask-back result。

当前 `supplyResponseToAskerDialog()`：

- 移除 pending record。
- 若同 dispatch batch 已无 pending 且无 Q4H，则写入 `result_arrival` trigger，并由 backend/直接调度路径启动等待方处理新事实。
- schedule 等待方 drive，带当前实现所需的 `noPromptSideDialogResumeEntitlement`。

保留原则：

- 回贴完成后的自动继续是“后台结果到达后的新事实处理”，不是 pending tellask 自身要求等待。
- result-arrival handling 的粒度是 dispatch batch：整组 dispatch 的 callee 全部完成后通知 caller 处理；单个 tellask 是 dispatch batch size = 1。
- 多路同组 reply 中间态不得触发 caller LLM generation，但要更新 observability、pending reminder 和对应 call bubble。
- 自动继续 prompt/drive 应明确携带“有新回贴事实可处理”的原因。
- 若等待方正在 Q4H / askHuman user wait 中，batch complete 仍写入 `result_arrival` trigger，但 driver 停在 user wait；用户回答清除 user wait 后再消费该 trigger。
- 当前实现里的 revive entitlement 应携带 `dispatchBatchId` / batch completion facts，并对应生成 `result_arrival` trigger，避免恢复时再次用“全局 pending sideDialogs 是否为空”猜测。
- 若等待方 dialog 已经 idle，收到回贴可以自动 drive 处理结果；这不违反 background_continue。

## 模块级改造清单

### `main/dialog.ts`

- 将 `canDrive()` 收敛为“当前是否有先决事实要求先停在边界”，例如 Q4H 等待用户回答；pending course start 转为 `queued_prompt` trigger，不再作为先决等待事实。
- 新增/拆出 completion obligation 查询，用于读取 active reply obligation；不要让它参与“是否可以开始下一步”的判定。
- `getSuspensionStatus()` 若保留，应只暴露 `backgroundCalleeDialogs` 这类观测字段，避免 `sideDialogs` 与 `blockingSideDialogs` 被调用方误解为同一件事。
- `hasPendingSideDialogs()` 保留为 background observability helper，不参与是否继续驱动的判断。
- 避免新增主线专属 next-step 判定；主线/支线差异只应由编排、差遣牒权限、归档生命周期层表达。

### `main/dialog-display-state.ts`

- 移除/改名 `blockerDisplayState()` 这类以 blocker 命名的投影；pending sideDialogs 不再映射为 `waiting_for_sideDialogs`。
- `computeIdleDisplayStateFromPersistence()` 对任意 dialog 使用 next-step facts、background facts、completion obligations 分层投影。
- `getRecoverableGenerationRunState()` 已只读取 `generationRunState.kind === 'open'`；后续可扩展为结构化 recovery decision。调用方不能只凭 `generating=true` 判断 open generation，也不能回扫历史补猜。
- restart reconciliation 在 patch latest 时同时处理 `generating`、`needsDrive`、`displayState`、`executionMarker`，避免留下 stale queued 状态。

### `main/llm/kernel-driver/drive.ts`

- 工具轮后不再用 pending sideDialogs 作为停止当前 drive 的原因。
- `shouldStartImmediatePostToolGeneration` 排除 pending tellask dispatch ack，只接纳普通 tool outputs、resolved tellask outputs、invalid call recovery 等真正需要模型消化的结果。
- `maybeContinueWithDiligencePrompt()` 只对主线生效；前置判断只看需要先处理的业务事实；pending tellask 作为主线 Diligence context 传入 prompt formatter。
- callee direct-fallback 不走 Diligence prompt，改为形成 caller 可判断的 result/direct-fallback fact。

### `main/llm/kernel-driver/loop.ts`

- `resumeInProgressGeneration` 必须来自 restart/open-generation decision 或 active run state，而不是直接等价于 `latest.generating === true`。
- backend loop drive 前后更新 `needsDrive` 时，不得因 pending tellask 保持 queued；调度 runnable drive 时必须同时检查 `userWait.kind === 'none'`。

### `main/recovery/proceeding-drive.ts`

- 只恢复 `generationRunState.kind === 'open'` 且 recovery decision 为 `recover_open_generation` 的 dialog。
- 主线/支线 dialog recovery 均记录 `course/genseq/reason`。
- 不再在 proceeding recovery 中抢在 reply recovery 前误驱动 closed generation。

### `main/recovery/reply-special.ts`

- 旧实现扫描 `replyTellask*` call-without-result；目标态改为读取 reply delivery 元信息，扫描只允许作为迁移/repair 工具。
- 明确排除普通 `tellask` pending dispatch；它不是 reply delivery recovery。
- 成功交付后仍可触发等待方 dialog 处理新事实，这是 result arrival trigger；`replyTellaskBack` 的等待方不一定是支线对话。

### `main/llm/kernel-driver/tellask-special.ts`

- pending dispatch ack 的结果内容可保留，但需要在内部分类为 `background_dispatch_ack`。
- resolved reply result 与 pending ack 在 routing metadata 中分开，供 `drive.ts` 判断 immediate followup。
- `tellaskBack` / `replyTellaskBack` 的 directive 必须显式保留 caller、callee、result owner 三类角色字段，避免用主线/支线形态推断业务角色。
- `tellask` dispatch 时写入 durable dispatch batch identity；reply delivery 时按 batch 判断是否全部完成，只有 batch complete 才触发 result-arrival handling。

### `main/persistence.ts`

- `PendingSideDialogStateRecord` 需要增加或规范化 dispatch batch identity。
- `removePendingSideDialog()` / pending-sideDialogs reconciliation 需要返回 batch completion outcome，而不是只返回全局 pending 列表。
- crash recovery 需要能从当前状态快照 + pending-sideDialogs 读取每个 dispatch batch 的 pending/resolved 状态；从 durable events 重建只允许出现在一次性迁移/repair 工具中。

### `main/dialog-fork.ts`

- fork 时继续复制 pending sideDialogs 作为 background facts。
- fork 目标 display/run-control 不再因为 copied pending sideDialogs 进入等待被诉请者状态。

### WebUI / run-control

- 暂停/可恢复 counts 不计入 pending tellask。
- pending tellask 展示继续走 reminder / side dialog panel / call bubble。
- 主线归档、导航、差遣牒维护入口保留特殊 UI；这些 UI 差异不能反向改变 drive/revive/下一步动作规则。

## 测试计划

### 单元 / kernel-driver 测试

1. caller dialog 单个 `tellask` 后不 immediate post-tool continue。
   - 输入：LLM 输出一个 valid `tellask`。
   - 期望：有 pending record，有 pending func result，无下一轮 gen_start。
   - 期望：不产生 `result_arrival` trigger；`needsDrive` 不因 pending tellask dispatch ack 变 true。
   - 期望：诉请者 displayState 不为 `waiting_for_sideDialogs`。

2. 同轮 `tellask` + 普通 immediate tool result。
   - 期望：普通工具结果仍可触发 immediate followup。
   - pending tellask 不影响该 followup。

3. callee 有 active reply obligation 但继续使用工具/下游 `tellask`。
   - 期望：active reply obligation 不参与“是否可以开始下一步”的判定；完成判定仍要求最终 reply/direct-fallback 收口。

4. pending tellask + Diligence Push enabled。
   - 期望：进入 idle 边界后 Diligence 可按预算注入 prompt。
   - 期望：状态快照产生 `mainline_diligence` trigger，trigger 携带 pending tellask context。
   - prompt 包含 pending tellask 上下文。

5. pending tellask + Diligence Push disabled。
   - 期望：不自动继续，不产生 next-step trigger，只保留 observability。

6. 支线对话 `replyTellask` 成功。
   - 期望：仍 stop current round，并 supply caller。

7. 回贴完成 result-arrival handling。
   - 期望：dispatch batch complete 后，等待方收到 `tellask_result_record` 并自动 drive 处理结果。

8. 多路同组 `tellask` 部分回贴。
   - 输入：同一 generation 发出 3 路 tellask，先收到其中 1 路回贴。
   - 期望：写入该 call 的 result，pending reminder/call bubble 更新，但不触发 caller 处理，不新增 caller gen_start。

9. 多路同组 `tellask` 全部回贴。
   - 输入：同一 dispatch batch 的最后一路 callee 回贴。
   - 期望：batch completion facts 写入，caller 的 `NextStepTriggerState` 出现 `result_arrival` trigger；单路 tellask 走同一逻辑且 dispatch batch size = 1。

10. 同一 caller 同一 course 中存在不同 dispatch batch。
    - 期望：A 组完成只触发 A 组对应事实处理，不把 B 组 pending 错当成暂停原因，也不等 B 组完成才处理 A 组结果。

11. result-arrival trigger 消费幂等。
    - 输入：等待方消费一个 `result_arrival` trigger 并完成 generation。
    - 期望：该 trigger 从状态快照删除；崩溃重启后不重复处理同一 dispatch batch。

12. result-arrival 到达时等待方正在 Q4H。
    - 输入：dispatch batch complete，同时等待方 `userWait.kind='awaiting_user_answer'`。
    - 期望：写入 `result_arrival` trigger 和 batch completion facts，但不新增 gen_start；用户回答清除 user wait 后再消费该 trigger。

13. 主线被 `tellaskBack` 时作为 callee。
    - 输入：上游 ask-back directive 指向主线对话。
    - 期望：主线按 active reply obligation 使用 `replyTellaskBack` 收口；该场景不依赖支线式 Diligence recovery。

14. 支线作为 callee 同时作为 caller 发起下游 `tellask`。
    - 期望：active reply obligation 仍保留；下游 pending tellask 是 background work，不让该支线停止推进；若出现非本意直接回复停止驱动，direct-fallback 交给 caller 判断。

15. `replyTellaskBack` 写回等待方。
    - 期望：按 directive 的 target dialog/callId 写入 canonical `tellaskBack` result，并触发等待方处理新事实；不按主线/支线形态猜测 target。

16. Q4H 等待用户回答。
    - 期望：状态快照写入 `DialogUserWaitState.kind='awaiting_user_answer'`，Q4H 仍表示等待用户回答，并且不触发 Diligence。
    - 期望：不产生 `mainline_diligence` trigger，也不把 pending tellask 混入等待原因。

17. 状态事件与状态快照更新的原子性。
    - 输入：模拟 event 写入成功但状态快照元信息未更新的异常路径。
    - 期望：runtime 发 loud diagnostic，停止该 dialog 的 unsafe drive；不回扫历史补猜。

### 重启恢复测试

1. closed single pending tellask generation + stale `generating=true`。
   - 构造：状态快照有 `generationRunState.kind=closed`、lastToolRoundKind=`background_dispatch_only`、pending dispatch batch，latest 仍 `generating=true/needsDrive=true`。
   - 期望：restart reconciliation 清 stale generating，不 recover proceeding，不新增 gen_start。

2. open streaming generation crash。
   - 构造：状态快照有 `generationRunState.kind=open`、phase=`streaming`。
   - 期望：recover proceeding，并使用 `resumeInProgressGeneration=true`。

3. pending replyTellask\* crash。
   - 构造：reply delivery 元信息为 pending，包含 expected reply tool、target dialog/callId。
   - 期望：reply recovery 完成交付，result-arrival handling 正常。

4. pending replyTellaskBack crash。
   - 构造：reply delivery 元信息为 pending，target dialog 可以是主线对话。
   - 期望：reply recovery 按 directive 写回 `tellaskBack` result，触发等待方处理新事实，不误判为 ordinary pending tellask。

5. closed pending tellask + pending background records。
   - 期望：displayState 为 `idle_waiting_user`，pendingTellask reminder 保留；若仍有 active reply obligation，则按 callee completion obligation 投影。

6. partial dispatch batch replies before crash。
   - 构造：dispatch batch 元信息里部分 call resolved，仍有 pending call。
   - 期望：重启后不触发 caller 处理，只恢复 batch pending/observability。

7. complete dispatch batch reply delivery before crash。
   - 构造：dispatch batch 元信息显示全部 resolved 且 result-arrival trigger 未消费，latest stale。
   - 期望：重启后可恢复/保留一次 result-arrival trigger，且不因其它 dispatch batch pending 而等待。

8. closed generation with normal immediate tool result but stale latest。
   - 构造：状态快照有 `generationRunState.kind=closed`、lastToolRoundKind=`ordinary_tool_result`，latest stale。
   - 期望：不重复 replay tool round。

9. stale sideDialog after final response anchor。
   - 期望：最终回复锚点之后的 dead/final sideDialog 不进入 restart recovery，也不生成 drive trigger。

10. missing state metadata after restart。
    - 构造：latest.generationRunState 缺失，但历史 course events 可被扫描补猜。
    - 期望：runtime 发 loud diagnostic 并停止该 dialog 的 unsafe recovery；只有离线 migration/repair 命令允许回扫补齐。

11. awaiting user answer after restart。
    - 构造：状态快照有 `DialogUserWaitState.kind='awaiting_user_answer'`，同时存在 pending tellask background work。
    - 期望：重启后仍显示等待用户回答，不产生 `mainline_diligence` / `result_arrival` / `open_generation_recovery` trigger，也不回扫历史补猜等待原因。

12. complete dispatch batch + awaiting user answer after restart。
    - 构造：状态快照已有未消费 `result_arrival` trigger，同时 `DialogUserWaitState.kind='awaiting_user_answer'`。
    - 期望：重启后保留 `result_arrival` trigger，但不启动 gen_start；用户回答清除 user wait 后再消费该 trigger。

### 回归测试关注点

- `interruption-resumption.ts` 中依赖 `waiting_for_sideDialogs` 的断言需要按新语义拆分 caller background work / callee completion obligation。
- `sideDialog-mixed-tool-round-honors-suspension` 重命名为正向业务语义测试：pending sideDialog 不让 caller dialog 暂停，active reply obligation 仍参与完成/恢复判定。
- run-control visual / counts 需要更新 pending tellask 不计入暂停/可恢复计数。
- fork snapshot 中 pending sideDialogs 仍要复制为 background facts，但不投影为等待被诉请者状态。

## WIP 状态（阶段性提交标记）

本提交进入第二阶段状态机落地，但仍不是完整终态。WIP 标记保留到下一次完整状态机提交完成后再移除。

第一阶段已落地：

- pending tellask / pending sideDialog 不再作为 caller 的暂停条件；`getSuspensionStatus()` 只把 Q4H 视为 `canDrive=false` 的用户等待事实。
- pending tellask 不再投影为 `waiting_for_sideDialogs`；UI 以后台被诉请者数量 / FBR 被诉请者数量表达可观测状态。
- post-tool continuation 排除纯后台 dispatch ack；普通工具结果、invalid tool call、queued prompt、reply recovery 仍按各自语义续推。
- Diligence Push 收敛为主线编排保活机制；支线不再有 sideDialog diligence recovery prompt。
- pending runtime prompt、latest assignment anchor、sideDialog final response 等状态字段已补入，用于减少部分恢复/尾部判定的历史回扫。
- 文档、提示词、UI 文案把运行时关系统一为 caller/callee、诉请者/被诉请者；主线/支线只保留在归档、导航、差遣牒责任、存储生命周期语境。

第二阶段已落地：

- `generationRunState` 已写入 `latest.yaml`：generation start 标记 `open`，generation finish 标记 `closed`；restart open-generation recovery 开始写入 `open_generation_recovery` trigger。
- `NextStepTriggerState` 已开始落地：`queued_prompt`、`backend_queue`、`result_arrival`、`open_generation_recovery`、`reply_delivery_recovery` 已有 durable trigger 形态；`needsDrive` 正在收敛为 trigger projection。
- durable `dispatchBatchId` 已写入 pending sideDialog record；callee 回贴后按同一派发批次是否全部完成生成 `result_arrival` trigger。
- `replyDelivery` 已落地：有效的 `replyTellask*` 工具调用会记录 pending delivery 的 reply callId、genseq、content、target dialog/callId；成功交付后标记 delivered，工具结果回写后标记 `toolResultStatus=recorded` 并移除 recovery trigger。
- `reply-special` restart recovery 已改为读取 `latest.replyDelivery`，不再扫描当前 course events 查找 call-without-result。

仍属 WIP，不能视为本重构完成：

- `needsDrive` 仍保留 boolean / registry 双投影；`setNeedsDrive()` 已降级为 `backend_queue` trigger bridge，但 registry 与 trigger 消费还没有完全统一。
- `DialogUserWaitState` 已落地；Q4H append/remove/clear 会同步 `latest.userWait`，driver/display 的常态等待判断开始读取状态快照。Q4H 详细问题载荷仍由 `q4h.yaml` 承载。
- dispatch batch 仍主要通过 pending sideDialog records 表达，没有独立 dispatch-batch state 文件；crash recovery 尚未完整覆盖 batch member resolved/final 状态。
- `generationRunState` 目前只记录 open/closed 的 course/genseq/timestamp，尚未记录 phase、lastToolRoundKind、finishRecordId。
- restart 顺序已调整为 reply recovery 先于 proceeding/open-generation recovery；open-generation recovery 已不再从 `generating=true` 兜底，但 generation recovery decision 仍需补齐结构化诊断返回。
- `revive entitlement` / `wait_group_resolved` 等内部命名仍是迁移遗留，后续应收敛到 result-arrival / dispatch-batch 语义。
- runtime 读路径仍存在少量历史事件读取；下一阶段必须把常态业务判定改为只读状态快照和显式 pending records，历史回扫只留给离线 migration/repair。

移除 WIP 标记的条件：

1. `needsDrive=true` 仅作为 `NextStepTriggerState.triggers.length > 0` 的投影存在。
2. tellask 派发、callee 回贴、caller result-arrival 全部以 durable `dispatchBatchId` 串联。
3. restart recovery 只依据 `generationRunState` 判断 open/closed generation，不再用 closed generation 触发 proceeding recovery。
4. reply recovery 只读取 reply delivery 元信息，不再扫描 course JSONL 补猜。
5. 缺少必要状态机元信息时 loud fail，并只允许离线 migration/repair 回扫补齐。

## 迁移步骤

1. 新增 generationRunState、DialogUserWaitState、NextStepTriggerState、dispatch batch、reply delivery status 等状态机元信息，并在每次状态转移时同步维护。
2. 加一次性 migration/repair，把历史数据补齐到新状态快照；runtime 读路径不调用该回扫逻辑。
3. 新增 fact helpers：user wait、next-step facts、completion obligations、background pending work，全部读取状态快照。
4. 调整 dialog `getSuspensionStatus()` 或新增 next-step facts API，先让 drive 使用新 API；API 必须按角色区分 caller background work 与 callee completion obligation。
5. 调整 display projection，移除 pending tellask -> `waiting_for_sideDialogs`，覆盖 caller/callee 角色组合。
6. 调整 post-tool continuation，把 pending tellask ack 从 immediate followup 中排除并加测试。
7. 新增/规范化 tellask dispatch batch identity，保证多路同组回复齐后才触发 result-arrival handling。
8. 调整 Diligence Push，显式读取状态快照里的 pending tellask context 并改文案。
9. 调整 restart recovery，仅读取状态快照判断 open/closed generation；历史回扫只放进一次性 migration/repair。
10. 调整 proceeding recovery，只恢复真正 open generation。
11. 调整 backend loop，避免 `resumeInProgressGeneration` 绕过已 closed background boundary。
12. 更新 tests / docs / UI run-control copy。

## 风险与判定

### 风险

- 一些旧测试把 pending sideDialog 当暂停原因；重构后需要明确它们测试的是“后台进行中”还是“等待用户/等待 runtime prompt”。
- 主线 Diligence Push 文案如果过强，可能又把 pending tellask 表达成必须继续。
- restart recovery 如果过保守，可能导致真实 open generation 崩溃后不恢复。
- result-arrival handling 如果过弱，可能导致回贴到了但等待方 dialog 不处理。
- dispatch batch identity 如果不 durable，崩溃恢复后可能出现部分回贴误触发、整组回贴不触发，或不同批次互相等待。
- 历史主线/支线形态特判如果保留过多，会把归档/编排差异误扩散成控制流差异，导致支线推进或 tellaskBack 场景继续出例外。
- 状态机元信息如果没有随转移同步维护，开发者可能重新引入历史回扫补猜；这必须作为架构回归处理。

### 判定原则

- pending tellask 存在时，caller dialog 可被驱动，但不是因为 pending tellask 必须驱动。
- pending tellask 存在时，caller dialog 可 idle，但 idle 不代表后台完成。
- active reply obligation 存在时，当前 dialog 是 callee；它需要最终通过对应 reply path 收口，但它自己的下游 pending tellask 不决定它是否继续推进。
- caller 处理 callee 回复时，触发粒度是 dispatch batch complete；单个 `tellask` 是 size = 1 的特例。
- 只有不存在 `awaiting_user_answer` 等先决等待事实，且存在未消费 `NextStepTriggerState` trigger 或当前工具轮产生 immediate tool result，才能启动新一轮。
- 已有 `gen_finish_record` 的 generation 不应被 proceeding recovery 重放。
- runtime 运行路径不得通过回扫聊天记录、course JSONL 或历史 tool calls 补猜当前状态；缺少必要元信息时应 loud fail，离线 migration/repair 另行处理。
- 主线/支线差异只允许来自编排责任、差遣牒读写责任、归档生命周期；其它 run-control 行为应按统一 dialog 规则解释。
