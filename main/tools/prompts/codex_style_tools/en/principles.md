# codex_style_tools Principles and Core Concepts

## Template (Principles)

### Design Goals

- <Goal 1>
- <Goal 2>

### Contract Principles

- <Input/Output contract rules>

### Safety & Boundaries

- <Access constraints / guardrails>

### Failure & Recovery

- <What to do when a call fails>

### Glossary

- <Toolset-specific terms>

## Core Concepts

### 1. Codex Compatibility

The Codex style toolset is designed to be compatible with Codex provider, providing consistent tool calling experience.

**Characteristics:**

- Tool names are consistent with Codex
- Parameter formats are consistent with Codex
- Output formats are consistent with Codex

### 2. Read-Only First

The Codex style toolset emphasizes read-only operations, avoiding destructive operations.

**Tools:**

- `readonly_shell`: Execute read-only commands only
- `apply_patch`: Apply patches (reviewable)

### 3. Plan Management

The `update_plan` tool is used to update task plans.

**Functions:**

- Record todo items
- Track task progress
- Update task status

## Tool Overview

| Tool           | Function                         |
| -------------- | -------------------------------- |
| apply_patch    | Apply code patch                 |
| readonly_shell | Execute read-only Shell commands |
| update_plan    | Update task plan                 |

## Best Practices

### 1. Patch Application

- Review patch content first
- Confirm before applying
- Keep backups

### 2. Read-Only Shell

- Only execute query commands
- Avoid modifying system state

### 3. Plan Updates

- Regularly update task progress
- Keep plans consistent with actual progress

## Limitations and Notes

1. Shell commands are limited to read-only operations
2. Patch application requires confirmation
3. Plan updates are incremental
