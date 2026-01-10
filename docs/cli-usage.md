# CLI Usage Guide

The `dominds` package provides multiple command-line interfaces for different aspects of the DevOps Mindsets AI team functionality.

## Table of Contents

- [CLI Usage Guide](#cli-usage-guide)
  - [Table of Contents](#table-of-contents)
  - [Available Commands](#available-commands)
  - [Quick Reference](#quick-reference)
  - [Core Commands](#core-commands)
    - [Web UI Interface](#web-ui-interface)
    - [Text User Interface (TUI)](#text-user-interface-tui)
    - [Minds Reader](#minds-reader)
    - [Workspace Initialization](#workspace-initialization)
  - [TUI Command Options](#tui-command-options)
    - [Change Workspace](#change-workspace)
    - [Specify Team Member](#specify-team-member)
    - [Resume or Use Custom Dialog ID](#resume-or-use-custom-dialog-id)
  - [Usage Examples](#usage-examples)
    - [Basic Workflow](#basic-workflow)
    - [Team Collaboration](#team-collaboration)
    - [Advanced Usage](#advanced-usage)
  - [Dialog Storage](#dialog-storage)
  - [Error Handling](#error-handling)

## Available Commands

The `dominds` package provides a unified CLI with subcommands:

| Command                        | Purpose                                     | Interface Type            |
| ------------------------------ | ------------------------------------------- | ------------------------- |
| `dominds` or `dominds webui`   | Web-based user interface (default)          | Web UI                    |
| `dominds tui` or `dominds run` | Terminal-based dialog interface             | TUI (Text User Interface) |
| `dominds read`                 | Read and analyze agent minds configurations | CLI Utility               |
| `dominds init`                 | Initialize new workspace                    | CLI Utility               |
| `dominds help`                 | Show help message                           | CLI Utility               |
| `dominds --version`            | Show version information                    | CLI Utility               |

## Quick Reference

```bash
# Installation
pnpm add -g dominds

# For development/testing (using pnpm link)
cd /path/to/dominds
pnpm install
pnpm run build
pnpm link --global
# Now 'dominds' command is available globally

# Web UI - Graphical interface in browser (default)
dominds
dominds webui [options]

# TUI - Terminal-based interactive interface
dominds tui [options] <task-doc-path> [prompts...]
dominds run [options] <task-doc-path> [prompts...]  # alias for tui
dominds tui --list
dominds tui --help

# Minds reader - Analyze team configurations
dominds read [options] [member-id]

# General help
dominds --help
dominds help

# Workspace initialization - Set up new projects
dominds init [options] [directory]
```

## Core Commands

### Web UI Interface

```bash
dominds
dominds webui [options]
```

Start the web-based user interface for the current workspace. This provides a graphical interface in your browser for managing dialogs and interacting with your AI team.

**Options:**

- `-p, --port <port>` - Port to listen on (default: 5555)
- `-h, --host <host>` - Host to bind to (default: localhost)
- `-C, --cwd <dir>` - Change to workspace directory before starting
- `--help` - Show help message

**Examples:**

```bash
# Start Web UI on default port
dominds

# Start Web UI on specific port
dominds webui -p 8080

# Start Web UI in specific workspace
dominds webui -C ./my-workspace
```

**Features:**

- Visual dialog management
- Real-time streaming display
- File browser integration
- Team member selection
- Interactive configuration

### Text User Interface (TUI)

The TUI provides terminal-based interactive dialog management with real-time streaming. It supports both interactive and non-interactive modes, making it suitable for CI/CD environments.

#### Start or Continue a Dialog

```bash
dominds tui <task-doc-path> [prompts...]
dominds run <task-doc-path> [prompts...]  # alias for tui
```

Start a new dialog or continue an existing one with the specified task document.

**Arguments:**

- `task-doc-path` - Path to the task document (required, usually a .md file)
- `prompts` - Optional initial prompts to start the dialog with

**Examples:**

```bash
# Start a new dialog with a task document
dominds tui task.md "Implement user authentication"

# Use the run alias
dominds run task.md "Implement user authentication"

# Start with multiple prompts
dominds tui project-plan.md "Review the architecture" "Suggest improvements"

# Simple task without initial prompts
dominds tui bug-fix.md
```

#### List All Dialogs

```bash
dominds tui --list
dominds run --list  # alias for tui
```

Display all dialogs organized by status:

- **Running** - Currently active dialogs
- **Completed** - Finished dialogs
- **Archived** - Archived dialogs

Each dialog entry shows:

- Dialog ID (3-segment format: aa/bb/cccccccc)
- Agent ID (team member handling the dialog)

#### Design Philosophy: User-First Command Space

dominds follows a **user-first design philosophy** where:

- **All dominds commands require `--` prefix** (e.g., `--list`, `--help`, `--version`)
- **All bare arguments are reserved for users** (task documents, prompts, user files)
- **No competition for command namespace** - users can freely name their files `list`, `help`, etc.

**Examples:**

```bash
# dominds commands (always use --)
dominds tui --list          # List dialogs
dominds tui --help          # Show help
dominds tui --version       # Show version

# User files (no conflicts)
dominds tui list            # Opens user's 'list' file
dominds tui help.md         # Opens user's 'help.md' file
dominds tui version-notes   # Opens user's 'version-notes' file
```

**Benefits:**

- **Zero ambiguity** - clear separation between commands and user files
- **User convenience** - name your task documents anything without worry
- **Predictable behavior** - bare arguments are always user content
- **Future-proof** - new dominds commands won't break existing workflows
- Status

For empty workspaces, displays helpful instructions on how to start a new dialog.

#### Show Version

```bash
dominds tui --version
```

Display the current version of the dominds package.

#### Show Help

```bash
dominds tui --help
dominds tui -h
```

Display usage information and available options for the TUI.

#### Get Help for Specific Commands

```bash
dominds tui --list --help
```

Display detailed help information for the `--list` command.

#### CI/CD Support

The TUI automatically detects CI environments and switches to non-interactive mode, making it suitable for automated workflows:

- Disables terminal manipulation in CI environments
- Outputs directly to stdout/stderr for proper logging
- Maintains full functionality without interactive features
- Supports all commands in both interactive and non-interactive modes

### Minds Reader

```bash
dominds read [options] [member-id]
```

Read agent system prompts and memories with filtering flags.

**Purpose:**

- View team member configurations
- Analyze system prompts
- Examine agent memories
- Debug team setup issues

**Arguments:**

- `member-id` - Optional team member ID to read (default: all members)

**Options:**

- `-C, --cwd <dir>` - Change to workspace directory before reading
- `--only-prompt` - Show only system prompt
- `--only-mem` - Show only memories
- `--help` - Show help message

**Examples:**

```bash
# Read all team members in current workspace
dominds read

# Read specific team member
dominds read developer

# Read from specific workspace
dominds read -C ./my-workspace

# Show only system prompts
dominds read --only-prompt

# Show only memories
dominds read --only-mem
```

### Workspace Initialization

```bash
dominds init [options] [directory]
```

Initialize a new dominds-powered workspace. **Preferred approach**: Use scaffold templates that include pre-configured `.minds/` setup for specific project types.

**Arguments:**

- `directory` - Target directory name (optional, defaults to current workspace)

**Primary Usage - Scaffold Templates:**

```bash
# Recommended: Use scaffold templates with pre-configured teams
dominds init <template> [directory]

# Short form for official templates (uses DOMINDS_TEMPLATE_BASE)
dominds init web-scaffold my-web-app
dominds init api-scaffold my-api
dominds init cli-scaffold my-cli
dominds init fullstack-scaffold my-app

# Full GitHub URLs for custom templates
dominds init https://github.com/myorg/custom-template.git my-project

# With custom repository setup
dominds init web-scaffold \
                 --repo-url https://github.com/myorg/new-project.git \
                 my-project
```

**Template Resolution:**

Short template names are resolved using the `DOMINDS_TEMPLATE_BASE` environment variable:

```bash
# Default template base (if DOMINDS_TEMPLATE_BASE not set)
export DOMINDS_TEMPLATE_BASE="https://github.com/longrun-ai"

# Custom organization templates
export DOMINDS_TEMPLATE_BASE="https://github.com/myorg"
dominds init web-scaffold my-app  # Resolves to: https://github.com/myorg/web-scaffold.git

# Team-specific templates
export DOMINDS_TEMPLATE_BASE="https://github.com/mycompany/dominds-templates"
dominds init backend-service my-service  # Resolves to: https://github.com/mycompany/dominds-templates/backend-service.git
```

**Fallback - Basic Team Configurations:**

Use these only when no suitable scaffold template exists:

```bash
# One Man Army - do what's on the only agent's first thoughts
dominds init --1ma

# Fresh Boots Reasoning - solo doer agent, second thoughts with fresh minds adviced
dominds init --fbr

# Plan and Execution - two agents with basic division of work
dominds init --pnx

# Inteligence Guarded Execution - one more differently-minded criticist agent
dominds init --igx
```

**Examples:**

```bash
# Preferred: Clone scaffold template (includes .minds/ configuration)
dominds init react-scaffold \
                 --repo-url git@github.com:myorg/new-react-app.git \
                 my-react-app

# One Man Army - do what's on the only agent's first thoughts
dominds init --1ma

# Fresh Boots Reasoning - solo doer agent, second thoughts with fresh minds adviced
dominds init --fbr

# Plan and Execution - two agents with basic division of work
dominds init --pnx

# Inteligence Guarded Execution - one more differently-minded criticist agent
dominds init --igx
```

**Team Configuration Details:**

- **--1ma**: One man army - single agent (`agent`) handles all development tasks with standard toolsets
- **--fbr**: Single fresh-boots-reasoner agent (`agent`) that creates fresh minds for each work item to do, ensuring clean reasoning without context pollution
- **--pnx**: Two-agent setup with `planner` (strategic thinking) and `executor` (implementation) for collaborative workflows
- **--igx**: Intelligence-Guarded Execution - adds a `critic` agent that reviews plans and changes to improve safety and reasoning quality

**Generated Structure:**

```
project-directory/
├── .minds/
│   ├── team.yaml          # Team configuration (from template or generated)
│   ├── llm.yaml          # LLM provider settings
│   └── toolsets/         # Custom toolset definitions (if from template)
├── .gitignore            # Dominds-aware gitignore
├── README.md             # Project README with dominds usage
└── [template files...]   # Complete project structure from scaffold
```

**Note:** Scaffold templates provide complete project setups with optimized `.minds/` configurations, dependencies, and project structure. This is the recommended approach for new projects.

## TUI Command Options

The following options are available for the TUI (`dominds tui` or `dominds run`) command:

### Change Workspace

```bash
dominds tui -C <directory> <task-doc-path> [prompts...]
dominds tui --chdir <directory> <task-doc-path> [prompts...]
```

Change to the specified workspace before executing the command.

**Example:**

```bash
dominds tui -C /path/to/project task.md "Start working on feature"
```

### Specify Team Member

```bash
dominds tui -m <member-id> <task-doc-path> [prompts...]
dominds tui --member <member-id> <task-doc-path> [prompts...]
```

Use a specific team member as the agent for this dialog.

**Example:**

```bash
dominds tui -m alice task.md "Review the code"
dominds tui --member bob architecture.md "Design the new system"
```

### Resume or Use Custom Dialog ID

```bash
dominds tui -i <dialog-id> <task-doc-path> [prompts...]
dominds tui --id <dialog-id> <task-doc-path> [prompts...]
```

Resume an existing dialog or start a new dialog with a specific ID.

**Examples:**

```bash
# Resume an existing dialog
dominds tui -i aa/bb/12345678 task.md "Continue where we left off"

# Start with a custom dialog ID
dominds tui --id my/custom/id task.md "New task with custom ID"
```

## Usage Examples

### Basic Workflow

```bash
# Start the Web UI for visual interface
dominds

# Or use TUI for terminal-based workflow
# Start a new dialog
dominds tui project.md "Implement the login feature"

# List all dialogs to see the new dialog ID
dominds tui --list

# Resume the dialog later (using the ID from --list)
dominds tui -i aa/bb/12345678 project.md "Add password validation"

# Analyze workspace configuration
dominds read --validate
```

### Team Collaboration

```bash
# Alice starts working on architecture using TUI
dominds tui -m alice architecture.md "Design the system architecture"

# Bob reviews Alice's work via Web UI
dominds  # Opens browser interface, select dialog and team member

# Charlie implements using TUI in different directory
dominds tui -C /path/to/project -m charlie task.md "Implement the API"

# Validate team configuration
dominds read /path/to/project/.minds --verbose
```

### Advanced Usage

```bash
# Initialize new workspace with scaffold
dominds init web-scaffold my-project
cd my-project

# Verify setup
dominds read --validate

# Start development with specific configuration
dominds tui -C /workspace -m alice -i custom/dialog/id task.md "Initial prompt" "Additional context"

# Monitor via Web UI while working in TUI
dominds &  # Start Web UI in background
dominds tui task.md "Continue development"

# Quick help for any command
dominds tui --help
dominds read --help
dominds init --help
```

### Multi-Interface Workflow

```bash
# Use different interfaces for different tasks
dominds init --fbr my-research-project  # Initialize workspace
cd my-research-project

dominds read                            # Validate configuration
dominds                                 # Start Web UI for overview
dominds tui research.md "Begin analysis"  # Use TUI for focused work
```

## Dialog Storage

Dialogs are stored in the `.dialogs/` directory with the following structure:

- `.dialogs/run/` - Active dialogs
- `.dialogs/done/` - Completed dialogs
- `.dialogs/archive/` - Archived dialogs

Each dialog directory contains:

- `dialog.yaml` - Dialog metadata
- `round.curr` - Current round tracking
- `*.jsonl` - Streamed message files
- `subdialogs/` - Nested subdialogs

## Error Handling

The CLI commands provide helpful error messages for common issues:

**TUI (`dominds tui`) Errors:**

- Missing task document path
- Invalid dialog IDs
- Inaccessible directories
- Missing team configuration
- Unknown commands (e.g., `invalid-command-xyz`)
  - Displays: "Error: Unknown command: [command]. Use --help to see available commands."
  - Suggests using `--help` for valid options

**Web UI (`dominds`) Errors:**

- Port conflicts
- Missing workspace configuration
- Browser compatibility issues

**Minds Reader (`dominds read`) Errors:**

- Invalid minds directory structure
- Malformed YAML configurations
- Missing required team members

**Command Validation:**

The TUI now includes improved command validation that:

- Recognizes valid commands (`list`, `--help`, `--version`, etc.)
- Identifies invalid command patterns (strings with dashes that aren't file paths)
- Provides clear error messages with suggestions for resolution
- Maintains backward compatibility with existing task document paths
- Toolset validation failures

**Workspace Init (`dominds init`) Errors:**

- Network connectivity for template downloads
- Directory permission issues
- Git repository access problems
- Template compatibility issues

**General Troubleshooting:**

```bash
# Check workspace configuration
dominds read --validate

# Get help for specific commands
dominds tui --help
dominds read --help
dominds init --help

# Start Web UI for visual debugging
dominds

# Verify team setup
dominds read .minds --verbose
```

Use the appropriate help command or start the Web UI (`dominds`) for visual debugging when encountering issues.
