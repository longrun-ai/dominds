# Drive 逻辑上下文拼装现状与重构计划（2026-02）

状态：Draft  
语义基线：以 `dominds/main/llm/driver.ts` 与 `dominds/main/persistence.ts` 当前实现为准。

## 1. 背景与目标

近期在对话 `@ux (39/12/417f4a49)` 中暴露出一个上下文一致性问题：同一主线对话内已经收到了 `@cmdr/@browser_tester` 的回贴并据此更新 Taskdoc，但后续回复仍声称“没看到原始回贴文本”。

这类问题的根因不是单条提示词，而是 **drive 内多轮生成的上下文来源语义不统一**：有的上下文是持久消息（`dlg.msgs`），有的是一次性注入（仅首轮），还有的是消费队列（take/commit/rollback）。

本文目标：

1. 固化“当前代码结构现状”的可审计视图。
2. 记录本轮已做的修补。
3. 制定一次更大范围的 drive logic 重构计划，使后续维护更清晰、不易回归。

## 2. 当前结构（代码现状）

### 2.1 核心文件与职责

- `main/llm/driver.ts`
  - `_driveDialogStream()`：单次 drive 主循环，负责 prompt 处理、上下文拼装、LLM 调用、工具调用、suspend/continue。
  - `supplyResponseToSupdialog()`：子对话回贴写入父对话响应队列、更新 pending、触发 auto-revive。
- `main/persistence.ts`
  - `takeSubdialogResponses()/commitTakenSubdialogResponses()/rollbackTakenSubdialogResponses()`：子对话回贴队列的“取走-提交/回滚”机制。
  - `rebuildFromEvents()`：重建 `dlg.msgs`（包含 `teammate_response_record -> tellask_result_msg` 映射）。
- `main/dialog.ts`
  - `addChatMessages()`：运行时消息容器（in-memory）。

### 2.2 当前上下文来源（进入 LLM 的入口）

在 `_driveDialogStream()` 中，每轮 gen 的 `ctxMsgs` 由以下部分拼装：

1. `prependedContextMessages`（策略注入）
2. `memories`
3. `taskDocMsg`
4. `coursePrefixMsgs`
5. `dialogMsgsForContext`（来自 `dlg.msgs`）
6. `subdialogResponseContextMsgs`（来自 `takeSubdialogResponses` 的注入）
7. `internalDrivePromptMsg`（internal prompt 注入）
8. reminders + language guide（末尾插入）

要点：`dlg.msgs` 是“稳定上下文”；队列/内部 prompt 属于“drive 级上下文”。

## 3. 本轮修补（已落地）

### 3.1 已修问题

1. **同一 drive 多轮丢失 teammate response 上下文**
   - 修复：把 `takeSubdialogResponses` 生成的 `subdialogResponseContextMsgs` 在同一 drive 内跨迭代保留，而非仅 `genIterNo===1` 注入。

2. **中断时误 commit 已 take 队列**
   - 修复：在 interrupted 分支标记 `generationHadError = true`，确保 finally 走 rollback，不会把未稳定消费的队列当作已消费。

3. **internal prompt 语义收敛为 drive 级 priming**
   - 修复：移除生命周期分支；`persistMode='internal'` 统一为 drive-scoped priming 注入。
   - 语义：仅在当前 drive 生效、不入 `dlg.msgs`、不持久化、不渲染 UI。
   - 依据：当前唯一使用场景是 Agent Priming，且明确要求 loop 迭代中持续可见。

4. **teammate response 稳定化到 `dlg.msgs`（与工具结果语义对齐）**
   - 修复：当 take/commit 成功后，把该批回贴镜像为 `tellask_result_msg` 写入 `dlg.msgs`，让后续 drive 不依赖一次性队列注入。

5. **队列记录补齐状态字段**
   - 修复：`subdialog-responses` 记录新增可选 `status`（`completed|failed`），并在镜像消息时使用该状态（默认 `completed`）。

## 4. 仍存在的结构债务

### 4.1 状态语义分散

同一类“队友回贴事实”同时存在于：

- `teammate_response_record`（事件持久层）
- `subdialog-responses.json`（消费队列）
- `dlg.msgs`（运行时上下文）

缺少单一“源事实 -> 视图派生”的规范，维护成本高。

### 4.2 拼装流程耦合过深

`_driveDialogStream()` 同时承担：

- prompt 生命周期管理
- 上下文装配
- policy 校验
- 流式/非流式分支
- 工具调用循环
- suspend/revive 与队列提交事务

单函数职责过重，不利于做语义回归验证。

### 4.3 缺少针对性回归测试矩阵

现有 tellask 测试覆盖“auto-revive 能跑通”，但对以下关键边界覆盖不足：

- 同一 drive 的多轮迭代上下文一致性
- interrupted + take queue 的 rollback 语义
- committed queue 镜像到 `dlg.msgs` 后的去重/恢复语义

## 5. 语义决策记录（本轮确认）

1. `persistMode='internal'` 不是“下一轮临时补丁”，而是 **drive 级 priming 通道**。
2. 当前无 `next_gen` 真实业务需求，先不保留该分支，避免语义包袱。
3. 如未来出现单轮内部提示需求，新增能力应基于明确场景和回归测试，不提前抽象。

## 6. Priming 重点支持目标

本次重构把 Agent Priming 作为第一优先级目标，不再作为“顺带兼容”。

### 6.1 Priming 对 drive 的硬需求

1. Priming 使用的临时引导 prompt 只作用于当前 drive。
2. 在同一 drive 的多轮迭代中（工具调用、context remediation、continue）必须持续可见。
3. 该 prompt 不进入 `dlg.msgs`，不写事件，不落盘，不渲染 UI。
4. drive 中断/失败后不得残留到下一次 drive。

### 6.2 Priming 支持实现（简化方案）

核心原则：**不做通用“多生命周期临时 prompt 框架”，只保留 drive 级 priming 通道**。

1. 在新 driver 中把 priming 输入建模为单一字段：`internalDrivePrimingMsg?: ChatMessage`。
2. 上下文装配时固定规则：每轮迭代都在末尾注入 `internalDrivePrimingMsg`。
3. 通过 driver 生命周期自然回收：drive 结束即销毁，不做额外状态机。
4. 仅保留 `persistMode='internal'` 这一种 priming 入口，不再引入 `next_gen`/scope 分叉。

这样可以把 priming 需求落实为“一个字段 + 一条注入规则”，实现面最小化。

## 7. 两阶段重构计划（按新模块重写）

### 阶段 1：新建并上线 `driver-v2`，旧模块原样保留

目标：在新模块里重写 drive 逻辑，旧 `driver.ts` 保持原样，便于并排对比与问题定位。

交付物：

1. 新模块（建议）：
   - `main/llm/driver-v2/index.ts`（对外入口）
   - `main/llm/driver-v2/context.ts`（上下文装配，含 priming 注入）
   - `main/llm/driver-v2/subdialog-txn.ts`（take/commit/rollback 事务）
   - `main/llm/driver-v2/round.ts`（单轮生成与 side effects）
2. 保持旧模块文件不动：
   - `main/llm/driver.ts` 继续存在，作为对照基线。
3. 切换方式：
   - 通过单点入口切换到 v2（建议配置开关或固定切换点），避免多处散改 import。
4. Priming 专项支持：
   - v2 内置 `internalDrivePrimingMsg` 注入规则（每轮注入、drive 内有效、绝不持久化）。
5. 关键回归与复放：
   - `multi-iter subdialog response`
   - `interrupt rollback`
   - `commit mirror to dlg.msgs`
   - `no duplicate after restore`
   - `internal drive priming persists across iterations`
   - 复放 `39/12/417f4a49` 风格样本

阶段 1 验收门槛：

1. `pnpm -C dominds run lint:types` 通过。
2. tellask 相关回归通过。
3. priming 专项回归通过。
4. 对比旧 driver，关键语义一致且已知 bug 被修复。

### 阶段 2：v2 稳定后删除旧模块并清理

目标：确认 v2 可稳定替代后，删除旧逻辑，收敛维护面。

交付物：

1. 删除旧 `driver.ts` 中被 v2 覆盖的实现（或将其瘦身为转发壳并最终移除）。
2. 清理迁移期开关、对照代码、过渡注释和 dead code。
3. 固化最终文档：
   - 新 driver 模块边界
   - priming 通道语义
   - 事务边界与错误处理约束

阶段 2 验收门槛：

1. 全量类型检查与回归通过。
2. 无旧模块引用残留（import/调用链清零）。
3. 行为与阶段 1 上线结果一致。

## 8. 目标接口草案（v2，简化版）

```ts
type DriveV2Input = {
  persistedPrompt?: HumanPrompt; // 常规用户输入（会持久化）
  internalDrivePrimingMsg?: ChatMessage; // 仅 drive 内可见
  skipTaskdoc?: boolean;
};

type DriveV2Runtime = {
  takenSubdialogResponses: TakenSubdialogResponse[];
  generationAttempted: boolean;
};
```

说明：

1. priming 只保留 `internalDrivePrimingMsg` 一条路径。
2. 不提供“下一轮临时注入”接口，避免再次引入语义分叉。
3. 所有持久化副作用统一在编排层执行，不放进上下文纯函数。

## 9. 重构约束（必须保持）

1. 不改变现有 wire 协议事件名与基础语义（除非显式版本升级）。
2. 不引入 silent fallback；上下文事务异常需 loud 日志与可见错误信号。
3. 保持 TypeScript strict 与可静态验证属性；禁止 `any`。
4. 旧模块在阶段 1 必须原样保留，便于对照和回滚。

## 10. 现有测试合理性评估（针对 dlg drive）

结论：**现有测试有价值，但覆盖面不足以支撑 driver 重写上线**。

### 10.1 现有测试的合理性（优点）

1. 以脚本方式在临时 rtws 跑通关键链路，具备真实文件系统与持久化路径，能抓到不少“运行态”问题。
2. 已覆盖部分核心行为：
   - tellask 解析/流式解析稳定性
   - root auto-revive 基础路径
   - type B 注册去重基础路径
   - diligence push/Q4H 的部分事件行为
3. 执行成本低，适合快速 smoke。

### 10.2 关键缺口（本次 v2 必补）

1. 没有 Agent Priming 专项测试。
   - 当前没有测试断言 internal drive prompt 在“多轮迭代中持续可见且不持久化”。
2. queue 事务边界覆盖不完整。
   - 缺少“take 后 interrupted/error 必 rollback”的端到端断言。
   - 缺少“commit 后镜像到 `dlg.msgs` 且后续不重复注入”的断言。
3. 缺少 restore/live 等价性断言。
   - 没有明确验证 `rebuildFromEvents` 与 live 路径在 teammate response 上下文层等价。
4. 缺少对“同一 drive 多轮（工具回合）上下文连续性”的精确断言。
5. 缺少新旧 driver 的并排一致性对照测试。
   - 阶段 1 保留旧模块的价值尚未转化为自动化对照。

## 11. v2 测试设计与上线门禁

### 11.1 分层策略

1. L0 单元层（纯逻辑，零 I/O）
   - 目标：验证 v2 新模块内部规则和数据变换。
   - 关注：context 装配顺序、priming 注入规则、txn 状态机。
2. L1 集成层（临时 rtws + mock provider）
   - 目标：验证 drive 主链路和持久化副作用。
   - 关注：take/commit/rollback、auto-revive、runState、event 语义。
3. L2 对照/复放层（v1 vs v2）
   - 目标：验证重写后与既有正确语义一致，且已知 bug 被修复。
   - 关注：同输入下关键输出等价、上下文可见性不回退。

### 11.2 v2 必做用例（最小集）

1. `driver-v2/internal-drive-priming-multi-iter.ts`
   - 断言：priming 提示在同一 drive 第 1/2/3 轮均可见。
   - v1 状态：可跑；已实现并通过（2026-02-09）。
2. `driver-v2/internal-drive-priming-not-persisted.ts`
   - 断言：priming 不进入 `dlg.msgs`、不写 events、不落盘。
   - v1 状态：可跑；已实现并通过（2026-02-09）。
3. `driver-v2/internal-drive-priming-no-leak-next-drive.ts`
   - 断言：drive 结束后 priming 不泄漏到下一次 drive。
   - v1 状态：可跑；已实现并通过（2026-02-09）。
4. `driver-v2/subdialog-queue-interrupt-rollback.ts`
   - 断言：take 后 interrupted/error 必 rollback，下一次 drive 可重见。
   - v1 状态：可跑；已实现并通过（2026-02-09）。
5. `driver-v2/subdialog-queue-commit-mirror.ts`
   - 断言：成功 commit 后镜像到 `dlg.msgs`，后续不依赖队列注入。
   - v1 状态：可跑；已实现并通过（2026-02-09）。
6. `driver-v2/subdialog-restore-live-equivalence.ts`
   - 断言：restore 路径与 live 路径对 teammate response 的上下文等价。
   - v1 状态：可跑；已实现并通过（2026-02-09）。`restoreDialogHierarchy(rootId, status)` 需由调用方显式传入状态。
7. `driver-v2/multi-iter-tool-round-context-continuity.ts`
   - 断言：工具回合 continue 后，前序关键上下文不丢失。
   - v1 状态：理论可在 `script-rtws + mock provider` 落地；当前未实现。
8. `driver-v2/v1-v2-parity-basic-tellask.ts`
   - 断言：同 mock 输入下，v1/v2 在可观察语义上等价（除已知 bug 修复差异）。
   - v1 状态：需 v2 模块后才有对照意义；当前未实现。
9. `driver-v2/v1-v2-parity-diligence-q4h.ts`
   - 断言：diligence/Q4H 关键事件与 runState 语义一致。
   - v1 状态：需 v2 模块后才有对照意义；当前未实现。
10. `driver-v2/replay-39-12-417f4a49-style.ts`
    - 断言：复放样本不再出现“已收到回贴却声称没看到”的语义回归。
    - v1 状态：可先做“现状复放”脚本；v2 需要转为门禁回归。当前未实现。

### 11.3 阶段 1/2 的测试门禁

阶段 1（v2 上线前）必须通过：

1. `lint:types`
2. 全部 L0 用例
3. 全部 L1 最小集（上面 1~7）
4. 至少 2 个 L2 对照用例（上面 8~9）
5. priming 专项 3 条（上面 1~3）全部通过

阶段 2（删除旧模块前）必须通过：

1. 阶段 1 全部门禁
2. 全部 L2 用例（含复放样本）
3. old-driver 引用清零后再跑一次全套，确保无隐性依赖

### 11.4 执行组织建议

在 `tests/package.json` 里新增独立脚本分组（阶段 1 即可开始）：

1. `driver-v2:unit`
2. `driver-v2:integration`
3. `driver-v2:parity`
4. `driver-v2:replay`
5. `driver-v2:gate`（汇总门禁脚本）

目的：把“能跑”与“可上线”分开，避免只凭单条 smoke 测试判断重写完成。

### 11.5 测试基座约定（script-rtws + mock provider）

1. 阶段 1 的集成测试默认基于 `tests/script-rtws` 运行，避免污染真实 rtws。
   - 执行约束：统一通过 `tests/cli.ts` 入口传 `-C script-rtws`；不允许其它 rtws。
2. 默认使用 `apiType: mock`，通过 `mock-db/<model>.yaml` 驱动可重复测试。
3. mock 响应可使用：
   - `delayMs`：整次响应前延迟（用于中断/rollback窗口）
   - `chunkDelayMs`：流式分块延迟（用于流顺序与 stop 时序）
4. 需要“慢速请求”场景时，优先在 mock 数据层配置，不依赖真实外部 provider。
