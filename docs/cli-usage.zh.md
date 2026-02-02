# CLI 使用指南

`dominds` 提供统一的命令行入口，但**主要交互界面是 Web UI**（默认命令 `dominds`）。本文档以 Web UI 工作流为主。

> 说明：`dominds tui` / `dominds run` 相关功能目前尚未提供稳定实现（子命令名保留用于未来规划），因此本指南不再展开 TUI 的命令选项与用法细节。

## 目录

- [CLI 使用指南](#cli-使用指南)
  - [目录](#目录)
  - [可用命令](#可用命令)
  - [快速参考](#快速参考)
  - [核心命令](#核心命令)
    - [Web UI 界面](#web-ui-界面)
    - [文本用户界面 (TUI)（尚未实现）](#文本用户界面-tui尚未实现)
    - [Minds 阅读器](#minds-阅读器)
    - [工作区创建](#工作区创建)
  - [使用示例](#使用示例)
  - [对话存储](#对话存储)
  - [错误处理](#错误处理)

## 可用命令

`dominds` 包提供带有子命令的统一 CLI：

| 命令                              | 用途                                     | 界面类型 |
| --------------------------------- | ---------------------------------------- | -------- |
| `dominds` 或 `dominds webui`      | 启动 Web UI（默认、推荐）                | Web UI   |
| `dominds tui` 或 `dominds run`    | 终端界面（规划中；当前版本暂不提供稳定） | N/A      |
| `dominds read`                    | 读取/分析团队 minds 配置                 | CLI      |
| `dominds create` 或 `dominds new` | 从模板创建新工作区                       | CLI      |
| `dominds help`                    | 显示帮助消息                             | CLI      |
| `dominds --version`               | 显示版本信息                             | CLI      |

## 快速参考

```bash
# 安装
npm install -g dominds
# (或) pnpm add -g dominds

# Web UI（默认、推荐）
dominds
dominds webui [options]

# 常用：指定端口 / 工作区
dominds webui -p 8080
dominds webui -C ./my-workspace

# Minds 阅读器：分析团队配置
dominds read [options] [member-id]

# 工作区创建：搭建新项目/工作区
dominds create <template> [directory]
dominds new <template> [directory]  # create 的别名

# 帮助
dominds --help
dominds webui --help
dominds read --help
dominds create --help

# TUI（规划中，当前版本暂不提供稳定实现）
# dominds tui ...
```

## 核心命令

### Web UI 界面

```bash
dominds
dominds webui [options]
```

为当前工作区启动基于 Web 的用户界面。这会在浏览器中提供图形界面，用于管理对话、查看流式输出、以及与 AI 团队交互。

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

**常见用途：**

- 可视化对话管理与回放
- 实时流式显示（thinking / saying 等分段）
- 团队成员选择与切换
- 配置与资产管理（基于工作区 `.minds/`）

### 文本用户界面 (TUI)（尚未实现）

`dominds tui` / `dominds run` 子命令名目前仅作保留，尚未提供稳定可用的终端交互体验。

如需使用 Dominds，请以 Web UI 为主要入口；涉及团队配置读取可使用 `dominds read`。

### Minds 阅读器

```bash
dominds read [options] [member-id]
```

读取代理系统提示词与工作区配置，常用于排查团队设置问题与核对当前生效配置。

**参数：**

- `member-id` - 可选的团队成员 ID（默认：所有成员）

**选项：**

- `-C, --cwd <dir>` - 读取前更改工作区目录
- `--only-prompt` - 仅显示系统提示词
- `--only-mem` - 仅显示内存
- `--help` - 显示帮助消息

**示例：**

```bash
dominds read
dominds read developer
dominds read -C ./my-workspace
dominds read --only-prompt
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
```

## 使用示例

```bash
# 1) 启动 Web UI（默认）
dominds

# 2) 在特定端口启动（避免端口冲突）
dominds webui -p 8080

# 3) 在特定工作区启动
dominds webui -C ./my-workspace

# 4) 查看/核对当前团队配置
dominds read
```

## 对话存储

对话运行态与持久化文件默认存储在工作区的 `.dialogs/` 目录中（由 Dominds 管理）。典型结构示例：

- `.dialogs/run/` - 活动对话
- `.dialogs/done/` - 已完成的对话
- `.dialogs/archive/` - 已归档的对话

每个对话目录通常包含：

- `dialog.yaml` - 对话元数据
- `latest.yaml` - 当前轮次 + lastModified 跟踪
- `course-001.jsonl`（以及更多对话程）- 流式消息文件
- `subdialogs/` - 嵌套子对话

## 错误处理

**Web UI (`dominds` / `dominds webui`) 常见问题：**

- 端口冲突：换端口（例如 `dominds webui -p 8080`）
- 工作区缺少 `.minds/`：请先初始化/使用模板创建工作区（或确认 `-C` 指向正确目录）

**Minds 阅读器 (`dominds read`) 常见问题：**

- YAML 格式错误：修复 `.minds/` 中的配置文件后重试
- 缺少必需团队成员：检查 `team.yaml` 与相关 i18n/资产是否齐全

**工作区创建 (`dominds create` / `dominds new`) 常见问题：**

- 网络/权限问题：确认 Git 访问与目录权限
- 模板解析错误：确认 `DOMINDS_TEMPLATE_BASE` 或模板 URL

**通用故障排除：**

```bash
dominds --help
dominds webui --help
dominds read --help
dominds create --help
```
