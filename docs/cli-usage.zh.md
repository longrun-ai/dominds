# CLI 使用指南

`dominds` 包为 DevOps Mindsets AI 团队功能的不同方面提供了多个命令行接口。

## 目录

- [CLI 使用指南](#cli-使用指南)
  - [目录](#目录)
  - [可用命令](#可用命令)
  - [快速参考](#快速参考)
  - [核心命令](#核心命令)
    - [Web UI 界面](#web-ui-界面)
    - [文本用户界面 (TUI)](#文本用户界面-tui)
    - [Minds 阅读器](#minds-阅读器)
    - [工作区创建](#工作区创建)
  - [TUI 命令选项](#tui-命令选项)
    - [更改工作区](#更改工作区)
    - [指定团队成员](#指定团队成员)
    - [恢复或使用自定义对话 ID](#恢复或使用自定义对话-id)
  - [使用示例](#使用示例)
    - [基本工作流程](#基本工作流程)
    - [团队协作](#团队协作)
    - [高级用法](#高级用法)
  - [对话存储](#对话存储)
  - [错误处理](#错误处理)

## 可用命令

`dominds` 包提供带有子命令的统一 CLI：

| 命令                              | 用途                        | 界面类型            |
| --------------------------------- | --------------------------- | ------------------- |
| `dominds` 或 `dominds webui`      | 基于 Web 的用户界面（默认） | Web UI              |
| `dominds tui` 或 `dominds run`    | 基于终端的对话界面          | TUI（文本用户界面） |
| `dominds read`                    | 读取和分析代理 minds 配置   | CLI 实用工具        |
| `dominds create` 或 `dominds new` | 从模板创建新工作区          | CLI 实用工具        |
| `dominds help`                    | 显示帮助消息                | CLI 实用工具        |
| `dominds --version`               | 显示版本信息                | CLI 实用工具        |

## 快速参考

```bash
# 安装
npm install -g dominds
# (或) pnpm add -g dominds

# Web UI - 浏览器中的图形界面（默认）
dominds
dominds webui [options]

# TUI - 基于终端的交互界面
dominds tui [options] <taskdoc-path> [prompts...]
dominds run [options] <taskdoc-path> [prompts...]  # tui 的别名
dominds tui --list
dominds tui --help

# Minds 阅读器 - 分析团队配置
dominds read [options] [member-id]

# 通用帮助
dominds --help
dominds help

# 工作区创建 - 搭建新项目/工作区
dominds create <template> [directory]
dominds new <template> [directory]  # create 的别名
```

## 核心命令

### Web UI 界面

```bash
dominds
dominds webui [options]
```

为当前工作区启动基于 Web 的用户界面。这会在浏览器中提供图形界面，用于管理对话和与 AI 团队交互。

**选项：**

- `-p, --port <port>` - 监听的端口（默认：5555）
- `-h, --host <host>` - 绑定的主机（默认：localhost）
- `-C, --cwd <dir>` - 启动前更改工作区目录
- `--help` - 显示帮助消息

**示例：**

```bash
# 在默认端口启动 Web UI
dominds

# 在特定端口启动 Web UI
dominds webui -p 8080

# 在特定工作区启动 Web UI
dominds webui -C ./my-workspace
```

**功能：**

- 可视化对话管理
- 实时流式显示
- 文件浏览器集成
- 团队成员选择
- 交互式配置

### 文本用户界面 (TUI)

TUI 提供基于终端的交互式对话管理，具有实时流式功能。它支持交互式和非交互式模式，适合 CI/CD 环境。

#### 启动或继续对话

```bash
dominds tui <taskdoc-path> [prompts...]
dominds run <taskdoc-path> [prompts...]  # tui 的别名
```

使用指定的 Taskdoc 启动新对话或继续现有对话。

**参数：**

- `taskdoc-path` - Taskdoc 的路径（必需，通常是 `.tsk/` 包目录）
- `prompts` - 可选的初始提示词以开始对话

**示例：**

```bash
# 使用 Taskdoc 启动新对话
dominds tui task.tsk "Implement user authentication"

# 使用 run 别名
dominds run task.tsk "Implement user authentication"

# 使用多个提示词启动
dominds tui project-plan.md "Review the architecture" "Suggest improvements"

# 没有初始提示词的简单任务
dominds tui bug-fix.md
```

#### 列出所有对话

```bash
dominds tui --list
dominds run --list  # tui 的别名
```

按状态组织显示所有对话：

- **运行中** - 当前活动的对话
- **已完成** - 已完成的对话
- **已归档** - 已归档的对话

每个对话条目显示：

- 对话 ID（3 段格式：aa/bb/cccccccc）
- 代理 ID（处理对话的团队成员）

#### 设计理念：以用户为中心的命令空间

dominds 遵循**以用户为中心的设计理念**：

- **所有 dominds 命令需要 `--` 前缀**（例如 `--list`、`--help`、`--version`）
- **所有裸参数保留给用户**（Taskdocs、提示词、用户文件）
- **命令命名空间无竞争** - 用户可以自由命名他们的文件为 `list`、`help` 等

**示例：**

```bash
# dominds 命令（始终使用 --）
dominds tui --list          # 列出对话
dominds tui --help          # 显示帮助
dominds tui --version       # 显示版本

# 用户文件（无冲突）
dominds tui list            # 打开用户的 'list' 文件
dominds tui help.md         # 打开用户的 'help.md' 文件
dominds tui version-notes   # 打开用户的 'version-notes' 文件
```

**好处：**

- **零歧义** - 命令和用户文件之间清晰分离
- **用户便利** - 随意命名 Taskdocs
- **可预测行为** - 裸参数始终是用户内容
- **面向未来** - 新的 dominds 命令不会破坏现有工作流程
- 状态

对于空工作区，显示关于如何开始新对话的有用说明。

#### 显示版本

```bash
dominds tui --version
```

显示 dominds 包的当前版本。

#### 显示帮助

```bash
dominds tui --help
dominds tui -h
```

显示 TUI 的用法信息和可用选项。

#### 获取特定命令的帮助

```bash
dominds tui --list --help
```

显示 `--list` 命令的详细帮助信息。

#### CI/CD 支持

TUI 自动检测 CI 环境并切换到非交互式模式，使其适合自动化工作流：

- 在 CI 环境中禁用终端操作
- 直接输出到 stdout/stderr 以进行适当日志记录
- 在没有交互功能的情况下保持完整功能
- 在交互式和非交互式模式下支持所有命令

### Minds 阅读器

```bash
dominds read [options] [member-id]
```

读取代理系统提示词和内存，带有过滤标志。

**用途：**

- 查看团队成员配置
- 分析系统提示词
- 检查代理内存
- 调试团队设置问题

**参数：**

- `member-id` - 可选的团队成员 ID（默认：所有成员）

**选项：**

- `-C, --cwd <dir>` - 读取前更改工作区目录
- `--only-prompt` - 仅显示系统提示词
- `--only-mem` - 仅显示内存
- `--help` - 显示帮助消息

**示例：**

```bash
# 读取当前工作区中的所有团队成员
dominds read

# 读取特定团队成员
dominds read developer

# 从特定工作区读取
dominds read -C ./my-workspace

# 仅显示系统提示词
dominds read --only-prompt

# 仅显示内存
dominds read --only-mem
```

### 工作区创建

```bash
dominds create <template> [directory]
dominds new <template> [directory]  # create 的别名
```

通过克隆/搭建包含预配置 `.minds/` 设置的模板仓库来创建新的 dominds 驱动的工作区。

**参数：**

- `template` - 模板名称或 Git URL（必需）
- `directory` - 目标目录名称（可选，默认为模板派生的目录名称）

**使用 - 搭建模板：**

```bash
# 推荐：使用带有预配置团队的搭建模板
dominds create|new <template> [directory]

# 官方模板的简短形式（使用 DOMINDS_TEMPLATE_BASE）
dominds create web-scaffold my-web-app
dominds create api-scaffold my-api
dominds create cli-scaffold my-cli
dominds create fullstack-scaffold my-app

# 自定义模板的完整 GitHub URL
dominds create https://github.com/myorg/custom-template.git my-project

# 使用自定义仓库设置
dominds create web-scaffold \
                 --repo-url https://github.com/myorg/new-project.git \
                 my-project
```

当提供 `--repo-url` 时，`dominds create` 克隆模板，然后将克隆的工作区的 `origin` 远程设置为提供的 URL，并将原始模板 URL 作为单独的 `template` 远程保留以供参考。

**模板解析：**

短模板名称使用 `DOMINDS_TEMPLATE_BASE` 环境变量解析：

```bash
# 默认模板基础（如果未设置 DOMINDS_TEMPLATE_BASE）
export DOMINDS_TEMPLATE_BASE="https://github.com/longrun-ai"

# 自定义组织模板
export DOMINDS_TEMPLATE_BASE="https://github.com/myorg"
dominds create web-scaffold my-app  # 解析为：https://github.com/myorg/web-scaffold.git

# 团队特定模板
export DOMINDS_TEMPLATE_BASE="https://github.com/mycompany/dominds-templates"
dominds create backend-service my-service  # 解析为：https://github.com/mycompany/dominds-templates/backend-service.git
```

**示例：**

```bash
# 首选：克隆搭建模板（包括 .minds/ 配置）
dominds create react-scaffold \
                 --repo-url git@github.com:myorg/new-react-app.git \
                 my-react-app
```

**生成的结构：**

```
project-directory/
├── .minds/
│   ├── team.yaml          # 团队配置（来自模板）
│   ├── llm.yaml          # LLM 提供商设置
│   └── toolsets/         # 自定义工具集定义（如果来自模板）
├── .gitignore            # Dominds 感知的 gitignore
├── README.md             # 包含 dominds 使用的项目 README
└── [template files...]   # 来自搭建的完整项目结构
```

**注意：** 搭建模板提供完整的项目设置，包括优化的 `.minds/` 配置、依赖和项目结构。这是新项目的推荐方法。

## TUI 命令选项

以下选项适用于 TUI（`dominds tui` 或 `dominds run`）命令：

### 更改工作区

```bash
dominds tui -C <directory> <taskdoc-path> [prompts...]
dominds tui --chdir <directory> <taskdoc-path> [prompts...]
```

在执行命令之前更改到指定的工作区。

**示例：**

```bash
dominds tui -C /path/to/project task.tsk "Start working on feature"
```

### 指定团队成员

```bash
dominds tui -m <member-id> <taskdoc-path> [prompts...]
dominds tui --member <member-id> <taskdoc-path> [prompts...]
```

使用特定的团队成员作为此对话的代理。

**示例：**

```bash
dominds tui -m alice task.tsk "Review the code"
dominds tui --member bob architecture.md "Design the new system"
```

### 恢复或使用自定义对话 ID

```bash
dominds tui -i <dialog-id> <taskdoc-path> [prompts...]
dominds tui --id <dialog-id> <taskdoc-path> [prompts...]
```

恢复现有对话或使用特定 ID 启动新对话。

**示例：**

```bash
# 恢复现有对话
dominds tui -i aa/bb/12345678 task.tsk "Continue where we left off"

# 使用自定义对话 ID 启动
dominds tui --id my/custom/id task.tsk "New task with custom ID"
```

## 使用示例

### 基本工作流程

```bash
# 启动 Web UI 以获得可视化界面
dominds

# 或使用 TUI 进行基于终端的工作流程
# 启动新对话
dominds tui project.md "Implement the login feature"

# 列出所有对话以查看新对话 ID
dominds tui --list

# 稍后恢复对话（使用 --list 中的 ID）
dominds tui -i aa/bb/12345678 project.md "Add password validation"

# 分析工作区配置
dominds read --validate
```

### 团队协作

```bash
# Alice 使用 TUI 开始架构工作
dominds tui -m alice architecture.md "Design the system architecture"

# Bob 通过 Web UI 审查 Alice 的工作
dominds  # 打开浏览器界面，选择对话和团队成员

# Charlie 在不同目录中使用 TUI 实现
dominds tui -C /path/to/project -m charlie task.tsk "Implement the API"

# 验证团队配置
dominds read /path/to/project/.minds --verbose
```

### 高级用法

```bash
# 使用搭建模板创建新工作区
dominds create web-scaffold my-project
cd my-project

# 验证设置
dominds read --validate

# 使用特定配置开始开发
dominds tui -C /workspace -m alice -i custom/dialog/id task.tsk "Initial prompt" "Additional context"

# 在 TUI 工作的同时通过 Web UI 监控
dominds &  # 在后台启动 Web UI
dominds tui task.tsk "Continue development"

# 任何命令的快速帮助
dominds tui --help
dominds read --help
dominds create --help
```

### 多界面工作流程

```bash
# 对不同任务使用不同的界面
dominds new research-scaffold my-research-project
cd my-research-project

dominds read                            # 验证配置
dominds                                 # 启动 Web UI 概览
dominds tui research.md "Begin analysis"  # 使用 TUI 进行专注工作
```

## 对话存储

对话存储在 `.dialogs/` 目录中，结构如下：

- `.dialogs/run/` - 活动对话
- `.dialogs/done/` - 已完成的对话
- `.dialogs/archive/` - 已归档的对话

每个对话目录包含：

- `dialog.yaml` - 对话元数据
- `latest.yaml` - 当前轮次 + lastModified 跟踪
- `round-001.jsonl`（以及更多轮次）- 流式消息文件
- `subdialogs/` - 嵌套子对话

## 错误处理

CLI 命令为常见问题提供有用的错误消息：

**TUI (`dominds tui`) 错误：**

- 缺少 Taskdoc 路径
- 无效的对话 ID
- 无法访问的目录
- 缺少团队配置
- 未知命令（例如 `invalid-command-xyz`）
  - 显示："Error: Unknown command: [command]. Use --help to see available commands."
  - 建议使用 `--help` 查看有效选项

**Web UI (`dominds`) 错误：**

- 端口冲突
- 缺少工作区配置
- 浏览器兼容性问题

**Minds 阅读器 (`dominds read`) 错误：**

- 无效的 minds 目录结构
- 格式错误的 YAML 配置
- 缺少必需的团队成员

**命令验证：**

TUI 现在包含改进的命令验证，可以：

- 识别有效命令（`list`、`--help`、`--version` 等）
- 识别无效命令模式（不是文件路径的短横线字符串）
- 提供带有解决建议的清晰错误消息
- 与现有 Taskdoc 路径保持向后兼容
- 工具集验证失败

**工作区创建 (`dominds create` / `dominds new`) 错误：**

- 模板下载的网络连接
- 目录权限问题
- Git 仓库访问问题
- 模板兼容性问题

**通用故障排除：**

```bash
# 检查工作区配置
dominds read --validate

# 获取特定命令的帮助
dominds tui --help
dominds read --help
dominds create --help

# 启动 Web UI 进行可视化调试
dominds

# 验证团队设置
dominds read .minds --verbose
```

遇到问题时，使用适当的帮助命令或启动 Web UI (`dominds`) 进行可视化调试。
