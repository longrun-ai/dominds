# FBR 实现细节（已落地）

英文版：[English](./fbr-implementation.md)

本文描述当前实现结构与约束。规范以 `fbr.zh.md` 为准。

## 实现原则

- FBR 与非 FBR 共享同一条上下文装配流水线，差异只允许通过显式策略字段声明。
- system prompt 本体禁止工具说明；工具可用性仅通过独立“无工具提示”表达。
- 工具/诉请限制在运行时技术上强制，不依赖模型“自觉遵守”。

## 代码结构

### 1) 统一策略对象（`main/llm/driver.ts`）

驱动阶段先构建 `DrivePolicy`，集中给出：

- `effectiveSystemPrompt`
- `effectiveAgentTools`
- `prependedContextMessages`
- `tellaskPolicy`
- `allowFunctionCalls`

其中 FBR 策略会：

- 切换到 `buildFbrSystemPrompt(...)`（不含工具说明）
- 注入单独 `buildNoToolsNotice(...)`
- 强制 `effectiveAgentTools = []`
- 强制 `tellaskPolicy = tellasker_only`
- 强制 `allowFunctionCalls = false`
- 在需要时对成员应用 `fbr_model_params` 覆盖

### 2) 统一上下文装配（`main/llm/driver.ts`）

上下文通过 `buildDriveContextMessages(...)` 组装，FBR 与非 FBR 走同一函数；FBR 仅通过 `prependedContextMessages` 体现“无工具可见性”差异，不再在主流程里零散 `unshift/push` 特判。

### 3) 统一违规判定（`main/llm/driver.ts`）

流式与非流式两条路径都调用 `resolveDrivePolicyViolationKind(...)`：

- 违规 tellask（FBR 仅允许 `@tellasker`）
- 违规 function/tool call（FBR 禁止）

一旦违规，统一产出 `formatDomindsNoteFbrToollessViolation(...)`，保持用户反馈与日志语义一致。

### 4) FBR 隔离不变量硬校验（`main/llm/driver.ts`）

驱动前会执行 `validateDrivePolicyInvariants(...)`，对 FBR 做 fail-fast 校验：

- system prompt 必须严格等于 `buildFbrSystemPrompt(...)`
- `effectiveAgentTools` 必须为空
- `allowFunctionCalls` 必须为 `false`
- `tellaskPolicy` 必须为 `tellasker_only`
- `prependedContextMessages` 必须且仅能包含一条 `buildNoToolsNotice(...)`

若任一条件不满足，运行时直接抛出 `FBR policy isolation violation`，防止全局工具手册/工具提示路径回流污染 FBR。

### 5) 单一“无工具提示”源（`main/minds/system-prompt-parts.ts`）

`buildNoToolsNotice(...)` 作为唯一工具可用性文案源，固定声明：

- 不能调用任何工具
- 不能访问 rtws / 文件 / 浏览器 / shell

## 相关模块

- `main/llm/driver.ts`：策略、上下文装配、违规判定
- `main/minds/system-prompt-parts.ts`：无工具提示生成
- `main/agent-priming.ts`：FBR 引导文案去工具化（不在 FBR 提示词内讲工具清单）

## 验收清单

- FBR system prompt 不包含工具说明。
- “无工具”文案仅来自独立 `buildNoToolsNotice(...)`。
- FBR 与非 FBR 的上下文装配主流程一致，差异只来自策略字段。
- FBR 中任意 tool/function call 或非 `@tellasker` tellask 都被运行时硬拒绝并给出明确回执。
