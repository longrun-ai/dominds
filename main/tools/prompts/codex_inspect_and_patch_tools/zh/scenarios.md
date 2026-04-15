# codex_inspect_and_patch_tools 使用场景

## 场景 1：改前先定位

目标：在修改前先看清调用点与现状。

```typescript
readonly_shell({
  command: 'rg -n "buildKernelDriverPolicy" dominds/main -S',
});
```

## 场景 2：落一个聚焦修复

目标：检查后提交一个精确改动。

```typescript
apply_patch({
  patch:
    '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-const enabled = false;\n+const enabled = true;\n*** End Patch\n',
});
```

## 场景 3：查看仓库状态

目标：不改动任何内容，只检查当前工作区变化。

```typescript
readonly_shell({
  command: 'git -C dominds diff --stat',
});
```

## 场景 4：多步编码工作流

目标：检查、补丁、再检查。

1. 用 `readonly_shell` 找到目标代码
2. 用 `apply_patch` 做修改
3. 再用 `readonly_shell` 验证结果
