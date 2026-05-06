# MCP Prompts and Resources

This document defines how Dominds maps MCP prompts and resources into the runtime.
It extends the tool-focused MCP support described in [mcp-support.md](./mcp-support.md).

## Design Position

MCP primitives have different control semantics:

- **Tools** are model-controlled actions. Dominds exposes them as function tools.
- **Prompts** are user-controlled templates. Dominds exposes them as read-only snippets.
- **Resources** are application-controlled context objects. Dominds exposes them through a
  resource registry and explicit read tools.

Dominds should not flatten all MCP primitives into ordinary model tools. Doing so loses the
control boundary that makes MCP debuggable and safe.

## Prompts -> Read-Only Snippets

MCP prompts are surfaced in the Snippets panel as read-only templates.

Expected behavior:

- `prompts/list` contributes dynamic snippet entries grouped by MCP server.
- `prompts/get` renders a selected prompt before insertion.
- Prompt arguments are collected by the UI before insertion when the prompt declares arguments.
- MCP prompt snippets cannot be edited or saved back through Dominds.
- Prompt IDs are Dominds-local stable IDs derived from server ID plus transformed MCP prompt name.

This keeps prompts user-selected while reusing the existing Dominds snippet workflow.

## Resources -> Resource Registry

MCP resources and resource templates are surfaced through a Dominds resource registry.

Resource entries:

- Static resources come from `resources/list`.
- Resource templates come from `resources/templates/list`.
- Static resource IDs are derived from the resource URI after configured transforms.
- Template resource IDs are derived from the URI template after configured transforms.
- The original URI or URI template remains the source of truth used for MCP requests.

The resource registry is intentionally separate from Dominds files, docs, and memory. Those
domains keep their existing dedicated concepts. The resource registry is the generic MCP-shaped
context surface.

## Resource Tools

Dominds provides explicit read-only tools:

- `list_resources`: list available resources and resource templates.
- `fetch_resource`: fetch a static resource or a rendered resource template.

Template fetching requires `arguments`. Passing arguments to a static resource is an error.
Missing template variables are errors. Oversized results and unsupported MIME types are errors,
not silent fallbacks.

## Resource Skills

Markdown resources with valid Agent Skill frontmatter may be exposed as read-only virtual skills.

Rules:

- Resource skills are opt-in through `.minds/mcp.yaml`.
- Only textual markdown resources are eligible.
- The frontmatter must pass the same validation as local Dominds skills.
- Resource skills are read-only and keep MCP provenance.
- Invalid or duplicate resource skills are reported loudly through Problems/logs.

Dominds skills are loaded as an index in the system prompt. Skill bodies are read on demand with
`read_skill`, so resource skills do not inflate every generation by default.

## Config Shape

Example:

```yaml
version: 1
servers:
  workstation:
    transport: streamable_http
    url: http://127.0.0.1:43178/mcp
    headers:
      Authorization: Bearer dw

    prompts:
      whitelist:
        - 'workstation.*'
      transform:
        - prefix: 'workstation_'

    resources:
      whitelist:
        - 'workstation-handbook://*'
        - 'workstation-skill://*'
      blacklist:
        - '*secret*'
      transform:
        - prefix: 'workstation_'
      mimeTypes:
        - text/markdown
        - text/plain
      maxBytes: 50000
      skills:
        enabled: true
        whitelist:
          - 'workstation-skill://*'
        transform:
          - prefix: 'workstation_skill_'
```

Filtering matches original MCP names/URIs/templates. Transforms only produce Dominds-local IDs.

## Non-Goals

- No write-back to MCP prompts or resources.
- No automatic conversion of every markdown resource into a skill.
- No implicit prompt/resource access for servers filtered out by `.minds/mcp.yaml`.
- No compatibility fallback that silently calls MCP tools when resources or prompts fail.
