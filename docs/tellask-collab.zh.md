# Tellask 协作最佳实践（草案）

英文版：[English](./tellask-collab.md)

> 状态：Draft  
> 语义基线：本文以当前实现为准；“建议/规划”会单独标注。

## 1. 为什么写这份文档

`Tellask` 已经是 Dominds 的核心协作机制，但“能用”不等于“用顺”。当前最常见的卡点不是语法错误，而是**协作节奏误判**：

- 诉请者收到阶段性回贴后，误以为被诉请者还在后台继续执行最初诉请。
- 诉请者口头描述“下一步该谁做什么”，却没有真的发出下一轮诉请。

这两个问题会把协作拖进“看似推进、实则停滞”的状态。

本文目标：

- 讲清当前已经实现的 tellask 运行时语义（避免心智模型漂移）。
- 给出可直接执行的协作最佳实践。
- 针对上述停滞问题，给出“快速且根本”的改进方向，优先考虑 priming + 系统提示。

---

## 2. 当前机制现状（已实现）

以下内容是**当前代码与文档已实现**的行为约束（见 `dialog-system.zh.md`、`fbr.zh.md`、`diligence-push.zh.md`）。
`dominds-agent-priming.zh.md` 仅保留对旧 priming 实现的移除说明和后续“启动脚本回放”重构方案。

### 2.1 Tellask 三形态

- `TellaskBack`（回问诉请）：`tellaskBack({ tellaskContent: "..." })`，用于向诉请者回问澄清。
- `Tellask Session`（长线诉请）：`tellask({ targetAgentId: "<teammate>", sessionSlug: "<slug>", tellaskContent: "..." })`，可恢复上下文的多轮协作。
- `Fresh Tellask`（一次性诉请）：`tellaskSessionless({ targetAgentId: "<teammate>", tellaskContent: "..." })`，一次性、不可恢复。

### 2.2 `Tellask Session` 的真实语义

- `sessionSlug` 的作用是“会话寻址 + 历史复用”。
- 它**不是**“后台持续执行开关”。
- 同一个 `<slug>` 下，每一次新任务推进，仍然需要新的 `tellask* function call` 诉请触发。

一句话：`Session` 是“可续接的对话容器”，不是“会自动前进的后台 worker”。

### 2.3 每次诉请调用的生命周期

对诉请者来说，一次队友诉请的运行时节奏是：

1. 发出 `tellaskSessionless({ targetAgentId: "<teammate>", tellaskContent: "..." }) ...`。
2. 当前对话进入挂起/等待（pending subdialogs）。
3. 被诉请者完成本轮驱动并回贴结果。
4. 诉请者恢复继续。

关键事实（与停滞问题直接相关）：

- 当前 `teammate_response` 语义只有 `completed` / `failed`，没有“后台仍执行中”的第三态。
- 因此，“收到阶段性回贴”在协议上等价于“这一轮诉请已结束，是否继续要由诉请者显式发起下一轮”。

### 2.4 Diligence Push 的边界

- Diligence Push 会鞭策诉请者对话继续思考和推进。
- 它不负责自动补发队友诉请，也不改变 tellask 的调用生命周期。
- 所以它能缓解“发呆”，但不能根治“口头安排不落地”的协作停滞。

---

## 3. 主要问题与根因

### 3.1 主要问题：阶段性回贴后误判执行状态

表象：

- 诉请者对话收到“阶段 1 完成”的反馈后，写下“等待对方继续执行”，但没有再次诉请。
- 实际上队友对应支线已结束，系统也没有自动继续执行原诉请。

根因：

- 智能体把“会话连续性”误读成“执行连续性”。
- 即：把“同一 tellaskSession 能续聊”误解为“同一 tellaskSession 会继续干活”。

### 3.2 后备问题：会说下一步，不会立即执行下一步

典型坏味道：

- “我没有 shell 权限，请你让 @<shell_specialist> 执行 `pnpm lint:types` 并回贴。”

这里真正缺的不是知识，而是动作闭环：该发诉请时没发诉请。

---

## 4. 最佳实践（立即可执行）

### 4.0 交付标记与支线规则（强制）

**首行标记（强制）**：

- `【tellaskBack】` — 回问诉请者对话时必须使用（首行）。
- `【最终完成】` — 完成全部目标后的最终交付（首行）。
- FBR 专用：`【FBR-直接回复】` 或 `【FBR-仅推理】`。

**支线交付规则**：

- 只有当所有目标完成时，支线对话才可直接回贴诉请者对话。
- 若任何目标未完成或关键信息缺失，必须先用 `tellaskBack({ tellaskContent: "..." })` 回问诉请者对话再继续。
- **FBR 例外**：FBR 禁止任何诉请（包括 `tellaskBack` / `askHuman`）；只列缺口 + 推理与摘要并直接回贴。

说明：不需要额外的 “Status: …” 行；首行标记即为阶段提醒。

### 4.1 协作阶段协议（Teammate Tellask 版）

对**队友诉请（非 `freshBootsReasoning({ tellaskContent: "..." })`）**，统一执行四段协议：

1. `发起`：明确目标、约束、验收口径，发出 `tellask* function call`。
2. `等待`：等待本轮回贴，不预设对方会自动继续。
3. `判定`：回贴到达后判断“已达成 / 未达成 / 需澄清”。
4. `续推`：若未达成，立即发下一轮诉请（通常沿用同一 `sessionSlug`）。

强约束：

- 任何“等待结果/等待回贴”表述，必须能指向**刚刚已发出的具体诉请**与**等待的验收证据**。
- 若没有已发出的待回贴诉请，就不能写“等待”；应立刻发诉请或改为本地执行。

### 4.2 续推时必须显式“再诉请”

推荐写法：

```text
tellask({
  targetAgentId: "shell_specialist",
  sessionSlug: "typecheck-loop",
  tellaskContent: [
    "执行 `pnpm lint:types`，仅回贴原始输出。",
    "若失败：只列前 3 个错误（含文件路径与行号），并给出你建议先处理的 1 个错误。",
    "验收：我需要看到命令退出码与首个错误锚点。",
  ].join("\n"),
})
```

反例（禁止）：

```text
我先等 @shell_specialist 继续跑下一步。
```

### 4.3 “口头转派”改成“直接诉请”

反例（会停滞）：

```text
我没有执行 shell 权限，需要你让 @shell_specialist 执行 `pnpm lint:types`。
```

正例（自主闭环）：

```text
tellask({
  targetAgentId: "shell_specialist",
  sessionSlug: "typecheck-loop",
  tellaskContent: [
    "请立即执行 `pnpm lint:types` 并原样回贴结果。",
    "若命令不存在，回贴错误并给出本仓可行替代命令。",
  ].join("\n"),
})
```

---

## 5. 快速根治路径：Priming + 系统提示

仅靠“提醒一句”通常不够。建议把根治拆成两层：

- 第一层：系统提示加硬约束（立刻见效）。
- 第二层：协作 priming 建立“本能体感”（长期稳态）。

### 5.1 系统提示改进（建议 P0）

建议新增/强化以下约束卡片（中英文各自母语撰写）：

1. `回贴终止约束`  
   对队友 tellask 而言，收到回贴即表示该轮调用结束；若要继续推进，必须显式再发一轮 tellask。
2. `等待声明约束`  
   只有当存在明确 pending tellask 时，才可声明“等待中”；否则必须执行下一动作。
3. `自主执行约束`  
   能通过队友 tellask 完成的执行动作，不得转交给 askHuman() 当“转发员”。
4. `动作优先约束`  
   当你写“下一步让 @X 做 Y”时，应在同一回复内直接给出 `tellaskSessionless({ targetAgentId: "X", tellaskContent: "..." })`。

### 5.2 协作 Priming 改进（P1）

把“诉请协作节奏”拆成两段短演练，并都落在可复现事实上：

1. 一次性诉请：`uname -a`（环境基线）。
2. 长线诉请：`tellaskSession: rtws-vcs-inventory` 两轮盘点仓库现状。
3. 在两段证据都到位后，再进入 `freshBootsReasoning({ tellaskContent: "..." })` FBR 和综合提炼。

关键原则：

1. 无可用 `shell_specialist` 时，由 Dominds 运行时采集同样事实（`uname -a` + git 盘点），这是标准模式，不是降级。
2. 回贴即本轮结束；要继续必须显式发起下一轮诉请。
3. “让队友做”必须直接落成 `tellask* function call`，不能转交 askHuman() 当转发员。

### 5.3 P1 设计基线（当前实现）

#### 设计目标

1. 短：新增流程集中在 `uname` + 两轮 VCS 盘点，不引入长提示词。
2. 普适：任何 rtws 都能执行（是否有 shell 专员都可跑通）。
3. 稳：关键步骤由运行时模板驱动，降低模型自由发挥漂移。
4. 准：通过真实两轮诉请建立“回贴收束、续推再诉请”的行为记忆。

#### 统一时序

1. `Prelude Intro`：声明 shell 策略（`specialist_only` / `self_is_specialist` / `no_specialist`）。
2. `uname` 基线：
   - `specialist_only`：诉请者对话 `tellaskSessionless({ targetAgentId: "<shell_specialist>", tellaskContent: "..." })` 发一次性诉请并接收回贴。
   - 其他两种策略：运行时采集并显示 `uname -a`。
3. `VCS Round-1`（同一 `tellaskSession`）：确认 rtws 拓扑
   - 根路径是否 git repo
   - submodule 列表
   - 子目录独立 repo 列表
4. `VCS Round-2`（同一 `tellaskSession` 的续推）：逐 repo 确认
   - remote（fetch/push）
   - branch / upstream
   - dirty 状态
5. 汇总 `uname + VCS` 作为同一份环境证据，发起 `freshBootsReasoning({ tellaskContent: "..." })` FBR。
6. 收齐 FBR 回贴后做 distillation，产出 priming note。

#### 诉请模板约束

1. Round-1/2 tellask body 由运行时模板生成。
2. Round-2 正文必须显式写明“Round-1 已结束，本轮是新的续推诉请”。
3. 每轮只做单一目标，不夹带修复方案或扩展性任务。

#### 无 shell 专员场景（标准模式）

1. 运行时直接给出 `uname` 与两轮 VCS 盘点文本。
2. FBR 使用与 shell 专员路径同结构的信息（不缩水，不伪造队友回贴）。
3. priming note 语义要求完全一致：回贴收束 + 续推再诉请。

#### 数据结构（旧实现）

1. `shell` 使用判别联合：
   - `specialist_tellask`（含诉请正文、回贴、`uname` 快照）
   - `direct_shell`（运行时说明 + `uname` 快照）
2. `vcs` 使用判别联合：
   - `specialist_session`（两轮 tellask/response + `inventoryText`）
   - `runtime_inventory`（两轮 runtime note + `inventoryText`）
3. `buildCoursePrefixMsgs` 注入顺序固定为：shell 快照 → VCS 盘点 → FBR 摘要 → priming note。

#### 验收标准（P1 最小可用）

1. priming 实录可见：`uname` 基线 + VCS 两轮（Round-2 晚于 Round-1 回贴）。
2. 无 shell 专员时仍可看到两轮 VCS runtime 盘点，且用于同一轮 FBR。
3. priming note 明确写出“回贴=本轮结束；继续=再诉请”。
4. replay 可复现对应路径（`specialist_session` 或 `runtime_inventory`）。
5. `pnpm -C dominds run lint:types` 通过，且不破坏现有 priming/FBR/diligence 约束。

---

## 6. 面向诉请者对话主理人的协作清单

每次协作循环前后，快速自检：

1. 我这轮是否已经发出明确 tellask（有目标、约束、验收）？
2. 我现在说“等待”时，是否真有 pending tellask 对应？
3. 回贴到达后，我是否做了“判定 + 下一轮诉请/本地动作”？
4. 我是否把“让队友做”落成了真实 `tellask* function call`，而不是口头转派给 askHuman()？
5. 关键决策是否已写回 Taskdoc（仅根对话）而不是只留在聊天里？

---

## 7. 后续落地建议

建议按优先级推进：

1. `P0`：更新系统提示中的协作硬约束（先把明显停滞压下去）。
2. `P1`：增加 tellask-collab priming（建立“回贴即收束、续推要再诉请”的本能）。
3. `P2`：补回归用例，重点覆盖：
   - 收到阶段性回贴后能否自动补发下一轮诉请；
   - 是否还会出现“请人类转发给队友执行”的停滞话术。

这三步结合后，diligence push 才会成为“锦上添花”，而不是“替代执行”的补丁。
