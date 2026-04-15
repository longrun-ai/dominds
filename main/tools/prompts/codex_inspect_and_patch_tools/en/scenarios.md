# codex_inspect_and_patch_tools Usage Scenarios

## Scenario 1: Inspect Before Editing

Goal: understand the current code path before changing it.

```typescript
readonly_shell({
  command: 'rg -n "buildKernelDriverPolicy" dominds/main -S',
});
```

## Scenario 2: Apply a Focused Fix

Goal: land a precise code change after inspection.

```typescript
apply_patch({
  patch:
    '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-const enabled = false;\n+const enabled = true;\n*** End Patch\n',
});
```

## Scenario 3: Check Repo State

Goal: inspect workspace changes without mutating anything.

```typescript
readonly_shell({
  command: 'git -C dominds diff --stat',
});
```

## Scenario 4: Multi-Step Code Work

Goal: inspect, patch, then inspect again.

1. Use `readonly_shell` to find the target code
2. Use `apply_patch` to change it
3. Use `readonly_shell` again to verify the result
