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
    - [Workspace Creation](#workspace-creation)
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

| Command                           | Purpose                                     | Interface Type            |
| --------------------------------- | ------------------------------------------- | ------------------------- |
| `dominds` or `dominds webui`      | Web-based user interface (default)          | Web UI                    |
| `dominds tui` or `dominds run`    | Terminal-based dialog interface             | TUI (Text User Interface) |
| `dominds read`                    | Read and analyze agent minds configurations | CLI Utility               |
| `dominds create` or `dominds new` | Create a new workspace from a template      | CLI Utility               |
| `dominds help`                    | Show help message                           | CLI Utility               |
| `dominds --version`               | Show version information                    | CLI Utility               |

## Quick Reference

```bash
# Installation
npm install -g dominds
# (or) pnpm add -g dominds

# Web UI - Graphical interface in browser (default)
dominds
dominds webui [options]

# TUI - Terminal-based interactive interface
dominds tui [options] <taskdoc-path> [prompts...]
dominds run [options] <taskdoc-path> [prompts...]  # alias for tui
dominds tui --list
dominds tui --help

# Minds reader - Analyze team configurations
dominds read [options] [member-id]

# General help
dominds --help
dominds help

# Workspace creation - Scaffold a new project/workspace
dominds create <template> [directory]
dominds new <template> [directory]  # alias for create
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
dominds tui <taskdoc-path> [prompts...]
dominds run <taskdoc-path> [prompts...]  # alias for tui
```

Start a new dialog or continue an existing one with the specified Taskdoc.

**Arguments:**

- `taskdoc-path` - Path to the Taskdoc (required, usually a `.tsk/` package directory)
- `prompts` - Optional initial prompts to start the dialog with

**Examples:**

```bash
# Start a new dialog with a Taskdoc
dominds tui task.tsk "Implement user authentication"

# Use the run alias
dominds run task.tsk "Implement user authentication"

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
- **All bare arguments are reserved for users** (Taskdocs, prompts, user files)
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
- **User convenience** - name your Taskdocs anything without worry
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

### Workspace Creation

```bash
dominds create <template> [directory]
dominds new <template> [directory]  # alias for create
```

Create a new dominds-powered workspace by cloning/scaffolding a template repository that includes a pre-configured `.minds/` setup.

**Arguments:**

- `template` - Template name or Git URL (required)
- `directory` - Target directory name (optional, defaults to the template-derived directory name)

**Usage - Scaffold Templates:**

```bash
# Recommended: Use scaffold templates with pre-configured teams
dominds create|new <template> [directory]

# Short form for official templates (uses DOMINDS_TEMPLATE_BASE)
dominds create web-scaffold my-web-app
dominds create api-scaffold my-api
dominds create cli-scaffold my-cli
dominds create fullstack-scaffold my-app

# Full GitHub URLs for custom templates
dominds create https://github.com/myorg/custom-template.git my-project

# With custom repository setup
dominds create web-scaffold \
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
dominds create web-scaffold my-app  # Resolves to: https://github.com/myorg/web-scaffold.git

# Team-specific templates
export DOMINDS_TEMPLATE_BASE="https://github.com/mycompany/dominds-templates"
dominds create backend-service my-service  # Resolves to: https://github.com/mycompany/dominds-templates/backend-service.git
```

**Examples:**

```bash
# Preferred: Clone scaffold template (includes .minds/ configuration)
dominds create react-scaffold \
                 --repo-url git@github.com:myorg/new-react-app.git \
                 my-react-app
```

**Generated Structure:**

```
project-directory/
├── .minds/
│   ├── team.yaml          # Team configuration (from template)
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
dominds tui -C <directory> <taskdoc-path> [prompts...]
dominds tui --chdir <directory> <taskdoc-path> [prompts...]
```

Change to the specified workspace before executing the command.

**Example:**

```bash
dominds tui -C /path/to/project task.tsk "Start working on feature"
```

### Specify Team Member

```bash
dominds tui -m <member-id> <taskdoc-path> [prompts...]
dominds tui --member <member-id> <taskdoc-path> [prompts...]
```

Use a specific team member as the agent for this dialog.

**Example:**

```bash
dominds tui -m alice task.tsk "Review the code"
dominds tui --member bob architecture.md "Design the new system"
```

### Resume or Use Custom Dialog ID

```bash
dominds tui -i <dialog-id> <taskdoc-path> [prompts...]
dominds tui --id <dialog-id> <taskdoc-path> [prompts...]
```

Resume an existing dialog or start a new dialog with a specific ID.

**Examples:**

```bash
# Resume an existing dialog
dominds tui -i aa/bb/12345678 task.tsk "Continue where we left off"

# Start with a custom dialog ID
dominds tui --id my/custom/id task.tsk "New task with custom ID"
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
dominds tui -C /path/to/project -m charlie task.tsk "Implement the API"

# Validate team configuration
dominds read /path/to/project/.minds --verbose
```

### Advanced Usage

```bash
# Create a new workspace with a scaffold template
dominds create web-scaffold my-project
cd my-project

# Verify setup
dominds read --validate

# Start development with specific configuration
dominds tui -C /workspace -m alice -i custom/dialog/id task.tsk "Initial prompt" "Additional context"

# Monitor via Web UI while working in TUI
dominds &  # Start Web UI in background
dominds tui task.tsk "Continue development"

# Quick help for any command
dominds tui --help
dominds read --help
dominds create --help
```

### Multi-Interface Workflow

```bash
# Use different interfaces for different tasks
dominds new research-scaffold my-research-project
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
- `latest.yaml` - Current round + lastModified tracking
- `round-001.jsonl` (and further rounds) - Streamed message files
- `subdialogs/` - Nested subdialogs

## Error Handling

The CLI commands provide helpful error messages for common issues:

**TUI (`dominds tui`) Errors:**

- Missing Taskdoc path
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
- Maintains backward compatibility with existing Taskdoc paths
- Toolset validation failures

**Workspace Create (`dominds create` / `dominds new`) Errors:**

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
dominds create --help

# Start Web UI for visual debugging
dominds

# Verify team setup
dominds read .minds --verbose
```

Use the appropriate help command or start the Web UI (`dominds`) for visual debugging when encountering issues.
