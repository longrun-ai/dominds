# codex_style_tools Usage Scenarios

## Template (Scenarios)
### Scenario Format
- Goal
- Preconditions
- Steps
- Expected Signal
- Failure Branch
- Completion Criteria

## Scenario 1: Apply Code Patch

### Scenario Description

Apply code patch to fix issues.

### Example

```typescript
apply_patch({
  patch:
    "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,3 +1,4 @@\n console.log('hello');\n+console.log('world');\n",
});
```

## Scenario 2: Read-Only Command Execution

### Scenario Description

Execute read-only commands to view system status.

### Example

```typescript
readonly_shell({
  command: 'git status',
});
```

## Scenario 3: Task Plan Management

### Scenario Description

Use update_plan to manage task plans.

### Example

```typescript
update_plan({
  explanation: "Today's Tasks",
  plan: [
    { step: 'Complete code review', status: 'in_progress' },
    { step: 'Fix bug', status: 'pending' },
    { step: 'Write documentation', status: 'pending' },
  ],
});
```

## Scenario 4: File Status Check

### Scenario Description

Check file status.

### Example

```typescript
readonly_shell({
  command: 'ls -la',
});
```

## Scenario 5: Git Operations

### Scenario Description

Use read-only Git commands.

### Example

```typescript
readonly_shell({
  command: 'git log --oneline -5',
});
```
