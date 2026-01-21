# Dominds — DevOps Mindsets — Sustainable Agentic Product Lifecycle

> Ship your product with an AI DevOps team that self-improves while it works.

> Agents should be sustaining the continuous development of your products, one-shot product creation is hallucination.

## CAVEATS

- **NO WARRANTY / AT YOUR OWN RISK**: Dominds is powerful automation. If you point it at the wrong repo, give it the wrong goal, or trust output blindly, it can waste time or cause damage.
  - Keep backups and review changes carefully (especially before merging or deploying).
  - Prefer running on a disposable clone or non-critical branch until you trust your workflow.

- **No Human Permission Mechanism (won’t-have)**: Dominds does not aim to add a per-action “please approve” prompt for tool usage.
  - The intended safety model is _hard guardrails via workflow/policy_ (planned), not human-in-the-loop popups.
  - Put high-risk tools behind principled agents so their judgment enforces policies and mitigates risk.
  - Use least-privilege credentials and avoid production secrets in `.env` when experimenting.
  - Treat your workspace as sensitive: dialogs, logs, and memory may persist locally on disk.

- **Authorize Your Agents (or don’t use Dominds)**: Dominds is not pair‑programming. Once authorized, agents will act — assume mistakes and review outcomes from a distance.
  - If you prefer to work closely with your agents, use a more traditional copilot‑style tool.
  - You’re not a hands‑on driver; you’re fully responsible for the consequences of the team you define and animate — trust them to execute, stay remote, and accept the outcomes, good or bad.

- **Costs / Privacy / Compliance**: using LLM providers can cost money and may send prompts (sometimes including code) to third parties.
  - Review provider terms, set spending limits, and avoid putting secrets in prompts.
  - If you need strict privacy/compliance, evaluate self-hosted models and stricter tool policies.

- **Help Yourself (early community)**: Dominds is LGPL, with limited support and a young community.
  - Expect rough edges, breaking changes, and gaps in docs; issues/PRs are welcome.

## Table of Contents

- [Dominds — DevOps Mindsets — Sustainable Agentic Product Lifecycle](#dominds--devops-mindsets--sustainable-agentic-product-lifecycle)
  - [Table of Contents](#table-of-contents)
  - [What is Dominds?](#what-is-dominds)
  - [Installation](#installation)
    - [Prerequisites](#prerequisites)
    - [Install Dominds](#install-dominds)
    - [Workspace Setup](#workspace-setup)
  - [Quick Start](#quick-start)
  - [Core Philosophy](#core-philosophy)
  - [1) Clear minds, focused tasks](#1-clear-minds-focused-tasks)
  - [2) Tools with intent: safe by design](#2-tools-with-intent-safe-by-design)
  - [3) Diverse, self‑improving team from templates](#3-diverse-selfimproving-team-from-templates)
  - [Documentation](#documentation)
    - [Getting Help](#getting-help)

## What is Dominds?

Dominds is an AI-powered DevOps framework that creates autonomous development teams with persistent memory and self-improving capabilities. Unlike traditional AI assistants, Dominds agents maintain context across conversations, learn from experience, and collaborate as a cohesive team to handle complex development workflows.

**Key Features:**

- **Fully Local Architecture**: Agents run directly on your machine in parallel threads with instant responsiveness and complete privacy. Unlike cloud-only solutions, Dominds eliminates network latency, ensures your code never leaves your environment, and provides unlimited concurrent operations without API rate limits or external dependencies.

- **Transparent Workspace Integration**: Agent knowledge, personas, lessons learned, and mindset artifacts are stored locally as part of your workspace. This maximizes transparency to humans and enables version control alongside your product code, creating a complete historical record of both human and AI contributions to your project.

- **Persistent Team Memory**: Agents maintain context across conversations, remember past decisions, and build upon learned patterns. Teams evolve their practices and knowledge over time, with all insights preserved in your workspace.

- **Collaborative Intelligence**: Multiple specialized agents work together on shared tasks, combining their unique capabilities while maintaining clear communication channels and shared understanding through workspace-stored context.

- **Safe Tool Access**: AI-driven guardrails provide secure access to powerful development tools, with all safety policies and access patterns transparently stored and version-controlled within your workspace.

- **Task-Focused Architecture**: Clear, bounded contexts prevent cognitive overload while maintaining rich inter-agent communication and knowledge sharing through the local workspace knowledge base.

## Installation

### Prerequisites

- **Node.js**: Version 22.x or later
- **pnpm**: Version 9.x or later (workspace package manager)
- **API Keys**: One or more API keys, for OpenAI, Anthropic, or other compatible LLM providers

### Install Dominds

```bash
# Global installation (recommended)
npm install -g dominds
# (or) pnpm add -g dominds

# Verify installation
dominds --help
```

For development or testing:

```bash
# Official dev workflow (recommended for PRs)
# Use the in-tree dev wrapper workspace:
# https://github.com/longrun-ai/dominds-feat-dev
# - Clone dominds-feat-dev
# - Clone your dominds fork into dominds-feat-dev/dominds/
# - Open PRs against longrun-ai/dominds from that inner repo

# Recommended: keep using the released `dominds` CLI (stable) while developing dominds.
#
# Emergency only: if the released CLI has a blocking bug, link a clean checkout of `main` branch
# from a different directory (do NOT link the same dominds checkout you are editing for PRs).
git clone https://github.com/longrun-ai/dominds.git ~/src/dominds-main
pnpm -C ~/src/dominds-main install
pnpm -C ~/src/dominds-main run build
pnpm -C ~/src/dominds-main link --global
```

### Workspace Setup

1. **Initialize your workspace** in your project directory:

```bash
# Preferred: Use scaffold templates with pre-configured teams
dominds init web-scaffold my-project
cd my-project

# Fallback: Basic team configurations for existing projects
dominds init --1ma       # One Man Army - do what's on the only agent's first thoughts
dominds init --fbr       # Fresh Boots Reasoning - solo doer agent, second thoughts with fresh minds adviced
dominds init --pnx       # Plan and Execution - two agents with basic division of work
dominds init --igx       # Inteligence Guarded Execution - one more differently-minded criticist agent
```

For more initialization options and available scaffold templates, see the [CLI Usage Guide](docs/cli-usage.md#initialize-a-dominds-workspace).

2. **Set up environment variables**:

```bash
# Dominds CLI loads `.env` then `.env.local` from your workspace root (rtws).
# `.env.local` overwrites `.env`, and both overwrite existing `process.env`.
export OPENAI_API_KEY="your-openai-api-key"
export ANTHROPIC_API_KEY="your-anthropic-api-key"  # Optional
```

3. **Verify installation**:

```bash
# Test the CLI
dominds --help

# Test the TUI setup
dominds tui --help
dominds tui --list  # Should show no dialogs initially

# Or start the Web UI (default command)
dominds  # Opens web interface for the current workspace
```

For detailed configuration examples, see the [example workspace](poc/ws-1ma/.minds/) in this repository.

## Quick Start

Initialize a new dominds-powered workspace using scaffold templates:

```bash
# Use official scaffold templates (recommended)
dominds init web-scaffold my-project

# Or use custom organization templates
export DOMINDS_TEMPLATE_BASE="https://github.com/myorg"
dominds init web-scaffold my-project

# Or use full URLs for any template
dominds init https://github.com/myorg/custom-template.git my-project
```

**Template Resolution:**

- Short names like `web-scaffold` resolve to `${DOMINDS_TEMPLATE_BASE}/web-scaffold.git`
- Default `DOMINDS_TEMPLATE_BASE` is `https://github.com/longrun-ai`
- Set your own `DOMINDS_TEMPLATE_BASE` for organization-specific templates

**Note:** The `init` subcommand is planned for future release. For now, manually copy configuration from `poc/` examples.

Once installed and configured, you can start using `dominds` immediately:

```bash
# Create a task doc package for your project (recommended: `*.tsk/`)
mkdir -p tasks/auth.tsk
cat > tasks/auth.tsk/goals.md << 'EOF'
# User Authentication

Implement secure user authentication system with JWT tokens.
EOF

cat > tasks/auth.tsk/constraints.md << 'EOF'
- Login/logout endpoints
- Password hashing
- JWT token generation
- Session management
EOF

cat > tasks/auth.tsk/progress.md << 'EOF'
- Not started yet
EOF

# Start a new dialog with your task (TUI)
dominds tui tasks/auth.tsk "Implement user authentication system"

# Or use the 'run' alias
dominds run tasks/auth.tsk "Implement user authentication system"

# List all active dialogs
dominds tui --list

# Resume an existing dialog (use actual dialog ID from --list)
dominds tui -i aa/bb/12345678 tasks/auth.tsk "Continue working on auth"

# Read team configuration
dominds read  # Show all team members
dominds read developer  # Show specific member

# Get help and see all available commands
dominds --help
dominds tui --help
dominds webui --help
dominds read --help

# Or use the Web UI for a graphical interface (default command)
dominds  # Opens in browser for the current workspace
dominds webui  # Explicitly start Web UI
```

**What happens next:**

- Dominds creates a new dialog with a unique ID
- The assigned agent reads your task document and begins working
- All conversation history and file changes are tracked
- Agents can create subdialogs for complex subtasks
- Team memory is updated with new learnings

For detailed usage patterns and advanced features, see the [CLI Usage Guide](docs/cli-usage.md).

## Core Philosophy

## 1) Clear minds, focused tasks

> Break large initiatives into well-structured, bounded tasks. Each agent should operate with a clear, minimal context for the task at hand. Excess context pollutes reasoning and degrades performance—much like cognitive overload does for humans.

Why it matters

- Focus reduces hallucination risk and error rates
- Bounded scopes make evaluation and iteration faster
- Clear task contracts enable parallelism and reuse

## 2) Tools with intent: safe by design

> Powerful tools (for example, shells or other side‑effectful interfaces) are hard to fully audit without compromising usefulness. But do micro-auditing by yourself? Or rely on vague “be careful” instructions? Big NO with Dominds!

Principles

- Flexible by default, safe by design: AI tailors guardrails to task and context; hard‑coded rules are rigid—often blocking or slow
- Reliable at scale: consistent, fatigue‑free checks; human processes drift with attention and availability
- Fast intent to action: AI drafts plans, simulates changes, and executes with lightweight human reviews where needed

Outcomes

- Fewer execution errors; safer side effects
- Higher plan fidelity; better adherence to intent
- More first‑try successes on complex tasks

## 3) Diverse, self‑improving team from templates

> Bootstrap specialized team from project templates, then curate and evolve both individual and collective memory: personas, knowledge, lessons, and playbooks.

Practices

- Bootstrap the team from a starter scaffold project template tailored to specific domains and workflows
- Maintain individual personas and skill maps; track what each agent learns within their specialized context
- Maintain shared team memory for patterns, failures, and standards specific to the project type
- Enable autonomous improvement loops: agents evolve collective and individual mindsets (personas, principles, heuristics) based on template foundations
- Design specialized agents for team management and governance appropriate to the project domain
- Keep mindsets transparent as plain Markdown files for humans; see `.minds/` directory of interesting templates for varity of the setups

## Documentation

- **[CLI Usage Guide](docs/cli-usage.md)** — Complete command reference and usage patterns
- **[Design Documentation](docs/design.md)** — System architecture and philosophy
- **[Dialog System](docs/dialog-system.md)** — How conversations and memory work
- **[Dialog Persistence](docs/dialog-persistence.md)** — Data storage and workspace structure

### Getting Help

- Open an issue on [GitHub](https://github.com/longrun-ai/dominds/issues) for bugs or feature requests

---

**License:** LGPL | **Repository:** [github.com/longrun-ai/dominds](https://github.com/longrun-ai/dominds)
