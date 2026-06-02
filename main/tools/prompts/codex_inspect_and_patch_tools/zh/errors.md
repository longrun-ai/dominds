# codex_inspect_and_patch_tools 错误处理

## 常见失败

### `PATCH_INVALID`

含义：patch 格式不对，或与目标文件当前状态对不上。

恢复：

1. 重新读取目标文件
2. 基于最新内容重建 patch
3. 必要时把 hunk 缩小，避免一次改太多

### `FILE_NOT_FOUND`

含义：patch 指向的路径不存在，或当前状态和预期不一致。

恢复：

1. 确认路径
2. 判断这里是否其实应该改成 add-file patch

### `COMMAND_NOT_ALLOWED`

含义：`readonly_shell` 把命令判成了非只读，或超出白名单。

恢复：

1. 改写成允许的只读检查命令
2. 把复杂逻辑拆成几条更简单的探查命令

### `ACCESS_DENIED`

含义：`readonly_shell` 或相关探查工具触发了 rtws 保留路径边界。

常见触发：

- rtws 根目录下的 `.minds/**`
- rtws 根目录下的 `.dialogs/**`
- 封装的 `*.tsk/` 差遣牒包

恢复：

1. 对 `.minds/**`，在团队配置了对应工具集时使用 `team_mgmt_*` 工具。
2. 排查 Dominds 对话时，在嵌套 rtws 下复现，例如 `ux-rtws/.dialogs/**`。
3. 不要通过这个通用 inspect-and-patch 工具集探查或修改 `*.tsk/` 包。

## 常见问答

### 这个工具集是干什么的？

它是面向编码 agent 的窄工具面，负责 inspect-and-patch，尤其默认推荐给 `gpt-5.x` 模型。

### 为什么 shell 命令被拒绝？

因为 `readonly_shell` 故意很严格。它只接受只读检查命令，并拒绝超出白名单的写操作或脚本执行。

### 什么时候该改用 `os`？

只有在你确实需要更宽的 shell 执行能力时才改用 `os`。默认仍应优先用 `codex_inspect_and_patch_tools`。
