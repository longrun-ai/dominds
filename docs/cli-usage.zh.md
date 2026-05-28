# CLI 使用指南

英文版：[English](./cli-usage.md)

`dominds` 提供统一的命令行入口，但**主要交互界面是 Web UI**（默认命令 `dominds`）。本文档以 Web UI 工作流为主。

> 注：本文统一使用 **rtws（运行时工作区）** 表示 Dominds 运行时使用的根目录（默认是启动 `dominds` 时所在目录，可通过 `-C <dir>` 切换）。相对路径形式的 `-C` 由 `dominds` supervisor 按原始启动目录解析为绝对路径，再启动 runner。

> 进程模型：生产模式下，`dominds` 是轻量 supervisor，负责解析 `-C` 等全局选项、在解析后的 rtws 中启动 `dominds-runner`、让 runner 继承当前终端 stdio，并在长期运行的 WebUI runner 崩溃后用指数退避保活重启（初始 1 秒，最长 30 分钟）。self-update 重启也由 supervisor 协调，因此旧 runner 可以完整退出并释放 server 资源，再启动新版 runner；如果旧 runner 在发出重启请求后仍不退出，supervisor 会终止它再启动下一轮 runner。开发模式 WebUI（`NODE_ENV=dev` 或 `--mode dev`，包括 `dev-server.sh`）不走 supervisor，由开发启动器自行管理。

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
    - [证书工具](#证书工具)
    - [rtws 创建](#rtws-创建)
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
| `dominds cert`                    | 创建/检查本机 WebUI HTTPS 证书           | CLI      |
| `dominds create` 或 `dominds new` | 从模板创建新 rtws（运行时工作区）        | CLI      |
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

# 常用：指定端口 / rtws
dominds webui -p 8080
dominds webui -C /path/to/my-rtws

# Minds 阅读器：分析团队配置
dominds read [options] [member-id]

# 证书工具：创建/检查本机 HTTPS 证书
dominds cert create [--host <host>] [--days <days>] [--force]
dominds cert status [--host <host>] [--port <port>] [--origin]

# rtws 创建：搭建新项目/运行时工作区
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

为当前 rtws 启动基于 Web 的用户界面。这会在浏览器中提供图形界面，用于管理对话、查看流式输出、以及与 AI 团队交互。

**选项：**

- `-p, --port <port>` - 监听端口；裸端口严格绑定，后缀 `+` 向更大端口自动尝试，后缀 `-` 向更小端口自动尝试（未指定时等价于 `5666-`）
- `-h, --host <host>` - 绑定的主机（默认：localhost）
- `-C, --cwd <dir>` - 启动前更改 rtws 目录；相对路径按原始启动目录解析
- `--help` - 显示帮助消息

**示例：**

```bash
# 从 5666 开始，向更小端口尝试可用端口
dominds

# 严格绑定 8080；占用时启动失败
dominds webui -p 8080

# 从 8080 开始，向更大端口尝试可用端口
dominds webui -p 8080+

# 在特定 rtws 启动 Web UI
dominds webui -C /path/to/my-rtws
dominds -C ux-rtws webui
```

**常见用途：**

- 可视化对话管理与回放
- 实时流式显示（thinking / saying 等分段）
- 团队成员选择与切换
- 配置与资产管理（基于 rtws `.minds/`）

### 文本用户界面 (TUI)（尚未实现）

`dominds tui` / `dominds run` 子命令名目前仅作保留，尚未提供稳定可用的终端交互体验。

如需使用 Dominds，请以 Web UI 为主要入口；涉及团队配置读取可使用 `dominds read`。

### Minds 阅读器

```bash
dominds read [options] [member-id]
```

读取智能体系统提示词与 rtws 配置，常用于排查团队设置问题与核对当前生效配置。

**参数：**

- `member-id` - 可选的团队成员 ID（默认：所有成员）

**选项：**

- `-C, --cwd <dir>` - 读取前更改 rtws 目录；相对路径按原始启动目录解析
- `--only-prompt` - 仅显示系统提示词
- `--only-mem` - 仅显示内存
- `--help` - 显示帮助消息

**示例：**

```bash
dominds read
dominds read developer
dominds read -C /path/to/my-rtws
dominds read --only-prompt
dominds read --only-mem
```

### 证书工具

```bash
dominds cert create [--host <host>] [--days <days>] [--force]
dominds cert status [--host <host>] [--port <port>] [--origin]
```

创建或检查 Dominds WebUI 的本机 HTTPS 证书。证书保存在 `~/.dominds/certs/`，按 DNS/IP 主机名匹配，不绑定端口；同一张证书可覆盖该主机上的所有 WebUI 端口。

**选项：**

- `--host <host>` - 证书 SAN 主机名或 IP；创建证书时可重复指定；未指定时使用检测到的一个或多个非 loopback LAN 主机
- `--days <days>` - 证书有效天数（默认：3650，即 10 年）
- `--force` - 覆盖已有的同名生成文件
- `--port <port>` - `status --origin` 输出 URL 时使用的端口
- `--origin` - 仅输出有效访问 origin；找到证书时输出 HTTPS，否则输出 HTTP

**示例：**

```bash
dominds cert create
dominds cert create --host 192.168.1.10 --host my-host.local
dominds cert status
dominds cert status --port 5666 --origin
```

`localhost`、`loopback`、`127.0.0.0/8`、`169.254.0.0/16`、`::1`、`fe80::/10`、`0.0.0.0`、`::` 不会作为 HTTPS 证书主机。`0.0.0.0` / `::` 只表示绑定所有地址，匹配证书时会使用检测到的非 loopback LAN 主机。

### rtws 创建

```bash
dominds create <template> [directory]
dominds new <template> [directory]  # create 的别名
```

通过克隆/搭建包含预配置 `.minds/` 设置的模板仓库来创建新的 dominds 驱动的 rtws（运行时工作区）。

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

当提供 `--repo-url` 时，`dominds create` 克隆模板，然后将克隆得到的 rtws 目录的 `origin` 远程设置为提供的 URL，并将原始模板 URL 作为单独的 `template` 远程保留以供参考。

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

# 3) 在特定 rtws 启动
dominds webui -C /path/to/my-rtws

# 4) 查看/核对当前团队配置
dominds read
```

## 对话存储

对话运行态与持久化文件默认存储在 rtws 的 `.dialogs/` 目录中（由 Dominds 管理）。典型结构示例：

- `.dialogs/run/` - 活动对话
- `.dialogs/done/` - 已完成的对话
- `.dialogs/archive/` - 已归档的对话

每个对话目录通常包含：

- `dialog.yaml` - 对话元数据
- `latest.yaml` - 当前对话过程编号 + lastModified 跟踪
- `course-001.jsonl`（第 1 程对话，后续还可以有编号递增的多程）- 流式消息文件
- `sideDialogs/` - 嵌套支线对话

## 错误处理

**Web UI (`dominds` / `dominds webui`) 常见问题：**

- 端口冲突：换端口（例如 `dominds webui -p 8080`）
- rtws 缺少 `.minds/`：请先初始化/使用模板创建 rtws（或确认 `-C` 指向正确目录）

**Minds 阅读器 (`dominds read`) 常见问题：**

- YAML 格式错误：修复 `.minds/` 中的配置文件后重试
- 缺少必需团队成员：检查 `team.yaml` 与相关 i18n/资产是否齐全

**rtws 创建 (`dominds create` / `dominds new`) 常见问题：**

- 网络/权限问题：确认 Git 访问与目录权限
- 模板解析错误：确认 `DOMINDS_TEMPLATE_BASE` 或模板 URL

**通用故障排除：**

```bash
dominds --help
dominds webui --help
dominds read --help
dominds create --help
```
