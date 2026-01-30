# 对话持久化和存储

本文档描述了 Dominds 对话系统的持久化层和存储机制，包括文件系统约定、数据结构和存储模式。

## 当前实现状态

持久化层已完全实现并处于活跃状态，具有现代 TypeScript 类型和 `latest.yaml` 支持。`main/persistence.ts` 提供带强类型安全和实时时间戳跟踪的文件支持存储。

### 当前状态

- **✅ 完全实现**：现代存储系统在 `main/shared/types/storage.ts` 中具有强 TypeScript 类型
- **✅ latest.yaml 支持**：当前轮次和 lastModified 跟踪，用于准确的 UI 时间戳
- **✅ 仅追加事件**：基于 JSONL 的事件流，具有原子操作
- **✅ 强类型安全**：可区分联合和类型守卫，用于编译时验证
- **✅ 真实文件 I/O**：对话会话在 `.dialogs/run|done/archive` 下持久化，具有现代文件格式
- **✅ UI 集成**：WebSocket 事件直接映射到 UI，具有来自持久化记录的准确时间戳

### 关键特性

- **latest.yaml**：跟踪当前轮次、lastModified 时间戳、消息计数和对话状态
- **强类型**：具有可区分联合和类型守卫的现代 TypeScript 模式
- **原子操作**：所有文件操作都是原子的，以防止损坏
- **高效时间戳**：UI 显示来自持久化记录的准确 lastModified 时间
- **流兼容**：仅追加设计支持实时流式传输和磁盘持久化
- **错误过滤**：流错误不会持久化到磁盘文件，也不会恢复到 UI

## 目录

1. [存储架构](#存储架构) _(仅设计参考)_
2. [工作区约定](#工作区约定) _(仅设计参考)_
3. [对话存储结构](#对话存储结构) _(仅设计参考)_
4. [记忆持久化](#记忆持久化) _(仅设计参考)_
5. [数据格式](#数据格式) _(仅设计参考)_
6. [错误持久化策略](#错误持久化策略) _(仅设计参考)_
7. [持久化操作](#持久化操作) _(仅设计参考)_
8. [已完成实现总结](#已完成实现总结)

---

## 存储架构

实现遵循此架构。

### 设计原则

- **扁平子对话存储**：所有子对话扁平存储在主对话（根对话）的 `subdialogs/` 目录下，无论嵌套深度如何
- **仅追加流**：消息流是仅追加的，用于审计追踪和重放能力
- **原子操作**：所有持久化操作都是原子的，以防止损坏
- **人类可读格式**：存储使用 YAML 和 JSONL 以实现透明性和调试

### 目录布局

```
workspace/
├── .minds/                    # 代理配置和持久化记忆
│   ├── llm.yaml              # LLM 提供商配置
│   ├── team.yaml             # 团队名单和默认设置
│   ├── team/                 # 代理特定配置
│   │   └── <member>/
│   │       ├── persona.md    # 代理个性和角色
│   │       ├── knowledge.md  # 代理专业知识和技能
│   │       └── lessons.md    # 代理学习和适应
│   └── memory/               # 工作区持久化记忆
│       ├── team_shared/      # 团队共享记忆（此目录下所有 `*.md` 都会被加载）
│       │   └── *.md
│       └── individual/       # 代理个体记忆（每个代理）
│           └── <member>/
│               └── **/*.md
└── .dialogs/                 # 对话运行时状态
    ├── run/                  # 活动对话
    ├── done/                 # 已完成的对话
    └── archive/              # 已归档的对话
```

---

## 工作区约定

这些约定指导工作区组织。对话目录在 `.dialogs/` 下动态创建。

### 代理配置 (`.minds/`)

**团队配置** (`team.yaml`)：

```yaml
name: 'Development Team'
default_agent: 'alice'
default_provider: 'openai'
members:
  - id: 'alice'
    name: 'Alice'
    role: 'Senior Developer'
    provider: 'openai'
  - id: 'bob'
    name: 'Bob'
    role: 'DevOps Engineer'
    provider: 'anthropic'
```

**LLM 配置** (`llm.yaml`)：

```yaml
providers:
  openai:
    api_key_env: 'OPENAI_API_KEY'
    model: 'gpt-4'
    temperature: 0.7
  anthropic:
    api_key_env: 'ANTHROPIC_API_KEY'
    model: 'claude-3-sonnet'
    temperature: 0.5
```

**代理人格** (`team/<member>/persona.md`)：

- 代理个性和沟通风格
- 角色特定职责和专业技能
- 协作偏好和模式

**代理知识** (`team/<member>/knowledge.md`)：

- 技术专长和专业化
- 领域特定知识和经验
- 工具熟练度和偏好

**代理经验** (`team/<member>/lessons.md`)：

- 从过去交互和错误中学习
- 适应模式和改进
- 性能优化和见解

### 记忆存储 (`.minds/memory/`)

Dominds 从两个范围加载记忆文件为纯 markdown (`*.md`)：

- **团队共享记忆**：`.minds/memory/team_shared/**/*.md`
- **个体记忆**：`.minds/memory/individual/<member>/**/*.md`

这些路径由记忆工具强制执行（见 `main/tools/mem.ts`），并由 `main/minds/load.ts` 加载到代理上下文中。

---

## 对话存储结构 _(仅设计参考)_

> **注意**：本节描述了预期的对话存储结构，当前持久化实现基本匹配（见 `main/persistence.ts`）。

### 对话标识

**对话 ID**：使用 `generateDialogID()` 格式生成：`aa/bb/cccccccc`

- 前两段：随机性和分布
- 第三段：基于时间戳的唯一性
- 支持扁平存储同时保持唯一性

**DialogID 模式**：系统使用 `self+root` ID 模式，在 `DialogID` 类中实现：

- **selfDlgId**：此特定对话实例的唯一标识符
- **rootDlgId**：层次结构中根对话的标识符（根对话默认为 selfDlgId）
- **序列化**：当 `rootDlgId` 与 `selfDlgId` 不同时，全 ID 格式化为 `rootDlgId#selfDlgId`；否则仅为 `selfDlgId`

此模式能够在管理子对话关系的同时实现高效的唯一标识每个对话实例。

### 设计原理

`self+root` ID 模式的实现是为了解决对话管理中的几个挑战：

1. **层次关系跟踪**：为每个对话提供清晰的谱系信息，易于将子对话追溯到其根对话
2. **高效存储组织**：允许子对话的扁平存储，同时保留关系信息
3. **唯一标识**：确保每个对话实例具有唯一标识符，即使存在多个子对话
4. **简化持久化**：实现对话关系的直接序列化和反序列化
5. **改进调试**：在日志和调试信息中提供清晰标识
6. **可扩展性**：支持深度子对话层次结构，无需复杂的存储结构

此设计平衡了对清晰层次关系与高效存储和检索操作的需求。

### 活动对话结构

```
.dialogs/run/<rootDialogId>/
├── dialog.yaml               # 带强类型的对话元数据
├── latest.yaml               # 当前轮次和 lastModified 跟踪
├── reminders.json            # 持久化提醒项
├── <round>.jsonl             # 每个轮次的流式消息
├── <round>.yaml              # 轮次元数据
└── subdialogs/               # 扁平子对话存储
    ├── <subDialogId1>/       # 第一级子对话
    │   ├── dialog.yaml       # 子对话元数据
    │   ├── latest.yaml       # 子对话当前状态
    │   ├── reminders.json    # 子对话提醒项
    │   ├── <round>.jsonl     # 子对话事件
    │   └── <round>.yaml      # 子对话轮次元数据
    └── <subDialogId2>/       # 另一个子对话
        ├── dialog.yaml
        ├── latest.yaml
        ├── reminders.json
        ├── <round>.jsonl
        └── <round>.yaml
```

**关键特性**：

- **latest.yaml**：带有当前轮次、lastModified 和状态的现代跟踪文件
- **强类型**：所有文件使用来自 `main/shared/types/storage.ts` 的 TypeScript 接口
- **原子 在所有对话修改更新**：latest.yaml时原子更新
- **UI 集成**：latest.yaml 中的时间戳在对话列表中正确显示

在此结构中：

- 根对话的 `selfDlgId` 等于 `rootDlgId`
- 子对话具有不同的 `selfDlgId` 值，与父对话具有相同的 `rootDlgId`
- 子对话目录仅使用 `selfDlgId` 进行文件系统组织
- 元数据仅存储 `selfDlgId`；加载时重建完整的 `rootDlgId#selfDlgId`
- 完整的 `rootDlgId#selfDlgId` 格式用于内存中标识和操作

### 对话元数据 (`dialog.yaml`)

使用 TypeScript 接口的现代强类型对话元数据：

#### 根对话示例

```yaml
id: 'aa/bb/cccccccc' # 唯一对话标识符（仅 selfDlgId）
agentId: 'alice' # 负责此对话的代理
taskDocPath: 'task.tsk' # 工作区任务文档包目录的路径
createdAt: '2024-01-15T10:30:00Z' # 创建时的 ISO 时间戳
# 根对话没有父字段
```

#### 子对话示例

```yaml
id: 'dd/ee/ffffffff' # 唯一对话标识符（仅 selfDlgId）
agentId: 'bob' # 负责此对话的代理
taskDocPath: 'task.tsk' # 工作区任务文档包目录的路径（从父级继承）
createdAt: '2024-01-15T10:35:00Z' # 创建时的 ISO 时间戳
supdialogId: 'aa/bb/cccccccc' # 父对话的 selfDlgId
assignmentFromSup: # 来自父级的任务上下文
  headLine: 'Implement user authentication'
  callBody: 'Create secure login system with JWT tokens'
  originMemberId: 'alice'
```

**类型安全**：所有元数据遵循 `main/shared/types/storage.ts` 中的 `DialogMetadataFile` 接口，具有编译时验证。

### 最新状态文件 (`latest.yaml`)

用于当前对话状态和 UI 时间戳的现代跟踪文件：

```yaml
currentRound: 3 # 当前轮次编号（基于 1）
lastModified: '2024-01-15T11:45:00Z' # 最后活动的 ISO 时间戳
messageCount: 12 # 当前轮次中的总消息数
functionCallCount: 3 # 当前轮次中的总函数调用数
subdialogCount: 1 # 创建的子对话总数
status: 'active' # 当前对话状态
```

**自动更新**：`latest.yaml` 在以下情况下自动更新：

- 新消息事件
- 轮次转换
- 函数调用结果
- 子对话创建
- 任何对话修改

**UI 集成**：对话列表显示来自此文件的 `lastModified` 时间戳，用于准确排序和显示。

### 轮次跟踪 (`round.curr`)

包含当前轮次编号的简单文本文件：

```
3
```

### 提醒项存储 (`reminders.json`)

```json
{
  "reminders": [
    {
      "id": "r1",
      "content": "Remember to validate input parameters",
      "created_at": "2024-01-15T10:45:00Z",
      "priority": "high"
    },
    {
      "id": "r2",
      "content": "Consider edge cases for empty datasets",
      "created_at": "2024-01-15T11:00:00Z",
      "priority": "medium"
    }
  ]
}
```

---

## 记忆持久化

提醒项和人类问题持久化已实现。团队共享的 `.minds/` 记忆单独管理，不属于对话持久化覆盖范围。

### 团队共享记忆同步

**更新模式**：

1. 代理检测到共享记忆更新的需要
2. 原子写入临时文件
3. 原子重命名替换现有文件
4. 广播通知其他活动对话
5. 其他对话在下一次访问时重新加载共享记忆

**冲突解决**：

- 简单更新的最后写入者胜出
- 复杂冲突的人工干预
- 用于审计追踪的版本跟踪

### 代理个体记忆管理

**持久化触发器**：

- 对话会话结束
- 重大学习事件
- 长对话期间的定期检查点
- 手动保存操作

**存储格式**：

- 人类可读的 Markdown 文件
- 用于结构化数据的 JSON 元数据
- 用于学习历史的仅追加日志

---

## 数据格式

这些格式由实现积极使用。

### 消息流格式 (`.jsonl`)

每行包含 JSON 格式的单个消息。**注意：流错误事件不会持久化到 JSONL 文件。**

```jsonl
{"type": "user", "content": "Implement user authentication", "timestamp": "2024-01-15T10:30:00Z"}
{"type": "assistant", "content": "I'll help you implement user authentication. Let me start by...", "timestamp": "2024-01-15T10:30:15Z"}
{"type": "function_call", "name": "create_file", "arguments": {"path": "auth.py", "content": "..."}, "timestamp": "2024-01-15T10:30:30Z"}
{"type": "function_result", "name": "create_file", "result": {"success": true}, "timestamp": "2024-01-15T10:30:31Z"}
# 注意：dlg_stream_error 事件被过滤，不会写入 JSONL 文件
```

### 轮次元数据 (`.yaml`)

```yaml
round: 3
started_at: '2024-01-15T11:30:00Z'
completed_at: '2024-01-15T11:45:00Z'
message_count: 12
function_calls: 3
subdialogs_created: 1
status: 'completed'
```

### 任务文档存储

任务文档是独立存在的工作区工件，对话通过路径引用它们。任务文档必须是封装的任务文档包 (`*.tsk/`)。

```yaml
# 在 dialog.yaml 中
taskdoc: 'tasks/user-auth.tsk' # 工作区任务文档包目录的路径
taskdocVersion: 5
taskdocChecksum: 'sha256:abc123...'
```

**关键属性**：

- 任务文档是标准工作区工件，不是对话特定存储
- 多个对话可以引用相同的任务文档进行协作工作
- 任务文档在整个 DevOps 生命周期中持续存在，超出单个对话
- 任务文档文件的更改对所有引用它的对话立即可见

### 错误持久化策略

**流错误不会持久化到磁盘文件，也不会恢复到 UI：**

- **无磁盘持久化**：流错误事件（`dlg_stream_error`）不会写入 `round-*.jsonl` 文件
- **无 UI 恢复**：错误部分（`.error-section`）仅在活动流式传输期间出现，对话从磁盘重新加载时不会恢复
- **仅日志记录**：错误详情出现在后端日志（`logs/backend-stdout.log`）中用于调试，但排除在持久化存储之外
- **临时 UI 状态**：生成气泡中的错误部分是临时 UI 元素，在对话重新加载时消失

**原理**：

- 防止持久化对话历史中的错误状态污染
- 保持干净的对话恢复，没有错误伪影
- 与错误是运行时事件而非对话内容一部分的原则一致
- 通过排除临时错误数据减少存储开销

**实现说明**：

- 后端在写入 `round-*.jsonl` 之前过滤掉 `dlg_stream_error` 事件
- 前端将错误部分视为临时 UI 状态，而非持久化内容
- 对话重新加载仅重建持久化内容（用户消息、思考、说法、代码块）
- 错误处理在活动流式会话期间保持功能

---

## 持久化操作

以下操作已实现。

### 对话创建

1. 使用 `generateDialogID()` 生成唯一对话 ID
2. 创建具有 `selfDlgId` 和 `rootDlgId` 的 `DialogID` 实例（根对话的 rootDlgId 默认为 selfDlgId）
3. 创建对话目录结构
4. 使用序列化的 DialogID 写入初始 `dialog.yaml` 元数据
5. 将 `round.curr` 初始化为 1
6. 创建空的 `reminders.json`
7. 设置任务文档路径引用

### 消息持久化

1. 将消息追加到当前轮次的 `.jsonl` 文件
2. 如果轮次完成则更新轮次元数据
3. 如果开始新轮次则增加轮次计数器
4. 确保原子写入以防止损坏

### 子对话创建

1. 使用 `generateDialogID()` 生成唯一子对话 ID
2. 创建具有以下内容的 `DialogID` 实例：
   - `selfDlgId`：新生成的子对话 ID
   - `rootDlgId`：从 supdialog 的 `rootDlgId` 继承
3. 在父级的 `subdialogs/` 下创建子对话目录（仅使用 `selfDlgId` 作为目录名）
4. 从父级设置任务文档路径引用
5. 在元数据中设置父调用上下文
6. 初始化子对话状态，元数据中仅存储 `selfDlgId`
7. 加载时基于目录结构重建完整的 `DialogID` 和 `rootDlgId`

### 对话完成

1. 将对话状态更新为"已完成"
2. 完成所有轮次元数据
3. 对于根对话：
   - 将对话目录从 `run/` 移动到 `done/`
   - 移动中包含所有子对话
4. 对于子对话：
   - 更新元数据中的状态
   - 使用完整的序列化 DialogID 通知 supdialog 完成
5. 根据保留策略归档旧对话

### 记忆更新

1. 加载当前记忆状态
2. 原子方式应用更新
3. 写入临时文件
4. 原子重命名替换原始文件
5. 通知其他对话更改
6. 更新版本跟踪

### 备份和恢复

**备份策略**：

- 定期快照整个 `.minds/` 和 `.dialogs/` 树
- 活动对话的增量备份
- 长期归档的导出功能

**恢复程序**：

- 从最近的 consistent snapshot 恢复
- 重放消息流以恢复状态
- 验证对话层次结构完整性
- 如需要重建索引和元数据

---

## 性能考虑

### 存储优化

**扁平子对话存储**：防止可能影响文件系统性能的深层目录嵌套。

**仅追加流**：针对写入性能优化并支持高效流式传输。

**延迟加载**：按需加载对话内容以最小化内存使用。

**压缩**：旧对话归档可以压缩以节省空间。

### 可扩展性

**分片**：大型工作区可以跨多个目录分片对话。

**清理策略**：基于年龄和大小自动清理旧的已完成对话。

**索引管理**：维护索引以实现快速对话查找和搜索。

### 可靠性

**原子操作**：所有文件操作都是原子的，以防止损坏。

**校验和**：使用校验和进行文件完整性验证。

**冗余**：关键数据可以跨多个存储位置复制。

**监控**：存储系统问题的健康检查和警报。

---

## 迁移和版本控制

迁移和版本控制功能尚未实现，仍是计划中的能力。

### 模式演进

**版本跟踪**：所有存储格式包括版本号以支持迁移。

**向后兼容性**：新版本保持与旧格式的兼容性。

**迁移工具**：用于升级存储格式的自动化工具。

### 数据迁移

**导出/导入**：用于在工作区之间移动对话的工具。

**格式转换**：根据需要在不同存储格式之间转换。

**验证**：在迁移操作期间验证数据完整性。

---

## 已完成实现总结

### 完全重构完成 ✅

持久化层已**完全现代化**，没有向后兼容性：

#### ✅ 强 TypeScript 类型 (`main/shared/types/storage.ts`)

- **现代可区分联合**：具有编译时验证的类型安全事件处理
- **类型守卫**：存储格式的运行时验证
- **泛型接口**：对话元数据、事件和 UI 数据的可重用类型
- **严格类型**：所有字段访问都是静态可验证的

#### ✅ latest.yaml 支持

- **实时跟踪**：当前轮次和 lastModified 时间戳
- **原子更新**：所有对话修改时自动更新
- **UI 集成**：对话列表显示来自持久化记录的准确时间戳
- **状态管理**：跟踪对话状态、消息计数和子对话计数

#### ✅ 现代持久化层 (`main/persistence.ts`)

- **类型安全操作**：所有方法使用强 TypeScript 接口
- **原子文件操作**：所有写入使用临时文件 + 重命名模式
- **自动时间戳**：latest.yaml 在事件上自动更新
- **统一 API**：根对话和子对话的一致接口

#### ✅ 更新的 API 层 (`main/server/api-routes.ts`)

- **时间戳集成**：API 响应包括来自 latest.yaml 的 lastModified
- **类型安全响应**：所有 API 端点的强类型
- **高效查询**：加载 latest.yaml 和元数据以获得完整状态

#### ✅ UI 时间戳显示

- **准确时间戳**：对话列表显示来自持久化记录的真实 lastModified
- **格式处理**：现有时间戳格式与 ISO 字符串一起工作
- **实时更新**：UI 通过 WebSocket 事件立即反映更改

### 迁移笔记

**破坏性更改**：此重构有意移除了所有向后兼容性：

- 从 `main/persistence.ts` 中移除了旧接口
- 新的 `main/shared/types/storage.ts` 提供所有类型定义
- 所有对话创建现在包括 `latest.yaml` 初始化
- API 响应包括 `lastModified` 字段用于 UI 时间戳

**实现的收益**：

- 所有存储操作的编译时类型安全
- 来自持久化记录的准确 UI 时间戳
- 整个代码库的现代 TypeScript 模式
- 专用存储类型的清晰关注点分离
- 原子文件操作防止数据损坏

**智能缓存层**：

- **优点**：减少磁盘 I/O，提高响应时间，保持基于文件的好处
- **实现**：具有写穿透/写回策略的内存缓存

### 改进的文件/目录组织

重新设计的文件组织应高效支持流式传输和恢复模式：

#### 建议的目录结构

```
workspace/
├── dialogs/
│   ├── active/           # 当前流式对话
│   │   ├── {root-dialog-id}/    # 根对话目录 (selfDlgId = rootDlgId)
│   │   │   ├── stream.jsonl      # 仅追加消息流
│   │   │   ├── metadata.yaml     # 对话配置和状态
│   │   │   ├── checkpoints/      # 定期状态快照
│   │   │   ├── temp/             # 流式传输期间的临时文件
│   │   │   └── subdialogs/       # 子对话存储
│   │   │       └── {sub-dialog-id}/  # 子对话目录（仅使用 selfDlgId）
│   │   │           ├── stream.jsonl
│   │   │           ├── metadata.yaml
│   │   │           └── checkpoints/
│   │   └── index.json            # 快速查找活动对话
│   ├── archived/         # 已完成/暂停的对话
│   │   ├── {date}/              # 按完成日期组织
│   │   │   ├── {root-dialog-id}.tar.gz  # 包含子对话的压缩对话归档
│   │   │   └── metadata.json       # 归档元数据
│   │   └── index.json            # 归档查找索引
│   └── templates/        # 对话模板和预设
├── agents/              # 代理配置（不变）
└── knowledge/           # 知识库（不变）
```

在此建议结构中：

- 根对话按其 `root-dialog-id` 组织
- 子对话存储在其根对话的 `subdialogs/` 目录中，目录名称仅使用他们的 `selfDlgId`
- 元数据在 `id` 字段中仅存储 `selfDlgId`
- 完整的 `rootDlgId#selfDlgId` 格式在加载时重建，并用于索引中以实现高效查找

#### 文件格式规范

- **stream.jsonl**：每行一个 JSON 对象，用于每条消息/事件
- **metadata.yaml**：人类可读的配置和状态信息，在 `id` 字段中仅存储 `selfDlgId`
- **checkpoints/**：用于快速恢复大型对话的二进制快照
- **index.json**：带有对话元数据的轻量级查找表，包括完整的 `rootDlgId#selfDlgId` 格式以实现高效查找
- **Archives**：完成对话的压缩存储，具有快速搜索能力

#### 第 3 阶段：流-磁盘统一

1. **统一会话接口**：为流式传输和恢复会话实现通用抽象
2. **增量持久化**：设计不会阻塞对话流的流式传输兼容持久化
3. **延迟加载**：为大型对话历史实现高效的部分加载
4. **状态同步**：确保内存流和磁盘状态之间的一致性
5. **性能优化**：在保持数据完整性的同时最小化 I/O 开销

#### 第 4 阶段：高级文件操作

1. **原子写入**：确保文件操作是原子的以防止损坏
2. **压缩**：为大型对话归档实现高效压缩
3. **索引创建**：创建基于文件的索引以实现快速对话查找和搜索
4. **清理**：自动清理临时文件和旧对话数据

### 统一流式传输/加载架构

关键创新是在流式传输和基于磁盘的会话之间创建**无缝接口**。

#### 会话生命周期管理

- **创建**：新会话以流式传输模式开始，带有后台持久化
- **恢复**：磁盘会话增量加载以显示为活动流
- **转换**：会话可以在流式传输和持久化状态之间透明移动
- **清理**：会话结束或归档时正确清理资源

#### 流兼容文件格式

- **仅追加日志**：可以增量读取的消息流
- **检查点文件**：用于快速会话恢复的定期快照
- **元数据流**：对话元数据和状态更改的单独流
- **索引文件**：用于高效会话导航的快速查找表

### 技术考虑

#### 基于文件的状态管理

- **增量写入**：仅追加操作以最小化文件系统开销
- **流式读取**：增量读取文件而不将整个内容加载到内存
- **原子操作**：使用临时文件和原子重命名以保持一致性
- **文件锁定**：安全处理对话文件的并发访问

#### 性能优化

- **缓冲 I/O**：为文件操作使用适当的缓冲区大小
- **延迟加载**：按需加载对话内容而非急切加载
- **缓存策略**：缓存频繁访问的对话元数据和最近消息
- **索引管理**：维护轻量级索引以实现快速对话发现

#### 文件系统可靠性

- **错误恢复**：通过重试逻辑优雅地处理文件系统错误
- **损坏检测**：使用校验和检测和处理文件损坏
- **备份策略**：定期备份关键对话数据
- **清理策略**：自动清理临时和过时的文件

### 集成要求

#### 对话系统集成

- **最小接口更改**：尽可能保留现有方法签名
- **向后兼容性**：支持现有对话代码而不需要重大重构
- **性能透明度**：持久化不应显著影响对话性能

#### 开发工作流程

- **测试策略**：单元测试、集成测试和性能基准
- **开发环境**：最小依赖的本地开发设置
- **部署**：具有监控和回滚能力的生产部署

### 成功标准

成功的持久化实现应实现：

1. **可靠的会话恢复**：可以从持久化状态准确恢复对话会话
2. **性能目标**：常见操作的延迟低于 100ms，支持 100+ 并发对话
3. **数据完整性**：正常操作下零数据丢失，失败时优雅降级
4. **操作简单性**：易于部署、监控和维护
5. **开发者体验**：清晰的 API、良好的错误消息、全面的文档

### 迁移策略

在演进持久化层时：

1. **功能标志**：使用功能标志逐步启用新的持久化功能
2. **数据迁移**：工具将任何现有数据迁移到新格式
3. **回滚计划**：定义失败时的操作回滚
4. **性能测试**：在真实负载条件下彻底测试
