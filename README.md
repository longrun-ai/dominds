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
  - [Start from scratch](#start-from-scratch)
  - [Core Philosophy](#core-philosophy)
  - [1) Clear minds, focused tasks](#1-clear-minds-focused-tasks)
  - [2) Tools with intent: safe by design](#2-tools-with-intent-safe-by-design)
  - [3) Diverse, self‑improving team from templates](#3-diverse-selfimproving-team-from-templates)
  - [Documentation](#documentation)
    - [Getting Help](#getting-help)

## What is Dominds?

Dominds is an AI-powered DevOps framework that creates autonomous agentic teams with persistent memory and self-improving capabilities. Unlike traditional AI assistants, Dominds agents maintain context across conversations, learn from experience, and collaborate as a cohesive team to handle complex development workflows.

**Key Features:**

- **Local-first Runtime**: The orchestration layer runs on your machine and persists team state locally in your workspace. LLM calls still go to your configured provider (so apply normal cost/privacy discipline).

- **Transparent Workspace Integration**: Agent knowledge, personas, lessons learned, and mindset artifacts are stored locally as part of your workspace. This maximizes transparency to humans and enables version control alongside your product code, creating a complete historical record of both human and AI contributions to your project.

- **Persistent Team Memory**: Agents maintain context across conversations, remember past decisions, and build upon learned patterns. Teams evolve their practices and knowledge over time, with all insights preserved in your workspace.

- **Collaborative Intelligence**: Multiple specialized agents work together on shared tasks, combining their unique capabilities while maintaining clear communication channels and shared understanding through workspace-stored context.

- **Safe Tool Access**: AI-driven guardrails provide secure access to powerful development tools, with all safety policies and access patterns transparently stored and version-controlled within your workspace.

- **Task-Focused Architecture**: Clear, bounded contexts prevent cognitive overload while maintaining rich inter-agent communication and knowledge sharing through the local workspace knowledge base.

## Installation

### Prerequisites

- **Node.js (with npm bundled)**: Version 22.x or later
- **LLM provider configured for your team**: Dominds ships with a built-in provider catalog (`dominds/main/llm/defaults.yaml`) including Codex (ChatGPT) and Anthropic, plus several Anthropic-compatible endpoints (e.g. MiniMax, Z.ai, BigModel). You’ll need valid credentials for at least one provider.
- **pnpm (optional)**: Recommended only if you’re developing Dominds itself.

### Install Dominds

```bash
# Global installation (recommended)
npm install -g dominds
# (or) pnpm add -g dominds

# Verify installation
dominds --help
```

For development and any sort of open source contribution, use the in-tree dev wrapper workspace:

https://github.com/longrun-ai/dominds-feat-dev

1. Clone dominds-feat-dev
2. Clone your dominds fork into dominds-feat-dev/dominds/
3. Open PRs against [longrun-ai/dominds](https://github.com/longrun-ai/dominds) from that inner repo

### Workspace Setup

There are two common ways to create a workspace:

- **Recommended**: start from a scaffold/template (see [Quick Start](#quick-start)).
- **Minimal**: start from an empty folder (see [Start from scratch](#start-from-scratch)).

Dominds uses your current working directory as the runtime workspace (rtws). When you start `dominds`, the WebUI will automatically redirect you to `http://localhost:5666/setup` if the workspace is missing required configuration (for example `.minds/team.yaml` or provider env vars).

Note: in production mode, Dominds enables a local shared-secret auth key by default, so the browser may open with a URL containing `?auth=...`. Treat that token as sensitive.

**Template creation (recommended)**:

```bash
# Use official scaffold templates (default base = https://github.com/longrun-ai)
dominds create web-scaffold my-project

# Use custom organization templates
export DOMINDS_TEMPLATE_BASE="https://github.com/myorg"
dominds create web-scaffold my-project

# Or use full URLs for any template
dominds create https://github.com/myorg/custom-template.git my-project
```

**Template Resolution:**

- Short names like `web-scaffold` resolve to `${DOMINDS_TEMPLATE_BASE}/web-scaffold.git`
- Default `DOMINDS_TEMPLATE_BASE` is `https://github.com/longrun-ai`
- Set your own `DOMINDS_TEMPLATE_BASE` for organization-specific templates

For more template options, see the [CLI Usage Guide](docs/cli-usage.md#workspace-creation).

## Quick Start

```bash
# 1) Create a workspace from a scaffold template
dominds create web-scaffold my-project
cd my-project

# 2) Start the WebUI (opens a browser by default)
dominds
```

Then:

1. Your browser should land on `http://localhost:5666/setup` (either directly, or via an automatic redirect).
2. In **Setup**, pick a provider + model and click **Create/Overwrite `.minds/team.yaml`** (this writes a minimal `member_defaults` config).
3. Still in **Setup**, set the required provider env var (the name comes from the provider catalog, e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CODEX_HOME`, etc).
   - The setup UI can write it into `~/.zshrc` / `~/.bashrc` in a managed block, and also applies it to the running server process immediately.
4. Click **Go to App**, create a dialog, and start working.

## Start from scratch

Starting from scratch means: create an empty folder, run `dominds`, let Setup generate the minimal `.minds/team.yaml`, then use the shadow team manager (`@fuxi`) to design a real team for your product.

```bash
mkdir my-workspace
cd my-workspace

# Starts the WebUI server and opens a browser (default port: 5666)
dominds
```

1. The WebUI should redirect you to `http://localhost:5666/setup` because the workspace has no `.minds/team.yaml` yet.
2. In **Setup**:
   - Select a provider + model and click **Create `.minds/team.yaml`**.
   - Provide the required provider env var and write it to your shell rc (or set it manually). Setup applies it immediately to the running server.
   - Click **Go to App**.
3. In the app, create a new dialog with **shadow member** `@fuxi` (Fuxi is hidden by default; use the “Shadow members” picker in the dialog creation modal). Until you add visible members, you’ll mostly work through shadow members.
4. Tell `@fuxi` your product idea and ask it to propose and apply a suitable agentic team configuration by updating `.minds/team.yaml` (Fuxi has the `team-mgmt` toolset scoped to `.minds/**`).

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
- Keep mindsets transparent as plain Markdown files for humans; see `.minds/` directory of interesting templates for a variety of setups

## Documentation

- **[CLI Usage Guide](docs/cli-usage.md)** — Commands, options, and usage patterns
- **[Dev Principles](docs/dev-principles.md)** — Conventions and quality bar
- **[Design](docs/design.md)** — Architecture and key abstractions
- **[Dialog System](docs/dialog-system.md)** — Dialog runtime model and streaming
- **[Dialog Persistence](docs/dialog-persistence.md)** — On-disk layout and lifecycle
- **[Interruption & Resumption](docs/interruption-resumption.md)** — Stop/resume semantics
- **[Encapsulated Task Docs](docs/encapsulated-task-doc.md)** — `*.tsk/` packages and parsing
- **[Auth](docs/auth.md)** — Authentication and access model
- **[Context Health](docs/context-health.md)** — Measuring/maintaining context quality
- **[MCP Support](docs/mcp-support.md)** — MCP tool integration
- **[Team Mgmt Toolset](docs/team-mgmt-toolset.md)** — Managing team members via tools
- **[Team Tools View](docs/team-tools-view.md)** — Inspecting tool availability
- **[i18n](docs/i18n.md)** — Language and localization rules
- **[OEC Philosophy](docs/OEC-philosophy.md)** — Philosophy and safety stance
- **[Mottos](docs/mottos.md)** — Short guiding statements

### Getting Help

- Open an issue on [GitHub](https://github.com/longrun-ai/dominds/issues) for bugs or feature requests

---

**License:** [LGPL](./LICENSE) | **Repository:** [github.com/longrun-ai/dominds](https://github.com/longrun-ai/dominds)
