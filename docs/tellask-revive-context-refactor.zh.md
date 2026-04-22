# Tellask 回复续驱与上下文重构草案

> 状态：Draft / 讨论记录  
> 日期：2026-04-21  
> 语义基准：中文为准；英文文档待方案稳定后再补。

## 1. 背景

当前 `tellask*` / `replyTellask*` 机制已经能完成跨对话诉请、支线回贴、pending sideDialog 恢复等主流程，但在“多诉请并发 + 延迟回复 + course 切换”的场景里，现有模型暴露出两个核心问题：

1. **revive 粒度过粗**：owner dialog 只要仍有任意 pending sideDialog，就整体不继续；这会让不同生成轮次发出的诉请互相阻塞。
2. **原位补真实结果割裂现实时间线**：延迟回复到达后，系统把真实结果补回原 tool call 位置，导致 LLM 上下文看起来像“当时已经看到回复”。这和真实运行时序相反，也会让后续判断变得难以解释。

本重构的目标不是做局部补丁，而是重新梳理三条必须同时成立的语义：

- provider tool-call adjacency 必须稳定；
- LLM 只能基于当时实际可见的回复继续判断；
- UI 展示、持久化、恢复、carryover 语义必须一致。

### 1.1 数据兼容前提

本重构不背历史数据包袱：旧 `.dialogs/` 可清空 / 丢弃，不要求历史对话 persistence 继续可读。

因此实现不做旧 pending record 迁移、不做兼容投影、不做 silent fallback。新的存储 contract 可以直接提升为 invariant；读到缺字段或 malformed persistence 时应 loud fail / quarantine，而不是运行时猜测归组。

上下文窗口规则也保持简单：

- 最新 course 全量进入 LLM context；
- 历史 course 永不进入 LLM context；
- Dominds 不做同 course 内 context window 裁剪。

因此不存在“同 course 内 pointer 目标被裁剪后需要可见性修复”的语义分支。carryover 只处理跨 course：当原 call 所在 course 已不是 latest course，latest course 必须注入自包含回贴事实。

## 2. 现有术语与文案基线

不要新增“异步回复”之类独立技术标签。跨对话正文和 UI 气泡文案应继续对齐当前 runtime marker 与 tellask 系函数名。

现有标签基线：

- `tellaskBack` / `replyTellaskBack`
  - 中文标签：`【回问诉请】`
  - 英文标签：`【TellaskBack】`
- `tellask` / `replyTellask`
  - 中文语义名：`长线诉请`
  - 英文语义名：`Tellask Session`
- `tellaskSessionless` / `replyTellaskSessionless`
  - 中文语义名：`一次性诉请`
  - 英文语义名：`Fresh Tellask`
- 常规支线完成回贴
  - 中文 runtime marker：`【最终完成】`
  - 英文 runtime marker：`【Completed】`
- `freshBootsReasoning`
  - 中文标签：`扪心自问（FBR）`
  - FBR 回贴 marker：`【FBR-直接回复】` / `【FBR-仅推理】`

设计约束：

- 标签必须来自 `tellask*` / `replyTellask*` 的真实函数语义或现有 runtime marker。
- role=user 的系统注入消息应沿用现有风格：明确说明“这不是新的用户请求 / 不是当前程新发起的函数调用 / 是运行时维护的跨对话事实”。
- UI tellask 回复气泡和 LLM 上下文正文应尽量使用同一 canonical transfer payload，避免 UI 一套、模型一套。

## 3. 已达成的设计判断

### 3.1 wait-group 作用域

同一个 owner dialog 内，`callingCourse + callingGenseq` 足以作为 wait-group key。

原因：

- pending sideDialogs 的读取与变更本身就是 owner-dialog scoped；
- `genseq` 需要配合 `course` 使用，单独 `genseq` 不足以跨 course 唯一；
- `ownerDialogId` 不需要进入业务 key，但必须出现在日志、drive entitlement、错误信息和诊断结构里。

概念模型：

```ts
type TellaskWaitGroupKey = {
  callingCourse: number;
  callingGenseq: number;
};
```

诊断模型可以扩展为：

```ts
type TellaskWaitGroupRef = TellaskWaitGroupKey & {
  ownerDialogId: string;
};
```

### 3.2 revive 规则

同一 `callingCourse + callingGenseq` 发出的 tellask 诉请组成一个 wait-group。

规则：

1. 同组 pending 全部完成后，owner dialog 才因该组回复而 revive。
2. 不同 wait-group 之间不互相等待。
3. 一个较晚或较早 genseq 的 sideDialog 回复到达时，只检查它自己的 wait-group；如果该组已齐，就可以触发 owner 继续。
4. Q4H 仍然是独立硬阻塞；存在 pending Q4H 时不得自动 revive。
5. revive 前必须 fresh read persistence，不能只信内存里的 pending 状态。

### 3.3 LLM 可理解指针

LLM 不能理解 `course X / genseq Y` 这种内部坐标，也无法据此定位历史上下文。因此，任何给 LLM 的 pointer 都必须是文本上可追踪的锚点。

内部坐标只用于：

- wait-group 分组；
- deep link；
- UI 定位；
- 排序；
- crash recovery；
- 结构化日志与诊断。

LLM 可见文本必须使用：

- `callId`；
- tellask 函数名；
- 现有语义标签；
- 原诉请摘要；
- 当前 latest course 中实际存在的回贴块。

### 3.4 原 call 位置不再补真实回复

原 call 位置不应补入真实回复正文。真实回复必须按实际到达时间进入 owner dialog 当前时间线。

原 call 位置只负责 provider adjacency 与 forward pointer：

- pending 未完成时：提供“该诉请仍在等待回贴”的 tool-result-shaped 占位文案；
- 回复已到达时：提供“本次 `tellask*` 回贴已在后续上下文以同一 `callId` 标记出现”的 pointer 文案；
- pointer 不应携带完整回复正文；
- pointer 不能只指向 UI deep link，必须指向 LLM 当前 latest course 中真实存在或由跨 course carryover 注入的回贴块。

### 3.5 真实回复按到达顺序追加

sideDialog 回复到达 owner dialog 时，应追加一块“回贴事实”到 owner dialog 当前时间线，而不是改写历史 call site。

这块事实正文应与现有 UI tellask 回复气泡尽量对齐，例如延续当前模式：

- `@<tellaskee> 已回复：`
- 引用回复正文；
- `针对原始诉请： @target ...`
- 引用原诉请正文；
- 必要时带 `【最终完成】` / `【回问诉请】` / `【FBR-...】` marker。

避免使用“异步回复”作为标题。建议标题或首行来自真实函数语义，例如：

- `【最终完成】`
- `【回问诉请】`
- `【FBR-仅推理】`
- `tellask(...) 回贴`
- `tellaskSessionless(...) 回贴`
- `tellaskBack(...) 回贴`

具体最终文案应从 `inter-dialog-format.ts` 的现有 formatter 扩展，不应另起一套。

### 3.6 carryover 必须自包含

只有最后一个 course 会进入 LLM 上下文。历史 course 完全不可见。

因此，如果原 call 所在 course 已不是当前 latest course，当前 latest course 必须写入自包含 carryover 回贴事实，包含：

- 对应的 `callId`；
- tellask 函数名与语义标签；
- 原诉请正文或足够完整的原诉请摘要；
- 回复者；
- 回复正文；
- 状态；
- session 信息（如有）。

不能只写：

> 具体见 course X / genseq Y。

这种文本只对系统和 UI 有意义，对 LLM 无法操作。

## 4. 建议的新语义模型

### 4.1 三类 LLM 可见文本

#### 4.1.1 Call-site pending result

位置：原 tool call 附近。

用途：

- 满足 provider tool-call adjacency；
- 告诉模型该诉请已经发出，但此刻还没回贴；
- 不制造“回复已知”的假象。

中文文案方向：

```text
[Dominds 诉请状态]

`tellaskSessionless` 诉请已发出，当前仍在等待回贴。

- callId: <callId>
- 对象: @<target>

这不是回贴内容。若后续收到回贴，运行时会在后续上下文中用同一 callId 补入对应回贴事实。
```

英文文案方向待后续稳定后补。

#### 4.1.2 Call-site forward pointer result

位置：原 tool call 附近。

用途：

- 满足 provider tool-call adjacency；
- 在 latest course 上下文重建时，让模型知道真实回贴在后文；
- 仍然不把真实回复补回过去。

中文文案方向：

```text
[Dominds 诉请状态]

`tellaskSessionless` 诉请的回贴已在后续上下文中补入。

- callId: <callId>
- 后续回贴标签: `tellaskSessionless` 回贴 / `【最终完成】`

请以后续同一 callId 的回贴事实为准；不要把本工具结果当作回贴正文。
```

注意：

- pointer 的目标必须是文本锚点，不是只有系统坐标。
- 当后续回贴事实不在当前 latest course 时，必须通过跨 course carryover fact 重新注入可读内容。

#### 4.1.3 Arrival / carryover fact

位置：回复实际到达 owner dialog 的时间线位置；跨 course 时在当前 latest course 注入。

用途：

- 这是 LLM 真正可用的业务事实；
- UI tellask 回复气泡和模型上下文应尽量复用同一内容；
- 它按实际到达顺序出现。

中文文案方向应扩展当前 formatter 风格：

```text
【最终完成】

@<tellaskee> 已回复：

> <responseBody>

针对原始诉请： @<target> • <sessionSlug?>

> <tellaskContent>

[Dominds 诉请状态]
- 函数: `tellaskSessionless`
- callId: <callId>
- 说明: 这是前序诉请的回贴事实，不是新的用户请求，也不是当前程新发起的函数调用。
```

`[Dominds 诉请状态]` 作为 arrival / carryover fact 的轻量尾注。业务语义先行，状态尾注只负责提供 LLM 可追踪锚点与 provenance。`callId` 必须显式出现在正文里，不能只保留在结构化 record / UI 元数据中。

## 5. 数据与事件设计倾向

### 5.1 PendingSideDialogStateRecord

`callingCourse` 与 `callingGenseq` 应从 optional 提升为必填 invariant。

理由：

- wait-group 语义依赖它们；
- 缺失时无法安全判断是否同组齐活；
- 静默归入 unknown group 会制造提前 revive 或永不 revive；
- 本重构不兼容旧 `.dialogs/` 数据，因此无需迁移 optional 字段。

实现要求：

- 创建 pending record 时 `callingCourse` / `callingGenseq` 不允许为 `undefined`；
- 如果当前没有 active course / active genseq 却要创建 pending sideDialog，直接抛 invariant error；
- validator 要求二者必填且为正整数；
- 读到缺字段或 malformed persistence 时 loud fail / quarantine，不做 runtime fallback。

### 5.2 Reply arrival record

建议引入显式 record 来表达“回复按实际到达时间进入 owner dialog 历史”。

概念字段：

```ts
type TellaskReplyArrivalRecord = {
  type: 'tellask_reply_arrival_record';
  callId: string;
  callName: 'tellask' | 'tellaskSessionless' | 'tellaskBack' | 'freshBootsReasoning';
  status: 'completed' | 'failed';
  callingCourse: number;
  callingGenseq: number;
  ownerArrivalCourse: number;
  ownerArrivalGenseq: number;
  tellaskeeId: string;
  tellaskeeAgentId?: string;
  tellaskeeDialogId?: string;
  tellaskeeCourse?: number;
  tellaskeeGenseq?: number;
  mentionList?: string[];
  sessionSlug?: string;
  tellaskContent: string;
  responseBody: string;
};
```

说明：

- `ownerArrivalGenseq` 描述 owner dialog 何时实际看见这条回贴；
- `tellaskeeGenseq` 描述 sideDialog 在哪里产出回复；
- 两者不能混用。

### 5.3 Tool-result projection

现有 “把真实 tellask_result 补回原 call 位置” 的 provider context 投影需要重构为：

1. 原 call 附近始终投影 pending / pointer result；
2. 真实回复作为 arrival / carryover fact 正常进入上下文；
3. 如果 arrival fact 不在当前 latest course，必须注入自包含 carryover fact；
4. 不允许通过历史坐标要求 LLM 自行找回不可见内容。

## 6. Revive gate 设计

### 6.1 Response supply 阶段

收到某个 sideDialog 回复时：

1. 加 owner scoped sideDialog txn lock。
2. 读取 pending sideDialogs。
3. 找到并移除当前 `sideDialogId` 对应 pending record。
4. 从该 record 读取 `callingCourse + callingGenseq`。
5. 保存新的 pending 状态。
6. 追加 arrival / carryover fact。
7. fresh 检查：
   - 是否仍有 Q4H；
   - 是否仍有同 `callingCourse + callingGenseq` 的 pending。
8. 若 Q4H 为空且同组 pending 清空，则 schedule revive。

### 6.2 Drive entitlement

schedule revive 时必须携带 wait-group entitlement：

```ts
type ResolvedTellaskWaitGroupEntitlement = {
  ownerDialogId: string;
  callingCourse: number;
  callingGenseq: number;
  resolvedCallIds: string[];
  triggerCallId: string;
};
```

preflight 不应使用简单的 `allowPendingSideDialogs: true`。

它应该表达：

- 允许其它 wait-group 的 pending 继续存在；
- 不允许本 entitlement 指向的 wait-group 仍有 pending；
- Q4H 仍然不允许旁路。

### 6.3 Display state

auto-revive 能因为某个 wait-group 齐活而继续 drive，并不等于 owner dialog 已经没有 pending sideDialogs。

因此：

- drive 中途可以继续；
- 如果 LLM 停下而其它 wait-group 仍 pending，display state 应回到 `waiting_for_sideDialogs`；
- pending tellask reminder 仍应保留其它未完成 group；
- UI 不应把“这组已齐活”误显示成“所有支线已完成”。

## 7. Race 与一致性风险

### 7.1 同一轮多 tellask 的登记完成边界

当前执行多个 tellask call 时是顺序处理。若第一个 sideDialog 极快返回，而同一 genseq 的兄弟 pending 尚未全部登记，就可能误判该组已齐。

定案：拆成两阶段，先登记全部 pending，再启动任何 sideDialog drive。

规则：

1. 当前 assistant round 的所有 special calls 先 parse 完。
2. 对所有确认会产生 pending sideDialog 的 tellask / FBR call，先一次性登记 pending records。
3. pending records 全部落盘成功后，再启动 / 调度 sideDialog drive。
4. 如果登记阶段失败，整轮 loud fail，不能进入半登记半启动状态。
5. 回复到达时只看 `callingCourse + callingGenseq` 这一组是否清空。

不引入 wait-group sealed marker。sealed marker 只是为了兼容“边登记边启动”的中间态；两阶段登记直接消灭这个中间态，概念更少。

注意：不是所有 special call 都会 pending，例如参数错误、目标不存在、FBR disabled、Q4H。两阶段只覆盖“确认会创建 pending sideDialog”的 tellask / FBR 类调用。Q4H 仍是独立硬阻塞。

### 7.2 Type B registered Side Dialog update 与 replace pending

长线诉请同一 `agentId!sessionSlug` 被新 asker / 新 call 更新时，不能再把“注册支线被更新”粗暴理解为“替换槽位”。reply obligation 是栈，Type B registered Side Dialog update 分两类：

1. **普通新诉请 / 新 asker / 新 call**：把新 asker frame push 到栈顶。新诉请优先处理；回复后 pop，恢复更早的 asker frame。
2. **replace pending 特殊操作**：明确定位被替换的旧 pending / old frame，把旧 asker obligation 从栈中抽调，再把新 obligation push 到栈顶。

replace pending 不是 silent overwrite，也不是 failed-result fallback。它是显式栈操作：

- 定位旧 frame 的匹配键必须稳定，倾向使用 `askerDialogId + targetCallId` / `ownerDialogId + callId`，具体以 pending record 与 reply directive 对齐后的字段为准；
- 如果 replace 找不到旧 frame，必须 loud fail，不允许降级成普通 push；
- 因为持久文件采用 append/truncate-only JSONL，replace 的落盘算法是：
  1. 读取 stack frames 与每行 byte offset；
  2. 找到 old frame；
  3. truncate 到 old frame 之前；
  4. 将 old frame 之后仍有效的 frames 按原顺序重新 append；
  5. append 新 frame 到栈顶；
  6. pending records 与 asker stack 必须在同一业务事务边界内更新，失败 loud fail。

这样既保留“抽掉旧义务”的业务语义，也让持久层维持 append/truncate-only，不做 YAML 数组整体覆盖。

### 7.3 Reply tool 与 direct fallback

`replyTellask*` 是精确回贴路径；direct fallback 是过渡兼容路径。

重构后：

- arrival fact 应记录 delivery mode；
- direct fallback 文案仍需显式标注；
- 但 wait-group 与上下文时序不应因 delivery mode 不同而分叉。

### 7.4 Context window 规则

Dominds 不做同 course 内 context window 裁剪。上下文规则是：

- 最新 course 全量进入 LLM context；
- 历史 course 永不进入 LLM context。

因此 pointer 只会遇到两种情况：

- 原 call 与 arrival fact 都在 latest course：pointer 指向后续同 `callId` 的 arrival fact；
- 原 call 所在 course 已不是 latest course：latest course 注入自包含 carryover fact，pointer 指向该 carryover fact。

不定义“同 course 可见性修复”文案或 record。

### 7.5 `asker-stack.jsonl` 与 reply obligation stack

`tellaskReplyDirective` 不应作为 JSONL 对话历史里的“上一条 runtime prompt 附带信息”来恢复。它描述的是当前 dialog 仍未结清的回复义务，生命周期属于运行时对话状态，而且必须跨 course 存活。

定案：

- main / side dialog 统一使用 `asker-stack.jsonl`，不再拆分旧 `supdialog.yaml` 与旧 `reply-obligations.yaml`。
- `asker-stack.jsonl` 是单文件 JSONL stack：一行一个 `AskerDialogStackFrame`，落盘操作只允许 append / truncate。
- 不使用 YAML 数组字段表达 stack；字段数组会让“栈”退化成可整体覆盖的状态槽。
- 不采用 multi-doc YAML。JSONL 更适合 append/truncate、byte offset truncate、行级 quarantine 诊断，也更贴合 TS 结构化类型。

内容保持 mean & lean：

```jsonl
{"kind":"asker_dialog_stack_frame","askerDialogId":"<asking-dialog-id>","assignmentFromAsker":{"callName":"tellask","mentionList":["@agent"],"tellaskContent":"...","originMemberId":"...","callerDialogId":"<same-as-askerDialogId>","callId":"...","collectiveTargets":["..."]},"tellaskReplyObligation":{"expectedReplyCallName":"replyTellask","targetDialogId":"<asking-dialog-id>","targetCallId":"...","tellaskContent":"..."}}
{"kind":"asker_dialog_stack_frame","askerDialogId":"<ask-back-asker-dialog-id>","tellaskReplyObligation":{"expectedReplyCallName":"replyTellaskBack","targetDialogId":"<ask-back-asker-dialog-id>","targetCallId":"...","tellaskContent":"..."}}
```

规则：

- `AskerDialogStackFrame.askerDialogId` 是当前 reply obligation 要回复的 asker dialog。
- `assignmentFromAsker` 只存在于 assignment frame；`replyTellaskBack` frame 可以只有 asker 与 reply obligation。
- `askerStack` 是运行时内存表示；持久化文件是 `asker-stack.jsonl`，不是 `{ askerStack: [...] }`。
- 栈顶 frame 决定当前 effective asker dialog；side dialog 的 `askerDialog` 必须按栈顶动态解析。
- 当前 assignment 取“从栈顶向下最近的 assignment frame”，这样 `replyTellaskBack` 临时 frame 不会破坏原 assignment 恢复。
- Type B registered Side Dialog 普通 update push 新 frame 到栈顶；新诉请先处理，回复后 pop，恢复更早的 asker frame。
- replace pending 走 7.2 的抽调旧 frame + append 新 frame，不走普通 push。
- `tellaskBack` 也是同一种 push：被回问的 tellasker dialog 把 `replyTellaskBack` obligation 压到自己的 asker stack 栈顶，回复后 pop。
- 成功 `replyTellask*` 或 direct fallback 结清栈顶 `targetCallId` 后 pop 栈；不再靠“清空单槽字段”表示已结清。
- LLM context 不再靠扫描历史 JSONL prompt 恢复 reply directive；最新 course 组装上下文时从回复栈顶读取 active obligation，并以 role=user 的运行时环境信息注入。

### 7.6 术语升级：root/sub/sup -> main/side/asker

本重构同步升级实现者语境术语，让实现者语境与使用者语境更一致，减少“上下级”误读。参考 `docs/dominds-terminology.md`：

- 旧 `RootDialog` -> `MainDialog`
- 旧 `SubDialog` / `Subdialog` -> `SideDialog`
- 旧 `rootDialog` 局部变量、方法名、类型名 -> `mainDialog`
- 旧 `subdialog` 局部变量、方法名、类型名、测试名 -> `sideDialog`
- 旧 `supdialog` / `supdialogId` -> `askerDialog` / `askerDialogId`
- 旧 `assignmentFromSup` -> `assignmentFromAsker`
- 旧 `supInfo` -> `askerStack`
- 旧 `SubdialogSupdialogStackFrame` -> `AskerDialogStackFrame`
- 旧 `quest_for_sup_record` -> `sideDialog_request_record`
- 旧 `supdialog.yaml` / `reply-obligations.yaml` -> `asker-stack.jsonl`

边界：

- `DialogID.rootId` 仍是结构性 storage anchor，可后续单独评估是否改成 `mainId`。本轮优先改 dialog 类名、reply obligation 语义名、运行时字段名、测试名与文档术语。
- wire/storage 事件名若仍带旧 `subdialog_*`，本轮应一并评估并尽量升级；如果某个外部协议字段暂不改，必须在最后汇报为明确遗留，而不是默默保留。
- 用户可见文案继续使用“主线对话 / 支线对话、诉请者 / 被诉请者”；不暴露 `askerDialog` 这类实现字段名。

### 7.7 术语升级补充：tellasker/tellaskee、asker、responder、caller 分层

上一轮扫尾中过度使用了通用 `requester / responder`，会稀释 Dominds Tellask 的专有语义，也会和 `Dialog Responder / 对话主理人` 发生碰撞。本重构后续统一采用以下分层：

1. **Tellask 语义层 / 面向模型与用户的协作说明**：
   - EN: `tellasker` / `tellaskee`
   - ZH: `诉请者` / `被诉请者`
   - 含义：一次 Tellask 中发起诉请的一侧与承接诉请的一侧。
   - 替换原则：tellask 关系里的 `requester / responder` 应升级为 `tellasker / tellaskee`；中文继续用 `诉请者 / 被诉请者`，不写成“诉请者对话 / 被诉请者对话”作为标准术语。

2. **Dialog execution role / 对话执行角色**：
   - EN: `Dialog Responder`
   - ZH: `对话主理人`
   - 含义：负责推进某个 dialog 的 agent / role。
   - 边界：这里的 `responder` 保留且是标准词；不得把它和 Tellask 的 `tellaskee` 合并。

3. **实现层关系字段 / 持久化与路由语义**：
   - EN: `asker`
   - ZH: 实现层可解释为“诉请方关系”，但代码优先使用英文。
   - 标准项：`askerDialog`、`assignmentFromAsker`、`askerStack`、`AskerDialogStackFrame`。
   - 替换原则：tellask / sideDialog 关系里的旧 `caller` 应升级为 `asker`，例如后续可评估 `callerDialogId` -> `askerDialogId`、`CallerCourseNumber` -> `AskerCourseNumber`；内部函数名可直接升级，例如 `supplySideDialogResponseToAssignedCallerIfPendingV2` -> `supplySideDialogResponseToAssignedAskerIfPendingV2`。旧 `callee*` / `responder*` contract 字段应升级为 `tellaskee*`，但必须作为 wire/storage 成组迁移。

4. **通用代码调用方 / 非 Tellask 语义**：
   - EN: `caller`
   - 含义：函数调用者、tool caller、log caller location、普通 API 调用方。
   - 边界：这类 `caller` 不参与 tellask 术语升级，不应机械改成 `asker`。

执行顺序：

- 先更新 `dominds-terminology.md`，把 `tellasker/tellaskee` 与 `Dialog Responder` 的边界定为标准术语；
- 再扫 docs / prompt / UI 文案：Tellask 关系用 `tellasker/tellaskee`，Dialog 主理角色保留 `Dialog Responder`；
- 最后扫实现层：只把 Tellask relationship contract 里的 `caller` 改成 `asker`，保留普通编程调用方的 `caller`。
- 若某个 `caller*` 是 wire/storage 字段或 URL/deeplink contract，必须作为 contract rename 成组处理并补测试，不做零散替换。

## 8. 初步实施切分

### Phase 1：文档与术语收敛

- 明确 wait-group、arrival fact、pointer result、carryover fact 的语义。
- 确认最终中文文案。
- 固化 `asker-stack.jsonl`、`AskerDialogStackFrame`、replace pending 栈操作、`MainDialog` / `SideDialog` 术语升级细目。
- 再补英文文档与 formatter 文案。

### Phase 2：存储与 contract

- `PendingSideDialogStateRecord` 强化 `callingCourse/callingGenseq`。
- 新增统一 `asker-stack.jsonl`，root 与 side dialog 都用同一 stack 文件。
- `asker-stack.jsonl` 只允许 append/truncate；replace pending 通过 truncate + replay retained frames + append new frame 表达。
- 删除旧 `supdialog.yaml` / `reply-obligations.yaml` 分叉模型。
- 新增 reply arrival record / event。
- 新增 call-site pending / pointer formatter。
- priming、fork、replay、恢复路径按新 contract 同步；不兼容旧 `.dialogs/`。

### Phase 3：context projection

- 替换原位补真实 result 的逻辑。
- 原 call 位置投影 pending / pointer result。
- arrival / carryover fact 进入模型上下文。

### Phase 4：revive gate

- 同一 function round 的 pending sideDialogs 先两阶段登记，再启动 sideDialog drive。
- 引入 wait-group scoped revive entitlement。
- 修改 preflight suspension 判断。
- 确保 display state 与 reminder 不被误清。

### Phase 5：UI 与回归

- UI tellask 回复气泡对齐 canonical payload。
- 增加回归：
  - 同 genseq 多 tellask 等齐才 revive；
  - 不同 genseq 回复各自 revive；
  - 跨 course carryover 自包含；
  - `asker-stack.jsonl` 中 reply obligation stack 跨 course 存活并在结清后 pop；
  - replace pending 从 stack 中抽调旧 frame，再把新 obligation 压栈顶；
  - 原 call site 只出现 pointer，不出现真实回复正文；
  - Type B registered update 压栈、先回复新诉请、再恢复旧诉请；
  - 重启恢复后 pending 与 arrival fact 一致。

## 9. 已定案问题

本轮已定案：

1. Call-site pending / pointer result 的中文标签统一使用 `[Dominds 诉请状态]`。
2. Arrival / carryover fact 正文必须显式列 `callId`；它是 LLM 可追踪锚点，不只是结构化元数据。
3. Dominds 不做同 course context window 裁剪；最新 course 全量进 LLM context，历史 course 永不进 context。因此不定义“同 course 上下文补入 / 可见性修复”文案。
4. 多 tellask / FBR pending 登记与启动拆成两阶段：先登记全部 pending records，全部落盘成功后再启动 sideDialog drive。不引入 sealed marker。
5. 旧 pending record 缺少 `callingCourse` / `callingGenseq` 不迁移、不隔离兼容、不 fallback。旧 `.dialogs/` 可丢弃；新 validator 直接要求必填，缺失即 loud fail / quarantine。
6. reply obligation 是栈，不是槽。root 与 side dialog 统一使用 `asker-stack.jsonl` 持久化 `AskerDialogStackFrame`，文件只允许 append/truncate。LLM context 从栈顶注入当前义务，而不是扫描历史 JSONL 对话。
7. replace pending 是特殊栈操作：抽调旧 frame，再把新 obligation 压到栈顶；找不到旧 frame 必须 loud fail，不能静默 fallback 成普通 push。
8. 实现术语升级为 `MainDialog` / `SideDialog` / `askerDialog` / `assignmentFromAsker` / `askerStack`。旧 `supdialog` 术语退出实现代码与文档；用户可见文案继续使用“主线对话 / 支线对话、诉请者 / 被诉请者”。
