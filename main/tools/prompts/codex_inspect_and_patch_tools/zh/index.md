# codex_inspect_and_patch_tools 手册

`codex_inspect_and_patch_tools` 是 Dominds 的轻量 inspect-and-patch 工具集。

它刻意只暴露两类工具：

- `readonly_shell`：用严格受限的只读 shell 做检查
- `apply_patch`：通过显式 patch hunk 做可审查的文件修改

## 推荐用法

- 默认推荐给各类 provider 下的 `gpt-5.x` 编码模型，作为 `ws_read` / `ws_mod` 之上的补充
- 适合“先检查，再精确打补丁”的编码工作流
- 它不是对 Codex 运行时编排体验的完整复刻；这里只负责本地 inspect 与 patch

## 30 秒上手

1. 先用 `readonly_shell` 看清当前状态
2. 再用普通 workspace 读工具定位相关文件
3. 最后用 `apply_patch` 落具体改动

## 导航

| 主题                          | 说明                       |
| ----------------------------- | -------------------------- |
| [principles](./principles.md) | 工具集定位、安全模型与边界 |
| [tools](./tools.md)           | 工具参考与可直接套用的示例 |
| [scenarios](./scenarios.md)   | 常见编码工作流             |
| [errors](./errors.md)         | 失败模式与恢复建议         |

## 与相邻工具集的区别

| 工具集                          | 主要定位                          |
| ------------------------------- | --------------------------------- |
| `codex_inspect_and_patch_tools` | 受约束的 inspect-and-patch 工作流 |
| `os`                            | 更宽的 shell / 运行时操作         |
| `ws_mod`                        | 通用 workspace 文件修改能力       |
