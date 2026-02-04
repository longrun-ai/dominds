# CLI Usage Guide

The `dominds` CLI provides a unified entry point, but the **primary interaction experience is the Web UI** (the default `dominds` command). This guide focuses on the Web UI workflow.

> Note: In this document, **rtws (runtime workspace)** refers to the runtime root directory Dominds uses (by default `process.cwd()`, switchable via `-C <dir>`).

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
dominds webui -C ./my-rtws

# Minds reader: inspect team configuration
dominds read [options] [member-id]

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

- `-p, --port <port>` - Port to listen on (default: 5555)
- `-h, --host <host>` - Host to bind to (default: localhost)
- `-C, --cwd <dir>` - Change to rtws directory before starting
- `--help` - Show help message

**Examples:**

```bash
dominds
dominds webui -p 8080
dominds webui -C ./my-rtws
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

- `-C, --cwd <dir>` - Change to rtws directory before reading
- `--only-prompt` - Show only system prompts
- `--only-mem` - Show only memory
- `--help` - Show help message

**Examples:**

```bash
dominds read
dominds read developer
dominds read -C ./my-rtws
dominds read --only-prompt
dominds read --only-mem
```

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
dominds webui -C ./my-rtws

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
- `subdialogs/` - Nested subdialogs

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
