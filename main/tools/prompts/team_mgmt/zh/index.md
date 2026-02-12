# team-mgmt 工具手册

## 概述

team-mgmt 是 Dominds 用于管理 `.minds/`（团队配置与 rtws 记忆）的工具集，采用 **prepare-first + single apply** 架构：

- **增量编辑（推荐）**：用 `team_mgmt_prepare_*` 先生成可复核的 YAML + diff + `hunk_id`，再用 `team_mgmt_apply_file_modification` 显式写入
- **只操作 `.minds/`**：该 toolset 只允许操作 `.minds/` 子树，不会也不应触碰 rtws 其他文件

## 快速导航

| Topic                         | 描述                                           |
| ----------------------------- | ---------------------------------------------- |
| [principles](./principles.md) | 核心原则、路径规则、read_file 输出、apply 语义 |
| [tools](./tools.md)           | 完整工具列表与接口契约                         |
| [scenarios](./scenarios.md)   | 常见使用场景与模板（复制即用）                 |
| [errors](./errors.md)         | 错误处理指南                                   |

## 与 ws_mod 的关系

本工具集与 `ws_mod`（文本编辑工具）的心智模型一致，但：

- 路径解析到 `.minds/` 下（如 `team.yaml` → `.minds/team.yaml`）
- 工具名称带 `team_mgmt_` 前缀
- 权限语义由 team-mgmt 包装层决定
