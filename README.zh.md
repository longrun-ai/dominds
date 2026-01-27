# Dominds（斟发作们）—— 斟酌开发运作的智能体们

> 以一支具备自我迭代能力的 AI DevOps 团队，实现产品的持续交付。

- English: [README.md](./README.md)

## 重要提示（CAVEATS）

- **无担保 / 风险自担**：Dominds 是一套高性能自动化框架。若配置不当、目标模糊或盲目采信输出结果，可能导致时间损耗或代码损坏。
  - 合并代码或发布版本前，务必核查所有修改；建议先在测试分支或克隆仓库中试运行验证。
- **成本 / 隐私 / 合规性**：调用大语言模型（LLM）供应商服务会产生费用，且提示词（部分场景含代码片段）可能传输至第三方。
  - 请仔细阅读服务条款，设置费用额度上限，切勿将密钥写入提示词或日志文件。
- **授权即执行**：Dominds 并非“辅助工具”，一旦获得授权，智能体将直接执行操作，你需对最终结果承担全部责任。
- **项目处于早期阶段**：目前存在功能边界不完善、破坏性更新及文档缺失等问题，欢迎提交 issue 或 PR 参与优化。

## 关于 Dominds

Dominds 是一款面向开发运作（DevOps）场景的智能体框架，它将“团队配置、记忆存储、流程规范、工具权限”整合至统一工作区，使多智能体团队能够长期稳定运行、持续学习，并在明确边界内高效执行任务。

其核心定位并非一次性完成产品开发，而是聚焦“持续交付”的全周期流程，涵盖任务拆分、职责分工、决策可追溯、工具使用管控及上下文健康度维护等关键环节。

## 安装指南

### 环境要求

- **Node.js（含 npm）**：版本 22.x 及以上
- **至少一个可用的 LLM 服务提供商**：Dominds 内置提供商目录（路径：[main/llm/defaults.yaml](./main/llm/defaults.yaml)），需为其中至少一个提供商配置有效凭证（通过环境变量设置）。
- **pnpm（可选）**：仅在开发 Dominds 本体时推荐安装。

### 安装 Dominds

```bash
# 推荐全局安装
npm install -g dominds
# 或使用 pnpm 安装
# pnpm add -g dominds

# 查看帮助文档
dominds --help
```

也可以选择 **无需全局安装** 的方式运行（适合临时试用 / CI / 不想污染环境）：

```bash
# 运行最新版（会临时下载到 npm cache 并执行）
npx -y dominds@latest --help
npx -y dominds@latest

# 或固定到某个版本（更利于复现）
# npx -y dominds@1.2.3
```

说明：

- 仅写 `npx dominds` **不一定**会自动跑“最新版”：如果你本地项目已安装了 `dominds`，或 npm cache 已存在旧版本，`npx` 可能会直接复用已有版本。
- 想要“每次都按 latest 标签解析版本”，请显式写 `dominds@latest`；它仍可能复用 cache 中已下载的同版本（属于正常行为）。

### 开发与贡献（树内工作流 / in-tree 工作流）

若你计划为 Dominds 开源项目贡献代码，建议使用树内包装器（in-tree wrapper）工作区：

https://github.com/longrun-ai/dominds-feat-dev

1. 克隆 dominds-feat-dev 仓库
2. 在 dominds-feat-dev/dominds/ 目录下，克隆你自己的 Dominds fork 仓库
3. 在内层 dominds/ 目录中，向 longrun-ai/dominds 提交 PR

## 快速上手（推荐：通过模板创建工作区）

```bash
# 1) 基于模板创建工作区
dominds create web-scaffold my-project
cd my-project

# 2) 启动 WebUI（默认自动打开浏览器，默认端口 5666）
dominds
```

首次启动后，通常会自动跳转至 `http://localhost:5666/setup` 配置页面，按以下步骤操作：

1. 选择提供商（provider）及模型（model），创建或覆盖 `.minds/team.yaml`（最小化可运行配置文件）。
2. 根据提示设置提供商所需的环境变量（配置页可协助将变量写入 `~/.zshrc` 或 `~/.bashrc` 的托管区块）。
3. 进入主界面，创建对话即可开始工作。

## 从零开始（空文件夹启动）

若暂无模板或团队配置，可直接从空目录启动：

```bash
mkdir my-workspace
cd my-workspace
dominds
```

完成初始化配置后，建议先与影子团队管理者 “伏羲”(`@fuxi`) 对话，由其根据你的产品需求，搭建适配的团队配置（例如生成完整的 `.minds/team.yaml` 文件，分配成员职责及工具权限）。

## 核心理念（Core Philosophy）

Dominds 面向“长期开发运作（DevOps）”场景设计，基于社会化分工理念，所有功能均围绕以下三大核心目标展开：

- 降低 **智能体心智负担**：将工作分配给不同专长的智能体成员，通过“对话分轮、噪音清理”等机制减少上下文污染（而非依赖传统上比较勉强的“上下文压缩”手段）。
- 防范 **工具滥用风险**：将软件工具交给专职智能体把关使用，确保牠们不受任务上下文影响，能够专心审核使用合规性，以及负责工具的正确使用。
- 避免 **信息过时问题**：将关键决策、约定及配置，以可版本追踪的工作区文件形式，体现为智能体上下文的直接内容（团队以及个人记忆，差遣牒，对话附加提醒项），而非散落在仓库中等着智能体自己去找。

### 1) 清心定界：上下文清爽、任务明确

> 将宏大目标拆解为边界清晰的细分任务，每个智能体成员仅获取完成当前任务所需的最小上下文。

- 上下文范围越小，智能体产生幻觉及误操作的概率越低
- 任务边界越清晰，结果评估与迭代优化的效率越高
- 任务契约越明确，越容易实现并行处理与流程复用

### 2) 意图导向的工具调用：安全的核心是“先判断再约束”

> 强力赋能的工具一般都伴随使用风险，安全保障必须来自基于意图的判断与约束，经常提醒智能体“要小心谨慎”，或者靠人来把关每个小细节，都是反生产力提升的。

核心原则：

- 默认赋予最小权限，仅在必要时扩展权限范围
- 针对危险工具，每次使用时由专职智能体进行确认：
  - 会产生意外副作用吗？
  - 不小心用错了？(防呆)
  - 被恶意滥用了？
  - 是否有更安全/更简单的替代手段？
  - 常规文本匹配对这些问题是力不从心的；更可靠的是由纪律严明的专职智能体做出判断，确保合规。
- 工具授权需满足可读取、可审计、可追溯（含工具集、成员工具清单、目录读写范围等）

### 3) 基于领域专有模板：多元团队，自我进化

> 基于模板快速搭建团队，将个体及团队记忆作为版本追踪的数字资产，持续迭代优化。

- 通过领域模板引导团队职责划分与工作流搭建
- 将角色设定（personas）、经验教训（lessons）、操作手册（playbooks）存入 `.minds/**` 目录，对于人类完全透明，方便阅读审核
- 伴随产品迭代，同步升级治理模式与团队结构

## 相关文档

- [**Terminology**](docs/dominds-terminology.md) — 专有术语（Taskdoc/差遣牒、Teammate Tellask/队友诉请、tellask 语法等）
- [**CLI Usage Guide**](docs/cli-usage.md) — 命令行工具及使用方法
- [**Design**](docs/design.md) — 架构设计与核心抽象
- [**Dialog System**](docs/dialog-system.md) — 对话系统与流式事件
- [**Dialog Persistence**](docs/dialog-persistence.md) — 磁盘持久化存储结构
- [**Interruption & Resumption**](docs/interruption-resumption.md) — 任务中断与恢复语义
- [**Encapsulated Taskdocs**](docs/encapsulated-taskdoc.md) — `*.tsk/` 差遣牒（Taskdoc）说明
- [**Auth**](docs/auth.md) — 认证机制与访问模型（WebUI + API）
- [**Context Health**](docs/context-health.md) — 上下文健康监测（token 使用与提醒策略）
- [**Team Mgmt Toolset**](docs/team-mgmt-toolset.md) — 团队管理工具集
- [**Team Tools View**](docs/team-tools-view.md) — WebUI：查看团队成员工具/工具集可用性
- [**MCP Support**](docs/mcp-support.md) — MCP 工具集成指南
- [**i18n**](docs/i18n.md) — 语言支持与本地化配置
- [**OEC Philosophy**](docs/OEC-philosophy.md) — 全方位优化管理法
- [**Mottos**](docs/mottos.md) — 警世名言

## 获取帮助

如需协助，可在 GitHub 提交 issue：[https://github.com/longrun-ai/dominds/issues](https://github.com/longrun-ai/dominds/issues)

---

**License:**[LGPL](./LICENSE) | **Repository:**[https://github.com/longrun-ai/dominds](https://github.com/longrun-ai/dominds)
