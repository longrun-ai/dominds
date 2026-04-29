# codex_inspect_and_patch_tools 工具参考

## 工具列表

### 1. `readonly_shell`

用途：用受限只读 shell 检查 workspace。

常见用途：

- `rg` / `sed` / `cat` / `nl` / `ls`
- 只读 `git status` / `git diff` / `git log` / `git show`
- 版本探针与简单文件系统检查

示例：

```typescript
readonly_shell({
  command: 'git status',
});
```

### 2. `apply_patch`

用途：把显式 patch hunk 应用到 workspace 文件。

常见用途：

- 增删代码块
- 更新函数实现
- 通过 patch 语法创建或删除文件

示例：

```typescript
apply_patch({
  patch:
    '*** Begin Patch\n*** Update File: src/index.ts\n@@\n-console.log(\"old\");\n+console.log(\"new\");\n*** End Patch\n',
});
```

## 输出预期

- `readonly_shell` 返回命令输出或结构化失败信息
- `apply_patch` 返回是否应用成功，以及失败原因

参数与返回的最终权威来源仍然是工具函数定义。
