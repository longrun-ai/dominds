# Tellask 后台继续语义与崩溃恢复对齐重构计划

## 背景

本计划记录一次围绕 `tellask` 后台诉请续推行为的语义收敛，并把它扩展到后台进程崩溃/重启后的自动恢复逻辑。

触发案例来自一个真实运行时工作区：

- rtws：某真实运行时工作区（具体路径已脱敏）
- 对话标识：某主线对话（具体 root/self id 已脱敏）
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
- 作为 dispatch batch caller：它在同一次 LLM move 中一次性发出多个 `tellask` 时，负责按这组派发批次的整体结果边界收口。单个 `tellask` 只是 dispatch batch size = 1 的特例。

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
- `entitlement` / `revive`：业务上不是某个 dialog 获得“恢复权”，而是“有新事实到达，caller 应处理”。目标实现以 `result_arrival` trigger 表达这件事；若底层仍临时保留 entitlement token，只能作为防重入/防误续推的内部令牌，并必须携带同一个 `batchId`。
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
- active callee dispatch 元信息：存于 caller 对话目录的 `active-callees.json`；路径已经表达 caller，不在文件内容重复记录自身 dialog id；每个 batch 携带稳定 `batchId`、call site、callee 成员 callIds、每个 call 的 pending/resolved/final 状态、batch 是否 complete。
- reply delivery 元信息：active reply obligation、expected reply tool、target dialog/callId、delivery status、tool-result status。
- background work 元信息：pending tellask 摘要、与 dispatch batch 的关联、用于主线 Diligence 的只读上下文。

next-step trigger 使用显式 union，而不是裸 boolean：

```ts
type NextStepTrigger =
  | (NextStepTriggerBase & { kind: 'user_input'; course: number; genseq: number })
  | (NextStepTriggerBase & { kind: 'queued_prompt'; promptId: string; course: number })
  | (NextStepTriggerBase & { kind: 'backend_queue'; reason: string; course: number })
  | ({
      kind: 'followup';
      sourceGeneration: { course: number; genseq: number };
      reasons: FollowupReason[];
    } & NextStepTriggerBase)
  | ({
      kind: 'mainline_diligence';
      diligenceId: string;
      pendingTellaskCount: number;
    } & NextStepTriggerBase)
  | (NextStepTriggerBase & { kind: 'result_arrival'; batchId: string })
  | (NextStepTriggerBase & { kind: 'open_generation_recovery'; course: number; genseq: number })
  | ({
      kind: 'reply_delivery_recovery';
      replyDeliveryId: string;
      targetDialogId: string;
    } & NextStepTriggerBase);

type NextStepTriggerBase = {
  triggerId: string;
  createdAt: string;
  seq: number;
};

type NextStepTriggerState = {
  nextSeq: number;
  triggers: NextStepTrigger[];
};

type FollowupReason =
  | { kind: 'ordinary_tool_result'; callIds: string[] }
  | { kind: 'invalid_tool_recovery'; callIds: string[] }
  | { kind: 'reply_delivery_result'; replyDeliveryId: string; replyCallId: string }
  | { kind: 'result_arrival'; batchId: string }
  | { kind: 'runtime_guidance'; msgId: string };
```

`needsDrive=true` 只是 `triggers.length > 0` 的投影，表示“有未消费的新事实”，不等价于“此刻允许启动 drive”。backend loop / run-control 必须同时读取 user wait 等先决等待事实；只有先决等待为空时，未消费 trigger 才能进入 runnable drive。

`nextStep.triggers` 是一次性铃声，不是业务事实账本：

- trigger 默认只携带稳定引用，不复制大型业务账本；真实账本在对应状态文件中，例如 `active-callees.json`、`replyDelivery`、`pendingRuntimePrompt`、`generationRunState`。
- `followup` 是例外但仍属于 trigger 层：它表达“这轮已产生必须立刻交给 LLM 继续处理的结果集合”，原因集合本身就是一次性驱动事实，不另开 `followup.json`。这样避免用文件存在/不存在表达业务语义，也减少一次额外文件访问。
- 消费点是对应业务事实已成功注入或处理，而不是 drive start。若启动 drive 后崩溃但事实尚未处理，trigger 仍应保留以便重启后重试。
- `followup` 的消费点是下一轮 generation 已成功完成 durable handoff：`gen_start_record` 写入、`generationRunState.kind='open'` 写入，且 open state 记录 `acceptedTriggerIds`。之后若新一轮 generation 中途崩溃，由 `generationRunState.open` + `open_generation_recovery` 恢复同一轮，不再保留 `followup` 等到 `gen_finish`。否则 `followup` 会同时表达“需要启动下一轮”和“下一轮尚未结束”，与 open-generation recovery 重叠。
- 一轮 generation 可以合并消费多个 runnable triggers。只要这些 triggers 的正式内容已经进入该轮 LLM context，并完成同一个 durable handoff，就可以把它们一起记录到 `acceptedTriggerIds` 并一起消费；这对用户插话、多个 batch 近同时回贴、queued prompt 与 result-arrival 并存等业务场景是必要能力。
- 合并进入 LLM context 的 triggers 按持久化到达顺序排列：先按 `seq`，再按 `createdAt`，最后按 `triggerId` 稳定打平。`seq` 是 dialog-local 单调序号，由 `NextStepTriggerState.nextSeq` 分配，不依赖数组当前顺序，也不通过扫描现有 trigger 反推；若旧状态没有 `seq/nextSeq`，该 dialog 进入 `malformed/`。
- recovery 派生 trigger 的到达顺序锚点来自它的 durable source，而不是重启时刻：`open_generation_recovery` 使用 `generationRunState.open.openedAt`，`reply_delivery_recovery` 使用 `replyDelivery.createdAt` 或对应 pending delivery 的创建时间。
- `open_generation_recovery` 和 `reply_delivery_recovery` 不强制独占一轮。若恢复动作与其它 runnable triggers 一起进入同一轮 LLM context，可以把 recovery trigger 隐形合并消费；业务语义是“上次未完成/未交付的事实和新到事实被同一轮处理”，不要求为 recovery 单独生成一轮。
- recovery trigger 是从 durable recovery source 派生的服务铃声：`open_generation_recovery` 来自 `generationRunState.open`，`reply_delivery_recovery` 来自 `replyDelivery`。即使它的 trigger id 已记录在 `acceptedTriggerIds`，只要 durable recovery source 仍表示未完成，重启后仍可重新生成 recovery trigger；`acceptedTriggerIds` 不能被用来压制必要恢复。
- 消费后直接从 `triggers` 删除；不保留 consumed tombstone。审计、排查和历史追溯使用 event log 与业务状态，不让运行态文件累积历史触发记录。
- 幂等防重由业务状态或 trigger identity 承担：例如 `active-callees.json` batch 消费后删除、`replyDelivery.status/toolResultStatus` 防重复交付、`pendingRuntimePrompt.msgId` 防重复 prompt、`generationRunState` 防 closed generation 再恢复；`followup` 使用 source generation 生成稳定 `triggerId`，同一 generation 的多次原因更新应合并到同一 trigger。

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

`userWait.kind === 'awaiting_user_answer'` 是先决等待事实，不是 trigger。等待用户期间到达的 `result_arrival` 等新事实仍要写入 `NextStepTriggerState`，但 backend driver 不能越过 user wait 自动启动；用户回答到达时，清除 user wait，并把用户回答作为 `user_input` trigger 写入同一个 next-step state。随后按未消费 triggers 的持久到达顺序合并进入下一轮；这里没有额外权衡。

若运行态元信息缺失或结构不合法，不在 runtime 回扫历史补猜；该 dialog 直接转移到 `malformed/`，记录 warning / structured diagnostic，之后不做第二次自动处理。历史对话在 Dominds 中是低价值资产；真正需要恢复时，由人类手工分析 `malformed/` 下记录并修正后续跑。

这条规则可以作为后续重构的命名约束：若一个新概念不能回答“哪个业务事实到了、下一步应做什么”，就不要把它放进目标设计；最多把它留在模块级迁移说明里。

### 规约句

`active-callees` is an observability fact and, for mainline dialogs only, a Diligence Push input. It must not decide whether the caller dialog can keep working.

中文表达：

> pending tellask 只是后台进行中事实；它只参与 observability、主线 Diligence Push 是否保活、以及回贴到达后的 result-arrival handling，不决定 caller dialog 是否继续工作。

## 当前实现事实

### 为什么大部分场景看起来符合原则

当前实现中，普通单个 `tellask` 后多数情况下会停住，但原因不是最终原则，而是旧“pending sideDialog 等同诉请者等待被诉请者”的投影机制。

路径：

1. `tellask-special.ts` 创建/更新 Side Dialog，并把后台 callee dispatch 写入 `active-callees.json`。
2. 如果没有立即获得回贴，`processTellaskFunctionRound` 会为 callId 生成 background `func_result_msg`。
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

4. `Dialog.getSuspensionStatus()` 当前把后台 callee dispatch 当成不能继续驱动的原因：

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
- 如果同一 generation 里同时有多组不同语义的 dispatch，需要 durable batch identity 区分；不能只靠“当前是否有 active callee”粗判。

目标态不再沿用 `pending-sideDialogs.json` 作为运行判定源，也不改名续命为 `pending-calleeDialogs.json`。caller 对话目录下使用 `active-callees.json` 承载还未被消费的 callee 派发批次：

```ts
type ActiveCalleesFile = {
  batches: ActiveCalleeBatch[];
};

type ActiveCalleeBatch = {
  batchId: string;
  callSite: { course: number; genseq: number };
  status: 'open' | 'resolved';
  callees: Array<{
    callId: string;
    calleeDialogId: string;
    callName: 'tellask' | 'tellaskSessionless' | 'tellaskBack' | 'freshBootsReasoning';
    status: 'pending' | 'resolved' | 'final';
    targetAgentId: string;
    tellaskContent: string;
    callType: 'A' | 'B' | 'C';
    mentionList?: string[];
    sessionSlug?: string;
    completion?: ActiveCalleeCompletion;
    createdAt: string;
    resolvedAt?: string;
  }>;
  createdAt: string;
  resolvedAt?: string;
};

type ActiveCalleeCompletion =
  | { kind: 'reply_tool'; resultRecordId: string }
  | { kind: 'direct_fallback'; memo: string; resultRecordId: string };
```

原则：

- 文件所在目录已经表达 caller，不在文件内容重复记录自身 `callerDialogId`。这也让 fork dialog 时少一类路径与内容不一致的问题。
- `batchId` 必须保留，用于 result-arrival trigger、日志、崩溃恢复、去重和并发写入稳定引用；不使用数组下标或 `{ course, genseq }` 作为隐式 identity。
- 同一 caller 可以同时存在多个 active batch。最重要的业务场景是用户插话：前一批 callee 还在后台运行时，用户可能继续补充要求，caller 因用户输入再次推进并派发新的 callee batch。
- 每个 batch 独立 open/resolved/consumed；某个 batch complete 只生成该 batch 的 `result_arrival` trigger，不等待其它 batch，也不被其它 batch pending 投影成“caller 正在等待”。
- caller 启动或恢复一轮时，可以合并消费当前所有 runnable `result_arrival` / `followup` / `queued_prompt` / recovery 等 triggers。前提是这些 trigger 对应的正式内容已经进入同一轮 LLM context，并在 `generationRunState.open.acceptedTriggerIds` 中完成 durable handoff。
- callee 非本意直接回复停止驱动时，不新增 `direct_fallback` trigger；它作为该 callee member 的 `completion.kind='direct_fallback'` 写入 batch facts，最多携带 `memo` 说明来源。batch complete 后仍只生成 `result_arrival` trigger，让 caller 像人类一样综合判断是续推原诉请、发起 `tellaskBack`，还是另开诉请。
- `result_arrival` 被消费后，删除对应 batch；`active-callees.json` 只保存仍需判断的运行态事实，不累积历史诉请记录。
- 不再新增 `waitGroupId` 这类等待语义字段名。

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
- 支线不触发 Diligence Push；支线直接回复或停驱动时，按带 direct-fallback memo 的 result-arrival fact 交回 caller。

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
4. 主线 Diligence Push 只因 budget 允许而保活；pending tellask 只作为 prompt context。支线不触发 Diligence。
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
  activeCallees: ActiveCalleesFile;
};

type ActiveCalleesFile = { batches: ActiveCalleeBatch[] };
```

下一步动作按事实直接判定：

- `userWait.kind === 'awaiting_user_answer'`：等待用户回答；不触发 Diligence，也不把 pending tellask 混进等待原因。
- `nextStep.triggers` 中有 `user_input`：处理已经到达的用户输入；Q4H 仍由独立的等待用户回答状态表达。
- `nextStep.triggers` 中有 `queued_prompt`：消费 runtime prompt / queued prompt。
- `nextStep.triggers` 中有 `mainline_diligence`：注入主线 Diligence prompt。
- `nextStep.triggers` 中有 `result_arrival`：让等待方处理 dispatch batch 回贴结果。
- `nextStep.triggers` 中有 `open_generation_recovery`：继续未闭合 generation；若同时存在其它 runnable triggers，可以合并进入同一轮上下文。
- `nextStep.triggers` 中有 `reply_delivery_recovery`：完成未交付 reply；若交付事实和其它 runnable triggers 都已正式进入同一轮上下文，可以合并处理。
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
- `routed.hasImmediateFollowupToolCalls`：只由普通工具、invalid call、真正需要模型消化的结果决定；目标态写入 `followup` trigger 表达该轮需要立即继续。
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

主线 Diligence Push 是很薄的保活功能，目标只是确保智能体对话只停在合法边界：确实需要人类输入时应调用 askHuman / Q4H 等等待答案，而不是像普通聊天应用那样自然停下。它只作用于主线，只看 budget 是否允许；pending tellask 可作为 prompt context，但不参与“是否应该鞭策”的判定。支线不触发 Diligence Push。

新增 Diligence context：

```ts
type MainlineDiligenceContext = {
  budget: { remainingPushes: number };
  pendingTellaskCount: number;
  pendingTellaskSummaries: string[];
};
```

prompt 文案原则：

- pending tellask 存在时，不催促“必须继续本地工作”。
- Diligence Push 不分析 local runnable work、不看 pending tellask 数量来决定是否触发；触发条件只来自 budget。
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
      closedAt: string;
    }
  | {
      kind: 'open';
      course: number;
      genseq: number;
      phase: 'streaming' | 'tool_round' | 'finishing';
      acceptedTriggerIds: string[];
      openedAt: string;
    };
```

判定方式：

- `gen_start_record` 写入时，同步把 `generationRunState` 设为 `open`，记录 course/genseq/phase/acceptedTriggerIds；若本轮由 trigger 触发，完成该 durable handoff 后消费对应 triggers。
- recovery 同一 open generation 时，不新增 `gen_start_record`；若本次恢复同时接纳了新的 runnable triggers，则在它们的正式内容进入恢复上下文后，把 trigger ids 追加/合并到 `generationRunState.open.acceptedTriggerIds`，再消费对应 triggers。
- streaming/tool round/finishing 每个阶段推进时，只更新当前 genseq 的 phase；若 genseq 不匹配，按 loud error policy 失败。
- `gen_finish_record` 写入时，同步把同一 genseq 的 `generationRunState` 设为 `closed`，记录关闭时间；`finishRecordId` 不进入 runtime snapshot，它只属于 event log 审计信息。
- `func_result_record`、`tellask_callee_record`、`reminders_reconciled_record` 等后续事件不能改变 closed/open 判定；若需要影响下一步动作，必须写独立 next-step trigger 元信息。
- 如果 latest 中缺失 `generationRunState`、genseq 回退、重复 open、finish 与 active genseq 不一致，按 loud error policy 转移到 `malformed/`，记录结构化错误并停止该 dialog 的 unsafe recovery，而不是静默 fallback 到 proceeding 或回扫历史补猜。

注意：`DialogLatestFile` 当前没有保存 active genseq 是需要偿还的技术债。目标运行路径不能每次重启都扫描历史来推导 latest generation closure；缺失必要 generation 元信息时进入 `malformed/`。

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
- `generationRunState` 缺失：转移到 `malformed/`，记录 warning / structured diagnostic，不 recover proceeding，也不扫描历史补猜。
- latest.generating 与 `generationRunState` 冲突：转移到 `malformed/`，记录 warning / structured diagnostic，停止该 dialog 的 unsafe recovery；runtime 不回扫补猜，也不尝试第二次自动修复。

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
- 如果状态快照缺少必要元信息：转移到 `malformed/` 并发 warning / structured diagnostic，不要把 `needsDrive=true` 当兜底保活，也不要回扫历史补猜。

### 6. result-arrival handling 语义

回贴完成后，等待该结果的 dialog 应处理新事实，这是另一条正当自动继续路径。常见情况是 callee 回贴后让 caller 处理结果；`tellaskBack` 中也可能是主线或其它上游 dialog 等待 ask-back result。

目标态 `supplyResponseToAskerDialog()`：

- 更新 `active-callees.json` 中对应 batch member 的 resolved/final 状态。
- 若同 batch 已全部完成，则把 batch 标记为 `resolved`，写入 `result_arrival` trigger，并由 backend/直接调度路径启动 caller 处理新事实。
- schedule 等待方 drive，带当前实现所需的 `noPromptSideDialogResumeEntitlement`。

保留原则：

- 回贴完成后的自动继续是“后台结果到达后的新事实处理”，不是 pending tellask 自身要求等待。
- result-arrival handling 的粒度是 dispatch batch：整组 dispatch 的 callee 全部完成后通知 caller 处理；单个 tellask 是 dispatch batch size = 1。
- direct-fallback 不另设下一步动作类型。它只是 batch completion facts 中的一种 result source；`result_arrival` prompt/context 可用 memo 标明“此结果来自 callee direct-fallback”，但运行时不尝试结构化分析该 memo。
- 多路同组 reply 中间态不得触发 caller LLM generation，但要更新 observability、pending reminder 和对应 call bubble。
- 自动继续 prompt/drive 应明确携带“有新回贴事实可处理”的原因。
- 若等待方正在 Q4H / askHuman user wait 中，batch complete 仍写入 `result_arrival` trigger，但 driver 停在 user wait；用户回答清除 user wait 后再消费该 trigger。
- 当前实现里的 revive entitlement 应携带 `batchId` / batch completion facts，并对应生成 `result_arrival` trigger；目标态移除“全局 pending sideDialogs 是否为空”这类猜测。
- 若等待方 dialog 已经 idle，收到回贴可以自动 drive 处理结果；这不违反 background_continue。

## 模块级改造清单

### `main/dialog.ts`

- 将 `canDrive()` 收敛为“当前是否有先决事实要求先停在边界”，例如 Q4H 等待用户回答；pending course start 转为 `queued_prompt` trigger，不再作为先决等待事实。
- 新增/拆出 completion obligation 查询，用于读取 active reply obligation；不要让它参与“是否可以开始下一步”的判定。
- `getSuspensionStatus()` 若保留，应只暴露 `backgroundCalleeDialogs` 这类观测字段，避免 `sideDialogs` 与 `blockingSideDialogs` 被调用方误解为同一件事。
- 后台被诉请者观测统一读取 `active-callees.json` / `loadActiveCalleeDispatches()`；不再保留 `hasPendingSideDialogs()` 这类旧语义 helper。
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
- callee direct-fallback 不走 Diligence prompt，也不形成独立 trigger；它写入对应 active callee completion fact，随后通过 batch `result_arrival` 交给 caller 判断。

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
- resolved reply result 与 pending ack 在 routing metadata 中分开；需要 immediate followup 时写入 `followup` trigger，pending dispatch ack 不写入。
- `tellaskBack` / `replyTellaskBack` 的 directive 必须显式保留 caller、callee、result owner 三类角色字段，避免用主线/支线形态推断业务角色。
- `tellask` dispatch 时写入 `active-callees.json` durable batch identity；reply delivery 时按 batch 判断是否全部完成，只有 batch complete 才触发 result-arrival handling。

### `main/persistence.ts`

- `active-callees.json` 是后台 callee dispatch 的 durable 运行源；`ActiveCalleeDispatchRecord` 只作为从 batch 结构投影出来的局部视图，供 UI/background observability 和回贴匹配使用。
- 旧 `removePendingSideDialog()` / pending-sideDialogs reconciliation 已收敛为 active-callee batch member transition，返回 batch completion outcome。
- crash recovery 从 `active-callees.json` 读取每个 batch 的 pending/resolved/final 状态；从 durable events 重建只允许出现在一次性迁移/repair 工具中。

### `main/dialog-fork.ts`

- fork 时继续复制 active callee dispatches 作为 background facts。
- fork 目标 display/run-control 不再因为 copied active callees 进入等待被诉请者状态。

### WebUI / run-control

- 暂停/可恢复 counts 不计入 pending tellask。
- pending tellask 展示继续走 reminder / side dialog panel / call bubble。
- 主线归档、导航、差遣牒维护入口保留特殊 UI；这些 UI 差异不能反向改变 drive/revive/下一步动作规则。

UI 业务状态投影结论：

1. `userWait.kind === 'awaiting_user_answer'`：沿用现有等待用户/Q4H run badge。这是强等待状态，run-control 不自动越过。
2. `active-callees.json` 存在 open batch：沿用现有后台被诉请者 / 后台 FBR 被诉请者 badge，可展示数量。它不是暂停态，不显示“等待被诉请者”。
3. `nextStep.triggers` 有 runnable trigger 且无 userWait：沿用现有可调度 / proceeding / stopped-resumable 等 run-control 视觉入口，不新增专门的 trigger badge。它可与后台进行中 badge 并存。
4. `active-callees.json` 存在 resolved-but-unconsumed batch / 未消费 `result_arrival` trigger：通常是瞬时状态，不加长期 badge；它通过第 3 类可调度状态体现。
5. `replyDelivery` pending / delivered-but-tool-result-not-recorded：通常是瞬时交付过程，不加长期 badge；必要信息留在 call bubble / 日志 / 当前 dialog 上下文中。
6. `generationRunState.kind === 'open'` 或 recovery trigger 存在：通常是瞬时恢复过程，不加长期 badge；恢复中可沿用 running/proceeding 视觉。
7. 只有 active callee open batch、没有 runnable trigger、没有 userWait：这不是独立状态，而是普通 idle + 第 2 类后台 badge。典型路径是当前 generation 只发出后台 tellask 后闭合；callee 还未回贴，所以没有 `result_arrival`，也没有其它 next-step trigger。主线不应仅因 Diligence Push 预算存在而继续空转；active callee 仍 pending 时，主线自然 idle，等待结果到达或其它具体驱动来源。支线自然 idle。
8. 元信息缺失、冲突或解析失败：移入 `malformed/` 后技术上相当于当前运行视图不存在；UI 从普通列表撤掉，不显示 badge。需要排查时从归档/诊断入口或文件系统查看 `malformed/`。

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
   - 期望：进入 idle 边界后 Diligence 不按预算注入 prompt。
   - 期望：不产生 `mainline_diligence` trigger；不消耗 Diligence 预算。
   - 期望：只保留 active callee / pending tellask 可观察状态，等待结果到达、用户输入、queued prompt 或其它具体驱动来源。

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

11. 用户插话导致多个 active batch 并行。
    - 输入：A batch 尚未全部回贴时，用户补充要求触发 caller 新一轮推进并派发 B batch。
    - 期望：`active-callees.json` 同时保存 A/B 两个 batch；任一 batch complete 都只生成自身 `result_arrival` trigger，不等待另一批。

12. 一轮 generation 合并消费多个 runnable triggers。
    - 输入：caller 同时有用户输入、A batch 的 `result_arrival`、B batch 的 `result_arrival`。
    - 期望：这三个正式事实可以进入同一轮 LLM context；`generationRunState.open.acceptedTriggerIds` 记录全部 trigger ids；durable handoff 后一起消费这些 triggers。

13. recovery trigger 与其它 runnable triggers 合并。
    - 输入：`open_generation_recovery` 或 `reply_delivery_recovery` 存在时，又有用户输入 / result-arrival / queued prompt。
    - 期望：若恢复事实和其它正式事实都进入同一轮 LLM context，可以同轮处理并消费对应 triggers；不要求 recovery 独占一轮，也不额外生成空的 recovery generation。

14. result-arrival trigger 消费幂等。
    - 输入：等待方消费一个 `result_arrival` trigger 并完成 generation。
    - 期望：该 trigger 从状态快照删除；崩溃重启后不重复处理同一 dispatch batch。

15. result-arrival 到达时等待方正在 Q4H。
    - 输入：dispatch batch complete，同时等待方 `userWait.kind='awaiting_user_answer'`。
    - 期望：写入 `result_arrival` trigger 和 batch completion facts，但不新增 gen_start；用户回答清除 user wait 后再消费该 trigger。

16. 主线被 `tellaskBack` 时作为 callee。
    - 输入：上游 ask-back directive 指向主线对话。
    - 期望：主线按 active reply obligation 使用 `replyTellaskBack` 收口；该场景不依赖支线式 Diligence recovery。

17. 支线作为 callee 同时作为 caller 发起下游 `tellask`。
    - 期望：active reply obligation 仍保留；下游 pending tellask 是 background work，不让该支线停止推进；若出现非本意直接回复停止驱动，direct-fallback 交给 caller 判断。

18. callee direct-fallback 作为 result-arrival 事实。
    - 输入：callee 未按 reply 工具收口而直接回复停止驱动。
    - 期望：对应 active callee member 写入 `completion.kind='direct_fallback'` 和 memo；batch complete 后只生成 `result_arrival` trigger，不生成独立 direct-fallback trigger。

19. `replyTellaskBack` 写回等待方。
    - 期望：按 directive 的 target dialog/callId 写入 canonical `tellaskBack` result，并触发等待方处理新事实；不按主线/支线形态猜测 target。

20. Q4H 等待用户回答。
    - 期望：状态快照写入 `DialogUserWaitState.kind='awaiting_user_answer'`，Q4H 仍表示等待用户回答，并且不触发 Diligence。
    - 期望：不产生 `mainline_diligence` trigger，也不把 pending tellask 混入等待原因。

21. 状态事件与状态快照更新的原子性。
    - 输入：模拟 event 写入成功但状态快照元信息未更新的异常路径。
    - 期望：runtime 发 warning / structured diagnostic，把该 dialog 转移到 `malformed/`，停止 unsafe drive；不回扫历史补猜。

### 重启恢复测试

1. closed single pending tellask generation + stale `generating=true`。
   - 构造：状态快照有 `generationRunState.kind=closed`、无 `followup` trigger、pending dispatch batch，latest 仍 `generating=true/needsDrive=true`。
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
   - 构造：状态快照有 `generationRunState.kind=closed`、`followup` trigger 未消费，latest stale。
   - 期望：不重复 replay tool round；只按 `followup` trigger 启动下一轮，并在 `gen_start_record` + `generationRunState.open.acceptedTriggerIds` 完成 durable handoff 后消费 trigger。

9. stale sideDialog after final response anchor。
   - 期望：最终回复锚点之后的 dead/final sideDialog 不进入 restart recovery，也不生成 drive trigger。

10. missing state metadata after restart。
    - 构造：latest.generationRunState 缺失，但历史 course events 可被扫描补猜。
    - 期望：runtime 发 warning / structured diagnostic，把该 dialog 转移到 `malformed/` 并停止 unsafe recovery；不回扫补齐，也不做第二次自动处理。

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
- fork snapshot 中 active callee dispatches 仍要复制为 background facts，但不投影为等待被诉请者状态。

## WIP 状态（阶段性提交标记）

本次提交已把后台 callee dispatch 收敛到 `active-callees.json`，并把旧 `pending-sideDialogs.json` 从运行源里移除；WIP 只保留未收尾的状态机和文案调整。

第一阶段已落地：

- pending tellask / active callee dispatch 不再作为 caller 的暂停条件；`getSuspensionStatus()` 只把 Q4H 视为 `canDrive=false` 的用户等待事实。
- pending tellask 不再投影为 `waiting_for_sideDialogs`；UI 以后台被诉请者数量 / FBR 被诉请者数量表达可观测状态。
- post-tool continuation 排除纯后台 dispatch ack；普通工具结果、invalid tool call、queued prompt、reply recovery 仍按各自语义续推。
- Diligence Push 收敛为主线编排保活机制；支线不再有 sideDialog diligence recovery prompt。
- pending runtime prompt、latest assignment anchor、sideDialog final response 等状态字段已补入，用于减少部分恢复/尾部判定的历史回扫。
- 文档、提示词、UI 文案把运行时关系统一为 caller/callee、诉请者/被诉请者；主线/支线只保留在归档、导航、差遣牒责任、存储生命周期语境。

第二阶段已落地：

- `generationRunState` 已写入 `latest.yaml`：generation start 标记 `open`，generation finish 标记 `closed`；restart open-generation recovery 开始写入 `open_generation_recovery` trigger。
- `NextStepTriggerState` 已开始落地：`queued_prompt`、`backend_queue`、`result_arrival`、`open_generation_recovery`、`reply_delivery_recovery` 已有 durable trigger 形态；`needsDrive` 正在收敛为 trigger projection。
- durable `batchId` 已写入 `active-callees.json` batch；callee 回贴后按同一派发批次是否全部完成生成 `result_arrival` trigger。目标态已更新为 `active-callees.json` + `batchId`，并移除 pending-sideDialogs 作为运行判定源。
- `replyDelivery` 已落地：有效的 `replyTellask*` 工具调用会记录 pending delivery 的 reply callId、genseq、content、target dialog/callId；成功交付后标记 delivered，工具结果回写后标记 `toolResultStatus=recorded` 并移除 recovery trigger。
- `reply-special` restart recovery 已改为读取 `latest.replyDelivery`，不再扫描当前 course events 查找 call-without-result。

仍属 WIP，不能视为本重构完成：

- `needsDrive` 仍保留 boolean / registry 双投影；`setNeedsDrive()` 已降级为 `backend_queue` trigger bridge，backend loop 和 registry hydration 已优先读取 durable `nextStep.triggers`。trigger 已有 dialog-local `seq/nextSeq` 到达顺序；generation start 会把已正式交给本轮上下文的 trigger 写入 `generationRunState.open.acceptedTriggerIds` 并消费 trigger，不保留 consumed tombstone。
- `DialogUserWaitState` 已落地；Q4H append/remove/clear 会同步 `latest.userWait`，driver/display 的常态等待判断开始读取状态快照。Q4H 详细问题载荷仍由 `q4h.yaml` 承载。
- `followup` trigger 已落地为 `nextStep` 变体：普通 immediate tool result、invalid tool recovery、有效 tellask/reply 结果会写入最小原因集合，不另开 `followup.json`；下一轮 gen start durable handoff 后消费。
- `mainline_diligence` trigger 已在 Diligence prompt 注入前写入；Diligence 仍只作用于主线，但 pending active callee dispatch 会否决普通 Diligence 注入，避免主线仅因后台被诉请者事实空转。
- `active-callees.json` 已作为运行判定源：tellask 派发时写入 batch/callee，callee 回贴时按 batch 完整性生成 `result_arrival` trigger；direct-fallback 作为 callee completion memo 进入同一 batch，不新增独立 trigger。后台 callee 数量、Diligence pending 计数和 pending-tellask reminder 已改读 active-callees；运行时代码已移除 pending-sideDialogs 持久化源和旧 `hasPendingSideDialogs()` helper，后续主要收尾测试/文档命名。
- `generationRunState` 已记录 open/closed 的 course/genseq/timestamp、open phase 与 `acceptedTriggerIds`；`finishRecordId` 和 last-tool-round 分类不进入 `generationRunState`，由 event log 与 `followup` trigger 分别承载。
- restart 顺序已调整为 reply recovery 先于 proceeding/open-generation recovery；open-generation recovery 已不再从 `generating=true` 兜底。`generating=true` 但缺少 `generationRunState` 的 dialog 已进入 `malformed/`，不再静默停成 server_restart；generation recovery decision 仍需补齐结构化诊断返回。
- runtime reason / error 已收敛到 result-arrival / dispatch-batch 语义；旧 `tellask-revive-context-refactor` 历史设计文档已删除，当前文档是本轮重构的唯一设计源。
- runtime 读路径仍存在少量历史事件读取；后续必须把常态业务判定改为只读状态快照和显式 pending records。缺少必要元信息或结构不合法时转移到 `malformed/`，不在 runtime 或自动 repair 中回扫历史补齐。

移除 WIP 标记的条件：

1. `needsDrive=true` 仅作为 `NextStepTriggerState.triggers.length > 0` 的投影存在。
2. tellask 派发、callee 回贴、caller result-arrival 全部以 `active-callees.json` 中的 durable `batchId` 串联，且不再依赖 `pending-sideDialogs.json`。
3. restart recovery 只依据 `generationRunState` 判断 open/closed generation，不再用 closed generation 触发 proceeding recovery。
4. reply recovery 只读取 reply delivery 元信息，不再扫描 course JSONL 补猜。
5. 缺少必要状态机元信息或结构不合法时转移到 `malformed/`，记录 warning / structured diagnostic，之后不再自动处理。

## 迁移步骤

1. 新增 generationRunState、DialogUserWaitState、NextStepTriggerState、dispatch batch、reply delivery status 等状态机元信息，并在每次状态转移时同步维护。
2. 移除 runtime 历史回扫补猜路径；旧 dialog 缺必要元信息时进入 `malformed/`。如确有业务价值，由人类手工分析 `malformed/` 记录并修正后续跑。
3. 新增 fact helpers：user wait、next-step facts、completion obligations、background pending work，全部读取状态快照。
4. 调整 dialog `getSuspensionStatus()` 或新增 next-step facts API，先让 drive 使用新 API；API 必须按角色区分 caller background work 与 callee completion obligation。
5. 调整 display projection，移除 pending tellask -> `waiting_for_sideDialogs`，覆盖 caller/callee 角色组合。
6. 调整 post-tool continuation，把 pending tellask ack 从 immediate followup 中排除并加测试。
7. 新增 `active-callees.json`，以 `batchId` 保证多路同组回复齐后才触发 result-arrival handling；消费后删除 batch，不累积历史。
8. 调整 Diligence Push，显式读取状态快照里的 pending tellask context 并改文案。
9. 调整 restart recovery，仅读取状态快照判断 open/closed generation；缺元信息或冲突时转移到 `malformed/`。
10. 调整 proceeding recovery，只恢复真正 open generation。
11. 调整 backend loop，避免 `resumeInProgressGeneration` 绕过已 closed background boundary。
12. 更新 tests / docs / UI run-control copy。

## 风险与判定

### 风险

- 一些旧测试把 pending sideDialog 当暂停原因；重构后需要明确它们测试的是“后台进行中”还是“等待用户/等待 runtime prompt”。
- 主线 Diligence Push 文案或 gate 如果过强，可能又把 pending tellask 表达成必须继续，重新引入后台等待期间的主线空转。
- restart recovery 如果过保守，可能导致真实 open generation 崩溃后不恢复。
- result-arrival handling 如果过弱，可能导致回贴到了但等待方 dialog 不处理。
- active callee batch identity 如果不 durable，崩溃恢复后可能出现部分回贴误触发、整组回贴不触发，或不同批次互相等待。
- 历史主线/支线形态特判如果保留过多，会把归档/编排差异误扩散成控制流差异，导致支线推进或 tellaskBack 场景继续出例外。
- 状态机元信息如果没有随转移同步维护，开发者可能重新引入历史回扫补猜；这必须作为架构回归处理。

### 判定原则

- pending tellask 存在时，caller dialog 可被驱动，但不是因为 pending tellask 必须驱动。
- pending tellask 存在时，caller dialog 可 idle，但 idle 不代表后台完成。
- active reply obligation 存在时，当前 dialog 是 callee；它需要最终通过对应 reply path 收口，但它自己的下游 pending tellask 不决定它是否继续推进。
- caller 处理 callee 回复时，触发粒度是 dispatch batch complete；单个 `tellask` 是 size = 1 的特例。
- 只有不存在 `awaiting_user_answer` 等先决等待事实，且存在未消费 `NextStepTriggerState` trigger 或当前工具轮产生 immediate tool result，才能启动新一轮。
- 已有 `gen_finish_record` 的 generation 不应被 proceeding recovery 重放。
- runtime 运行路径不得通过回扫聊天记录、course JSONL 或历史 tool calls 补猜当前状态；缺少必要元信息或元信息冲突时转移到 `malformed/`，记录 warning / structured diagnostic，之后不做第二次自动处理。
- 主线/支线差异只允许来自编排责任、差遣牒读写责任、归档生命周期；其它 run-control 行为应按统一 dialog 规则解释。
