# codex_inspect_and_patch_tools 原则

## 设计目标

- 给编码模型一个小而高信号的检查 + 补丁工具面
- 保持修改可审查：改动通过 patch 落地，而不是任意 shell 写操作
- 在工具集层面保持 provider 无关；只要是 `gpt-5.x` 模型就默认推荐

## 核心模型

### 1. 先检查

用 `readonly_shell` 检查仓库状态、搜索代码、查看 diff，先弄清现状再动手。

### 2. 显式打补丁

用 `apply_patch` 做明确的文件修改。patch 本身就是审查面。

### 3. 保持收敛

这个工具集故意不是通用 shell 工具集，也不是计划/状态管理工具集。真要做更宽的执行，就换别的工具集，不要把它硬撑大。

## 工具概览

| 工具             | 作用                           |
| ---------------- | ------------------------------ |
| `readonly_shell` | 只读 shell 检查                |
| `apply_patch`    | 通过 patch 做显式代码/文件修改 |

## 最佳实践

- 改前先检查，不要猜
- 优先用 `readonly_shell` 做 `rg`、`git diff`、`ls`、`sed` 这类探查
- `apply_patch` 的 hunk 保持聚焦、可审查
- 把它作为 `ws_read` / `ws_mod` 的补充，而不是替代

## 边界

1. `readonly_shell` 会拒绝超出白名单的写操作与脚本式执行
2. `apply_patch` 只负责明确的 patch hunk，不负责任意文件写入工作流
3. 任务计划和 reminder 管理不属于本工具集职责
