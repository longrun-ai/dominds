# team_mgmt 工具手册

## 模板（概述）

### 一句话定位

- <该工具集用途，一句话描述>

### 工具清单

- <列出核心工具，或指向 Tools/Schema 章节>

### 30 秒上手

1. <调用 ...>
2. <观察 ...>
3. <下一步 ...>

### 导航

- principles / tools / scenarios / errors

### 与其他工具集的边界

- <何时用本工具集、何时用相邻工具集>

team_mgmt 是 Dominds 用于管理 `.minds/`（团队配置与 rtws 记忆）的工具集，采用 **prepare-first + single apply** 架构：

- **增量编辑（推荐）**：用 `team_mgmt_prepare_*` 先生成可复核的 YAML + diff + `hunk_id`，再用 `team_mgmt_apply_file_modification` 显式写入
- **只操作 `.minds/`**：该 toolset 只允许操作 `.minds/` 子树，不会也不应触碰 rtws 其他文件
- **shell 权限约束**：`os` toolset 包含 `shell_cmd` / `stop_daemon` / `get_daemon_output`；任何拿到这些工具的成员都必须出现在顶层 `shell_specialists`

## 快速导航

| 主题                          | 描述                                           |
| ----------------------------- | ---------------------------------------------- |
| [principles](./principles.md) | 核心原则、路径规则、read_file 输出、apply 语义 |
| [tools](./tools.md)           | 完整工具列表与接口契约                         |
| [scenarios](./scenarios.md)   | 常见使用场景与示例（复制即用）                 |
| [errors](./errors.md)         | 错误处理指南                                   |

## 与 ws_mod 的关系

本工具集与 `ws_mod`（文本编辑工具）的心智模型一致，但：

- 路径解析到 `.minds/` 下（如 `team.yaml` → `.minds/team.yaml`）
- 工具名称带 `team_mgmt_` 前缀
- 权限语义由 team_mgmt 包装层决定
