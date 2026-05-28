# CLI Usage Guide

Chinese version: [中文版](./cli-usage.zh.md)

The `dominds` CLI provides a unified entry point, but the **primary interaction experience is the Web UI** (the default `dominds` command). This guide focuses on the Web UI workflow.

> Note: In this document, **rtws (runtime workspace)** refers to the runtime root directory Dominds uses (by default the directory where `dominds` is launched, switchable via `-C <dir>`). Relative `-C` paths are resolved against the original launch directory by the `dominds` supervisor before the runner starts.

> Process model: in production, `dominds` is a lightweight supervisor. It parses global options such as `-C`, starts `dominds-runner` in the resolved rtws, keeps the terminal stdio attached to the runner, and restarts long-running WebUI runners after crashes with exponential backoff starting at 1 second and capped at 30 minutes. Self-update restarts are coordinated by this supervisor, so the old runner can fully exit and release server resources before the new runner starts; if the old runner does not exit after a restart request, the supervisor terminates it before starting the next runner. Development WebUI runs (`NODE_ENV=dev` or `--mode dev`, including `dev-server.sh`) bypass the supervisor and are managed by the development launcher instead.

> Note: `dominds tui` / `dominds run` are currently reserved subcommand names and do not have a stable implementation yet. As a result, this guide does not document TUI options or detailed usage.

## Table of Contents

- [CLI Usage Guide](#cli-usage-guide)
  - [Table of Contents](#table-of-contents)
  - [Available Commands](#available-commands)
  - [Quick Reference](#quick-reference)
  - [Core Commands](#core-commands)
    - [Web UI Interface](#web-ui-interface)
    - [Text User Interface (TUI) (Not Implemented Yet)](#text-user-interface-tui-not-implemented-yet)
    - [Minds Reader](#minds-reader)
    - [Certificate Tools](#certificate-tools)
    - [rtws Creation](#rtws-creation)
  - [Usage Examples](#usage-examples)
  - [Dialog Storage](#dialog-storage)
  - [Error Handling](#error-handling)

## Available Commands

The `dominds` package provides a unified CLI with subcommands:

| Command                           | Purpose                                                       | Interface Type |
| --------------------------------- | ------------------------------------------------------------- | -------------- |
| `dominds` or `dominds webui`      | Start Web UI (default, recommended)                           | Web UI         |
| `dominds tui` or `dominds run`    | Terminal UI (planned; no stable implementation at the moment) | N/A            |
| `dominds read`                    | Read and inspect rtws/team minds configuration                | CLI            |
| `dominds cert`                    | Create and inspect local WebUI HTTPS certificates             | CLI            |
| `dominds create` or `dominds new` | Create a new rtws (runtime workspace) from a template         | CLI            |
| `dominds help`                    | Show help message                                             | CLI            |
| `dominds --version`               | Show version information                                      | CLI            |

## Quick Reference

```bash
# Installation
npm install -g dominds
# (or) pnpm add -g dominds

# Web UI (default, recommended)
dominds
dominds webui [options]

# Common: choose port / rtws
dominds webui -p 8080
dominds webui -C /path/to/my-rtws

# Minds reader: inspect team configuration
dominds read [options] [member-id]

# Certificate tools: create/inspect local HTTPS certificates
dominds cert create [--host <host>] [--days <days>] [--force]
dominds cert status [--host <host>] [--port <port>] [--origin]

# rtws creation: scaffold a new runtime workspace
dominds create <template> [directory]
dominds new <template> [directory]  # alias for create

# Help
dominds --help
dominds webui --help
dominds read --help
dominds create --help

# TUI (planned; currently not implemented in a stable way)
# dominds tui ...
```

## Core Commands

### Web UI Interface

```bash
dominds
dominds webui [options]
```

Start the web-based user interface for the current rtws. This provides a graphical interface in your browser for managing dialogs, viewing streaming output, and interacting with your AI team.

**Options:**

- `-p, --port <port>` - Port to listen on; a bare port binds strictly, suffix `+` tries higher ports, and suffix `-` tries lower ports (omitting `--port` is equivalent to `5666-`)
- `-h, --host <host>` - Host to bind to (default: localhost)
- `-C, --cwd <dir>` - Change to rtws directory before starting; relative paths are resolved against the original launch directory
- `--help` - Show help message

**Examples:**

```bash
dominds
dominds webui -p 8080
dominds webui -p 8080+
dominds webui -C /path/to/my-rtws
dominds -C ux-rtws webui
```

**Common use cases:**

- Visual dialog management and playback
- Real-time streaming display (thinking / saying segments)
- Team member selection and switching
- Configuration/assets management (rtws `.minds/`)

### Text User Interface (TUI) (Not Implemented Yet)

`dominds tui` / `dominds run` are currently reserved subcommand names and do not have a stable interactive terminal experience yet.

Use the Web UI as the primary interface. For inspecting rtws/team configuration, use `dominds read`.

### Minds Reader

```bash
dominds read [options] [member-id]
```

Read and inspect agent prompts/configuration for the rtws. This is commonly used to debug team setup and confirm what is currently effective.

**Arguments:**

- `member-id` - Optional team member ID (default: all members)

**Options:**

- `-C, --cwd <dir>` - Change to rtws directory before reading; relative paths are resolved against the original launch directory
- `--only-prompt` - Show only system prompts
- `--only-mem` - Show only memory
- `--help` - Show help message

**Examples:**

```bash
dominds read
dominds read developer
dominds read -C /path/to/my-rtws
dominds read --only-prompt
dominds read --only-mem
```

### Certificate Tools

```bash
dominds cert create [--host <host>] [--days <days>] [--force]
dominds cert status [--host <host>] [--port <port>] [--origin]
```

Create or inspect local HTTPS certificates for the Dominds WebUI. Dominds generates certificates through npm dependencies, so no separate `openssl` command is required. Certificates live in `~/.dominds/certs/` and match DNS/IP hostnames, not ports; one certificate covers every WebUI port on that host.

**Options:**

- `--host <host>` - Certificate SAN hostname or IP; repeatable for certificate creation; defaults to one or more detected non-loopback LAN hosts
- `--days <days>` - Certificate validity in days (default: 3650, or 10 years)
- `--force` - Overwrite existing generated files
- `--port <port>` - Port used when formatting `status --origin`
- `--origin` - Print only the effective origin; HTTPS when a cert matches, HTTP otherwise

**Examples:**

```bash
dominds cert create
dominds cert create --host 192.168.1.10 --host my-host.local
dominds cert status
dominds cert status --port 5666 --origin
```

`localhost`, `loopback`, `127.0.0.0/8`, `169.254.0.0/16`, `::1`, `fe80::/10`, `0.0.0.0`, and `::` are not certificate hosts. `0.0.0.0` / `::` only mean bind-all; certificate matching uses detected non-loopback LAN hosts.

### rtws Creation

```bash
dominds create <template> [directory]
dominds new <template> [directory]  # alias for create
```

Create a new dominds-powered rtws (runtime workspace) by cloning/scaffolding from a template repository with preconfigured `.minds/`.

**Arguments:**

- `template` - Template name or Git URL (required)
- `directory` - Target directory name (optional; defaults to a template-derived name)

**Scaffolding:**

```bash
dominds create|new <template> [directory]

dominds create web-scaffold my-web-app
dominds create api-scaffold my-api
dominds create fullstack-scaffold my-app

dominds create https://github.com/myorg/custom-template.git my-project

dominds create web-scaffold \
                 --repo-url https://github.com/myorg/new-project.git \
                 my-project
```

When `--repo-url` is provided, `dominds create` clones the template, sets the cloned rtws directory’s `origin` remote to the given URL, and keeps the original template URL as a separate `template` remote for reference.

**Template resolution:**

Short template names are resolved via the `DOMINDS_TEMPLATE_BASE` environment variable:

```bash
export DOMINDS_TEMPLATE_BASE="https://github.com/longrun-ai"

export DOMINDS_TEMPLATE_BASE="https://github.com/myorg"
dominds create web-scaffold my-app  # resolves to https://github.com/myorg/web-scaffold.git
```

## Usage Examples

```bash
# 1) Start Web UI (default)
dominds

# 2) Use a different port (avoid conflicts)
dominds webui -p 8080

# 3) Start in a specific rtws
dominds webui -C /path/to/my-rtws

# 4) Inspect current team/rtws configuration
dominds read
```

## Dialog Storage

Runtime dialog data is stored under the rtws `.dialogs/` directory (managed by Dominds). A typical layout:

- `.dialogs/run/` - Active dialogs
- `.dialogs/done/` - Completed dialogs
- `.dialogs/archive/` - Archived dialogs

Each dialog directory typically contains:

- `dialog.yaml` - Dialog metadata
- `latest.yaml` - Current turn + lastModified tracking
- `course-001.jsonl` (and more) - Streamed message log
- `sideDialogs/` - Nested sideDialogs

## Error Handling

**Web UI (`dominds` / `dominds webui`) common issues:**

- Port conflicts: choose a different port (e.g. `dominds webui -p 8080`)
- Missing `.minds/` in the rtws: initialize or create via templates (or ensure `-C` points to the right directory)

**Minds reader (`dominds read`) common issues:**

- Invalid YAML: fix configuration under `.minds/` and retry
- Missing required team members/assets: review `team.yaml` and related files

**rtws creation (`dominds create` / `dominds new`) common issues:**

- Network/permissions: verify Git access and filesystem permissions
- Template resolution: verify `DOMINDS_TEMPLATE_BASE` or the template URL

**General troubleshooting:**

```bash
dominds --help
dominds webui --help
dominds read --help
dominds create --help
```
