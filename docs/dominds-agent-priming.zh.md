# Dominds 智能体启动（本分支已废弃）

英文版：[English](./dominds-agent-priming.md)

## 现状

本分支已完全移除旧的硬编码 Agent Priming 运行时实现。

- 对话创建时不再自动执行“启动流程”。
- 不再执行启动缓存/复用/跳过等 priming 模式与状态。
- 不再有专门的 priming 运行时接口在主线创建时被触发。

## 当前行为说明

- 运行时不再自动执行“先跑启动 Tellask + 回贴 + 综合提炼”这一预置流程。
- FBR 仍按正常机制可用：`freshBootsReasoning({ tellaskContent: "..." })`（见 [`fbr.md`](./fbr.md)）。
- `fbr_effort` 仅控制单次 `freshBootsReasoning` 内的**串行** FBR 次数。

## 计划中的替代实现

Agent Priming 将从头重构为“启动脚本回放”方案：

1. 将正常对话历史持久化为可复用的启动脚本（startup script）。
2. 通过新接口按需回放脚本，驱动启动阶段行为。
3. 用脚本与回放契约把行为做成可观测、可版本化的能力边界。

在新接口落地前，本页按“迁移说明”使用，不代表当前默认运行时行为。
