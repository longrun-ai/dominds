# Dialog Drive Algorithm

本文定义 Dominds dialog drive 的目标结构。它不是一次局部 bug 修复说明，而是后续重构时必须遵守的业务语义边界。

核心判断：

> dialog driver 不是“空转对话”的技术调度器，而是 business continuation 的执行器。

任何进入 drive core 的动作，都必须先由一个本地化的业务 continuation handler 认领。技术形态上的“没有 human prompt”不是业务授权，不能作为 drive 的依据。

同时，drive algorithm 的最高产品目标是**业务保活**。技术不变量服务于“对话能正确地继续”，而不是反过来要求业务对话为技术投影的瞬时洁净让路。若旧 course 的残留 follow-up、displayState 投影抖动、日志诊断噪声等问题不会造成错误交付、重复消费或不可判责，且新的 runtime prompt / 人类判断 / 智能体判断已经给出明确接续路径，系统应优先让对话继续，并保留足够诊断信号供后续自愈。只有会破坏业务消费账本、跨 dialog reply routing、Q4H 等待边界或安全交付边界的冲突，才应阻断 unsafe path。

在保活之下，还要继续追求**顺直**：这里说的不是工程意义上的“最短路径”或“少噪音”，而是业务意图表达要更直白，少额外抽象、少新口径、少让技术概念盖住业务意思。真正“这里不该太啰嗦”的判断应在具体业务场景里落地，而不是把这些技术抽象当成低阶工作的直接口令。

## 背景问题

历史实现里存在两个过宽的技术概念：

- `no-prompt drive`
- dialog-level wake cue storage

它们描述的是技术形态，而不是业务事实。

`no-prompt drive` 只说明这次 drive 没有 fresh human prompt，但很多完全不同的业务 continuation 都满足这个技术条件：

- requested-work reply 到达后，caller 要继续；
- tool result 生成后，需要 follow-up LLM turn；
- durable runtime prompt 需要恢复；
- `replyTellask*` 投递需要 recovery；
- open generation 需要恢复；
- 用户显式恢复 interrupted dialog。

这些业务的 durable authority、消费点、stale 清理、错误边界都不同。把它们放进一个总的 `inspectNoPromptSideDialogDrive` 或类似 gate，会把业务语义压扁成技术条件，最后变成跨业务综合判断和清理逻辑。

dialog-level wake cue storage 的问题类似。它把某个 dialog 标成“值得被 drive 看一下”，但这仍然是 dialog-level 的技术抽象。它既不是业务事实，也不是消费账本。残留 watch 很容易变成空 drive、误触发 continuation 或噪声日志。

## 与前序重构文档的关系

本文接替并取代前序 tellask background continuation 阶段性文档。那些文档记录的是从现场 bug 到第一轮状态机收敛的过程；其长期规则已沉淀到本文、代码、测试和 git 历史中。当前代码已经完成其中大部分基础：

- `pending-sideDialogs` 不再是运行判定源；
- `active-callees.json` 成为 caller 侧后台派发批次运行源；
- `latest.nextStep.triggers` 成为显式下一步事实；
- `generationRunState` 记录 open generation recovery 所需元信息；
- `replyDelivery` 记录 `replyTellask*` 跨 dialog 投递与本地 tool result 补账状态；
- `DialogUserWaitState` / Q4H 等先决等待不再靠 displayState 反推；
- `needsDrive` / backend queue 旧 boolean 投影已基本退出运行面；
- 常态运行判定不再回扫 course JSONL 推导 active callee / reply recovery；
- root-local `wake-queue.jsonl` 存储业务命名 wake queue entries，避免 backend loop 全量扫描历史支线。

因此本文不是从头重写 tellask background 语义，而是在这些基础之上继续收敛 dialog drive algorithm：把“还能自动 drive 吗”进一步改写成“哪个业务 continuation 被 wake，哪个 handler 能 claim”。

当前文档保留前序文档中仍有长期价值的原则；前序文档中的现场路径、阶段性 patch 计划、已完成 bug 记录交给 git 历史归档。

### 前序成果必须继续保持

以下原则已经通过前序重构确立，后续不得回退：

- `tellask` / `tellaskSessionless` / registered Type-B assignment 是后台并行委派；pending tellask 不表示 caller 必须等待或停止。
- active reply obligation 是 callee completion obligation；它要求当前 dialog 最终交付，但不阻止该 dialog 自己继续使用工具或发起下游 tellask。
- caller/callee 是相对业务角色，不是主线/支线静态层级。主线被 `tellaskBack` 时也是 callee；支线发起下游 tellask 时也是 caller。
- 主线/支线差异只应保留为 lifecycle / presentation / 编排职责差异，不应改变 drive、reply recovery、result-arrival、Q4H、post-tool continuation 的状态机语义。
- Diligence Push 是主线编排保活机制；它可读取 pending background work 作为提示素材，但不能把 pending tellask 改造成 runtime drive 授权，也不能作用于 callee 自动鞭策。
- displayState、run-control counts、badge、dialog list 状态都只是投影；运行判定必须读取结构化 durable state。
- 旧对话运行态缺必要元信息时，系统应 loud diagnostic 并停止 unsafe path，不做历史数据 repair 工具，不靠 transcript 回扫补猜。

### 已完成现场 bug 的归档边界

前序现场 bug 信息按以下方式沉淀：

- caller/callee 命名与 badge 推送属于 UI/观测层规则；保留在相关代码与测试中，不再由 drive algorithm 文档承载现场细节。
- duplicate pending `replyDelivery` 的结论保留为 reply delivery handler 规则：可恢复 stale pending delivery 应 loud warn 并按当前有效 reply obligation 替换，真正 correlation 冲突才 loud fail。
- 支线 caller 收到 callee 诉请回复后没有继续运行的结论保留为 wake queue 规则：不能全量扫描历史支线，必须有 root-local 精确 wake queue entry。
- `needsDrive` / `backend_queue` 旧术语继续收敛为显式 wake queue entry 与 next-step trigger，不再作为文档概念保留。
- malformed 边界已覆盖关键恢复路径：必要状态机元信息缺失时应 loud fail / quarantine malformed，而不是初始化默认值后继续 unsafe drive；后续扩展仍按同一原则处理。

## 目标结构

目标结构只有三类角色：

1. Wake Queue
2. Business Continuation Handler
3. Drive Core

### Wake Queue

Wake queue 只负责调度可达性：哪个 root/dialog 需要被唤醒检查。

它可以粗，可以重复，可以只存轻量 routing 信息。它不宣称“这里一定有业务价值”，也不消费业务事实。它的价值是避免无界扫描，并把 wake 送到正确 dialog / handler 附近。

队列项应是业务命名的 wake queue entry，例如：

- `requested_work_reply_arrived(batchId)`
- `reply_delivery_recovery(replyDeliveryId)`
- `tool_followup(triggerId)`
- `pending_runtime_prompt(msgId)`
- `open_generation_recovery(course, genseq)`
- `root_runtime_wake(reason)`
- `explicit_interrupted_resume(reason)`

这些 entry 仍然只是唤醒提示，不是业务权威。handler 必须重新读取 durable state 并本地 claim。

当前 `wake-queue.jsonl` 是 root-local durable wake queue 存储：它由整个 root dialog hierarchy 共享，解决“backend loop 不能全量扫描 root 下所有历史支线”的性能与安全问题，并以 `targetDialogId`、`kind`、业务 identity 定位 handler 附近。它仍然只负责可达性，不能成为业务事实或消费账本。JSONL 逐行存储允许诊断和修复时隔离坏行；运行读取仍必须 loud fail，不能静默跳过损坏 entry。

### Business Continuation Handler

Business continuation handler 是 drive 算法的业务核心。

每个 handler 必须在自己的闭包内完成以下判断：

- 我在继续哪一个业务事实？
- 这个事实的 durable authority 是什么？
- 它是否仍未消费？
- claim 成功后要给 drive core 哪些显式 continuation 信息？
- 它的消费点在哪里？
- stale 时本业务如何清理自己的 entry / trigger？
- 不合理状态如何 loud fail？

handler 之间不能共享一个综合 `canAutoDrive` / `canNoPromptDrive` / `cleanupStaleContinuation` 之类的总逻辑。跨业务汇总判断会丢失业务依据，并制造 spaghetti。

### Drive Core

Drive core 只执行已经被 handler claim 的 continuation。

它负责 generation/tool loop、streaming、tool result、context assembly 等执行细节，但不猜“为什么这次可以 drive”。`driveOptions.source` / `reason` 只应作为 diagnostics，不应作为业务授权依据。

## 基本算法

目标算法应接近：

```text
wake queue yields entry
  -> resolve target dialog
  -> dispatch entry to its local business continuation handler
  -> handler re-reads durable authority
  -> handler returns one of:
       claimed(continuation) -> drive core executes explicit continuation
       stale(cleaned)        -> handler cleaned its own stale entry / trigger; stop
       not_applicable        -> try next entry/handler or expire queue item
       impossible(error)     -> loud fail
```

如果一个 dialog 被唤醒但没有任何 handler 能 claim 业务事实，这不是“尝试 no-prompt drive”的理由。应移除或过期对应 wake queue entry，并保留足够 diagnostics。

## 业务 continuation 设计规则

### 0. 角色模型必须相对化

所有 drive 规则都应按当前 dialog 相对于某条业务链路的角色判断，而不是按“主线/支线”硬编码。

同一个 dialog 可以同时是：

- caller：发起后台 tellask / tellaskBack；
- callee：承担上游 active reply obligation；
- reply result owner：等待某个 reply tool 写回 canonical result；
- dispatch batch caller：等待同一派发批次的 callee results 完整收口；
- user-wait owner：等待 Q4H / askHuman 用户回答。

handler 必须先确认自己处理的是哪一条业务关系。不得用 dialog 类型、root/self 层级、displayState 文案或 UI badge 反向推断业务事实。

### 1. Durable authority 必须业务化

每个 continuation 必须有自己的 durable authority。例如：

- requested-work reply: `active-callees`
- follow-up: `latest.nextStep.triggers[kind=followup]`
- reply delivery recovery: `latest.replyDelivery`
- pending runtime prompt: `latest.pendingRuntimePrompt`
- open generation recovery: `latest.generationRunState`
- explicit interrupted resume: `executionMarker` 加显式用户/系统授权
- user wait / Q4H: `latest.userWait`

不能用 transcript 扫描、模糊匹配、fingerprint、source/reason 猜测业务事实。

### 2. 消费点必须明确

handler 必须定义“什么时候算已消费”。

requested-work reply 的原则是：

> 如果后续 gen turn 的 LLM context 已经接受了 reply 内容，这个 result 就已消费，后续 continuation 必须视为 stale。

当前对应消费账本是 `active-callees`。`result_arrival` 只是交接提示；真正判断是否还能继续，必须看 `active-callees` 里是否仍存在对应 batch。

其他 continuation 也必须建立类似的业务消费点，而不是依赖 wake queue entry 是否存在。

### 3. Stale 清理必须本地化

stale 清理只能清理本业务自己产生的 entry / trigger。

例如 requested-work reply handler 可以清理自己确认 stale 的 `result_arrival` trigger；reply delivery handler 可以清理自己确认 completed 的 `reply_delivery_recovery` trigger。

禁止设计一个跨业务“清理所有 stale continuation”的总逻辑。

### 4. 不合理状态必须 loud fail

如果 durable authority 存在但状态不可能继续，handler 必须抛出显式错误并记录稳定关联字段，例如：

- `rootId`
- `selfId`
- `course`
- `genseq`
- `callId`
- `batchId`
- `replyDeliveryId`
- `questionId`

不能吞错，不能静默降级成“没有 durable work”。

### 5. Queue 不拥有业务真相

Wake queue 可以丢、重复、延迟、残留。它只是让 handler 有机会检查业务事实。

因此：

- queue item 存在，不代表可以 drive；
- queue item 消失，不代表业务事实已消费；
- handler claim 必须读 durable authority；
- handler stale 必须只清自己的 entry / trigger；
- drive core 不能根据 queue/source/reason 猜授权。

### 6. 先决等待优先于 runnable continuation

`userWait.kind === awaiting_user_answer` 这类先决等待不是 trigger，也不是业务 continuation 的消费点。等待用户期间到达的 `result_arrival`、`reply_delivery_recovery`、`followup` 等事实仍可写入 durable state / wake queue，但 backend driver 不能越过 user wait 自动启动 generation。

用户回答到达后，清除 user wait，再按 durable 到达顺序由对应 handler claim 未消费 continuation。不要在调度循环里拼接“如果 user wait 且 result arrival 且某种 source/reason”之类组合规则。

### 7. 状态机元信息必须随转移写入

后续判断所需的最小充分元信息必须在状态机转移时同步写入 durable state。event log 是审计、调试、上下文展示和 dialog fork 输入，不是常态运行判定源。

尤其不能通过回扫历史来推导：

- dispatch batch 是否 complete；
- reply delivery 是否已经 delivered / recorded；
- active reply obligation 是否仍有效；
- open generation 是否可恢复；
- pending runtime prompt 是否已送入 LLM turn；
- next-step trigger 从何而来。

如果状态快照缺少必要元信息，按 loud error / malformed 处理，而不是扫描历史补猜。

## 各 continuation 的目标形态

### User Input / Q4H Answer

业务事实：用户给 dialog 发送新输入，或回答一个已 materialized 的 askHuman / Q4H question。

Durable authority:

- user prompt / answer 的稳定 `msgId`；
- Q4H / askHuman 对应 `questionId`、`callId`；
- `latest.userWait` 中的等待事实。

Claim:

- 新用户输入可以清除可被用户输入解除的 interrupted state；
- Q4H answer 必须匹配仍在等待的 question/call；
- 如果 question 已不存在或 callId 不匹配，按 stale 或 loud fail 区分处理。

Consume:

- 用户输入进入当前 turn 后写入 transcript；
- Q4H answer 写回对应 tellask result / user wait state；
- 清除对应 user wait。

### Requested-Work Reply

业务事实：callee 的结果到达 caller，caller 需要把结果纳入下一轮 LLM context。

Durable authority:

- `active-callees` 中对应 batch 是否存在；
- batch 必须是 `resolved`；
- `result_arrival` trigger 只是 gen-start handoff trigger。

Claim:

- direct requested-work reply 必须带 batch correlation；
- backend wake queue entry 也必须指向 batch；
- handler 读取 `active-callees`，确认 batch still live。

Consume:

- 当一个具体 gen turn 接受 `result_arrival` trigger 后，移除对应 `active-callees` batch；
- 后续 direct continuation 或 backend queue entry 再看到同 batch，必须 stale。

Stale cleanup:

- 只清理对应 stale batch 的 `result_arrival` trigger；
- 不清理其他业务 trigger。

### Tool Follow-Up

业务事实：tool result 已进入 transcript，需要 LLM 对结果继续反应。

Durable authority:

- `latest.nextStep.triggers[kind=followup]`
- trigger 中的 `sourceGeneration`、`reasons`、`continuation`

Claim:

- handler 接受 follow-up trigger；
- 如果 trigger 携带 `businessContinuation`，必须与当前 continuation 一致，冲突时 loud fail。

Consume:

- gen-start 接受 trigger 后从 `nextStep` 移除；
- generationRunState 记录 accepted trigger ids。

Stale cleanup:

- 只能清理本 follow-up trigger；
- 不能用“近期是否生成过内容”之类 transcript 猜测。
- 如果一个更新的 pending runtime prompt 已经开启新 course，旧 course 的 follow-up 不应和新 prompt 在同一 gen turn 中竞争 business continuation；此类残留应被视为被新 course prompt 取代，loud warn 后清理对应 trigger，让新程继续运行。

注意：pending tellask dispatch ack 不是 immediate follow-up 的理由。只有真正需要当前 LLM 立刻消化的 tool result、invalid tool recovery、reply delivery result 等，才应形成 follow-up。

### Pending Runtime Prompt

业务事实：系统生成的 runtime prompt 尚未送入 LLM turn。

Durable authority:

- `latest.pendingRuntimePrompt`
- `msgId`
- prompt 中携带的 reply directive / target

Claim:

- handler 读取 pending prompt；dialog 本地 `queued prompts` 只是已物化输入，不能替代 durable pending authority；
- `msgId` 必须稳定，queued runtime prompt 必须与 `latest.pendingRuntimePrompt` 精确匹配；
- 如果 queued runtime prompt 已没有对应 durable pending prompt，按 stale 丢弃，不能开启空 generation；
- 如果 prompt 与 active reply obligation 不一致，按业务 invariant loud fail 或由对应业务修复。

Consume:

- prompt 成功进入 current turn 后，按 `msgId` 清除 pendingRuntimePrompt。

### Reply Delivery Recovery

业务事实：`replyTellask*` 工具调用已经产生，需要完成跨 dialog reply 投递和本地 tool result 补账。

Durable authority:

- `latest.replyDelivery`
- `replyDelivery.status`
- `replyDelivery.toolResultStatus`
- `replyCallId`
- `targetDialogId`
- `targetCallId`

Claim:

- handler 只在 `status === pending` 或 `toolResultStatus === pending` 时 claim；
- 如果 `reply_delivery_recovery` trigger 存在但 replyDelivery 已完成，清理该 trigger；
- 如果 target/call correlation 不一致，loud fail。

Consume:

- 投递给 asker 后标记 `status=delivered`；
- 本地 tool result 记录后标记 `toolResultStatus=recorded`；
- 两者都完成后，不应再触发 recovery。

注意：live backend wake 与 restart recovery 都必须 dispatch 到 reply delivery handler，不能只靠 restart recovery。

duplicate pending `replyDelivery` 的处理必须保留前序重构结论：如果旧 pending 已经被状态事实证明为 stale，而新 reply call 对应当前有效 reply obligation，可以 loud warn 并替换 pending delivery；如果 target/call/tool correlation 冲突，则 loud fail。

### Open Generation Recovery

业务事实：进程中断或恢复时，durable state 显示 generation 仍处于 open 状态，需要继续或收束。

Durable authority:

- `latest.generationRunState.kind === open`
- generation course/genseq/acceptedTriggerIds

Claim:

- handler 必须确认 generation 可恢复；
- 如果 sideDialog final response 已锚定且没有 recoverable generation，应拒绝或清理本业务 entry / trigger。

Consume:

- recovery 完成后关闭 generationRunState，或按 interruption 规则设置 executionMarker。

### Explicit Interrupted Resume

业务事实：dialog 被中断，用户或明确系统动作要求恢复。

Durable authority:

- `latest.executionMarker.kind === interrupted`
- interruption reason
- explicit resume authorization

Claim:

- 必须有用户 prompt 或明确 resume continuation；
- 不能因为 backend wake 或 queue residue 自动恢复。

Consume:

- drive core 开始后清除/更新 execution marker；
- interjection-pause 等特殊原因必须按业务语义恢复 reply obligation，不可一概清空。

### Mainline Diligence

业务事实：主线 dialog 作为编排者，需要在没有其它具体输入时获得保活提示。

Durable authority:

- 主线 dialog 的 Diligence Push 配置和预算；
- 当前 mainline 状态；
- 只读 background work observability，例如 active callee pending 摘要。

Claim:

- 只适用于主线；
- 不得绕过 user wait；
- 不得仅因 pending active callee 触发空转；
- pending background work 只能影响 prompt 文案，例如提醒不要宣布全局完成。

Consume:

- 生成明确的 runtime prompt / mainline diligence continuation；
- 进入 drive core 后按普通 prompt 消费。

## 要删除或降级的概念

### `blocker`

不作为新设计概念。

目标表达不是“当前 blocker 是什么”，而是直接列出具体事实：user wait、pending runtime prompt、follow-up trigger、requested-work reply、reply delivery recovery、open generation recovery、mainline diligence 等。旧 `blocker` 命名只可作为迁移对象被提及。

### `needsDrive`

不作为运行状态保留。

业务上不存在一个叫“这个 dialog 需要 drive”的 boolean。真实来源必须是具体 wake queue entry / next-step trigger / open generation / pending reply delivery 等结构化事实。

### `no-prompt drive`

应删除为业务概念。

保留底层“drive core 可在没有 fresh human prompt 时执行”的能力，但入口必须来自具体 continuation handler。

禁止新增：

- `canNoPromptDrive`
- `inspectNoPromptDrive`
- `noPromptEntitlement`
- `noPromptResumeReason`

### Dialog-Level Wake Storage

已从运行面删除。

跨 root 找到 sideline 的唤醒机制仍然需要，但不应叫 watch dialog，也不应表达“这个 dialog 应该被 drive”。当前机制是 root-local Wake Queue，队列项携带业务命名 `kind` 与 identity。

不得重新引入只存 dialog id 的 wake storage，也不得把 wake queue entry 当成业务授权依据。

### `entitlement` / `revive`

应降级为迁移期术语并最终删除。

业务上不是某个 dialog 获得“恢复权”，而是某个具体新事实到达，需要对应 handler claim。例如：

- `requested_work_replied(batchId)`
- `deliver_tellask_reply(targetCallId)`
- `reply_delivery_recovery(replyDeliveryId)`

若底层临时保留 entitlement token，它必须携带同一个业务 identity，且不能替代 durable state claim。

### Open generation recovery

业务事实不是“恢复 proceeding 显示状态”，而是 `generationRunState.kind === open` 表明上一次 generation 未闭合。已 closed generation 只能重新投影 idle/stopped/dead 等状态，不能自动续跑。

### `source` / `reason`

保留为 diagnostics。

不能作为业务授权依据，不能替代 handler claim。

## 迁移计划

建议按低风险顺序推进：

0. 已完成基础：保留 `active-callees.json`、`nextStep.triggers`、`generationRunState`、`replyDelivery`、`userWait` 等状态机元信息作为运行判定源；不回扫历史补猜。
1. 以 requested-work reply 为样板，确认 `active-callees` 消费账本、`result_arrival` handoff trigger、backend Wake Queue claim 都已本地化。
2. 已完成：建立 reply delivery live continuation handler，让 backend wake 能执行 pending reply recovery，而不是只依赖 restart recovery。
3. 已完成：将 follow-up、pending runtime prompt、open generation recovery 的入口显式化为 handler；explicit interrupted resume 保持由 interruption marker + 明确 resume 授权 gate 处理。
4. 已完成：把 root/sideDialog wake 存储从 dialog-level watch 迁移到业务命名 Wake Queue entry。
5. 已完成：删除 `noPromptSideDialogResumeEntitlement` 和 `inspectNoPromptSideDialogDrive`。
6. 已完成：删除运行面 dialog-level wake storage 命名，保留必要的 `wake-queue.jsonl` 存储实现。
7. 已完成关键边界：restart recovery 等必要运行元信息缺失时 loud diagnostic / malformed quarantine，而不是初始化默认值后继续运行；后续新增恢复入口必须沿用同一规则。
8. 已完成：删除前序阶段性文档，让本文成为后续 dialog drive 重构的唯一设计入口。

每一步都必须遵守：

- 不加兼容双路径；
- 不用 transcript/fingerprint 猜业务；
- 不加跨业务 cleanup；
- 不用 source/reason 当授权；
- handler 自己 claim、consume、stale cleanup、loud fail。

## 旧文档归档结果

前序阶段性文档已删除。以下信息已在本文、代码、测试或 git 历史中有归宿：

- tellask background 语义：pending tellask 不让 caller 等待，不触发空 generation。
- caller/callee 角色相对性：不按主线/支线硬编码 drive/reply/recovery。
- Diligence Push 边界：只作用主线编排保活，不把 active callee pending 当 runtime drive 授权。
- active-callees 语义：既是 observability/background summary，也是 requested-work reply 的消费账本；消费后删除 batch，不累积历史。
- result-arrival 语义：trigger 是 gen-start handoff trigger，业务授权来自 `active-callees` batch claim。
- replyDelivery 语义：pending/delivered/recorded 双状态防重复交付，duplicate stale pending 走 loud warn + replace，correlation 冲突 loud fail。
- root-local Wake Queue：不能全量扫描历史支线；当前实现是业务命名 Wake Queue entry。
- 状态机元信息：常态 runtime 不回扫 course JSONL；缺元信息时 loud/malformed。
- 已完成现场 bug 的测试名或代码路径保留，例如 background callee badge event、sideDialog caller result-arrival backend wake queue、reply delivery duplicate/stale handling。

## 反模式清单

以下设计一律不可取：

- 把各种 continuation 汇总成一个 `canAutoDrive`；
- 用 edge/level/fingerprint 代替业务 durable authority；
- 根据 old transcript 或 LLM ctx 文本模糊匹配判断是否消费；
- 在 backend loop 中直接“试 drive 一下”；
- wake queue entry 残留时启动空 generation；
- stale 清理做成跨业务总清理；
- 发现 invariant 不合理时静默移除 queue item；
- 让 `source` / `reason` 决定业务是否可以继续。
- 用主线/支线身份替代 caller/callee 当前业务角色；
- 用 displayState、badge、run-control count 反向推导运行事实；
- 为旧 dialog 运行态缺失制作历史 repair 工具；
- 把 pending tellask dispatch ack 当作 immediate follow-up。

## 一句话原则

Queue 只负责唤醒；handler 负责业务；drive core 负责执行。

没有业务名字的 drive 不应该存在。
