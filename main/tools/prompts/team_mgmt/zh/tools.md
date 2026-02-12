# team_mgmt 工具参考

## 读取/定位工具

- `team_mgmt_read_file`：读取 `.minds/` 下的文件内容，带 YAML header（含 total_lines/size_bytes）
- `team_mgmt_list_dir`：列出 `.minds/` 下的目录内容
- `team_mgmt_ripgrep_files`：在 `.minds/` 下搜索文件路径
- `team_mgmt_ripgrep_snippets`：在 `.minds/` 下搜索片段（带上下文）
- `team_mgmt_ripgrep_count`：在 `.minds/` 下计数匹配
- `team_mgmt_ripgrep_fixed`：在 `.minds/` 下固定字符串搜索

## 创建工具

- `team_mgmt_create_new_file`：创建新文件（允许空内容），不走 prepare/apply
  - 若文件已存在会拒绝（`FILE_EXISTS`）
  - 若父目录不存在会自动创建

## 增量编辑工具

### 1. prepare 阶段

- `team_mgmt_prepare_file_range_edit`：按行号范围预览 replace/delete/append
- `team_mgmt_prepare_file_append`：预览追加到 EOF（可选 `create=true|false`）
- `team_mgmt_prepare_file_insert_after`：按锚点行预览插入（之后）
- `team_mgmt_prepare_file_insert_before`：按锚点行预览插入（之前）
- `team_mgmt_prepare_file_block_replace`：按 start/end 锚点预览块替换
  - 支持参数：`include_anchors`、`require_unique`、`strict`、`occurrence`

### 2. apply 阶段

- `team_mgmt_apply_file_modification`：唯一 apply 入口，使用 `hunk_id` 应用更改

## 整文件覆盖工具

- `team_mgmt_overwrite_entire_file`：直接覆盖整个文件（不走 prepare/apply）
  - 必须提供 `known_old_total_lines` 和 `known_old_total_bytes`
  - 建议先用 `team_mgmt_read_file` 获取这些值

## 验证工具

- `team_mgmt_validate_team_cfg({})`：验证 `.minds/team.yaml` 配置是否有效
  - 修改完 `team.yaml` 后必须运行
  - 清空 Problems 面板里的 team.yaml 错误后再继续

## 工具选择指南

| 操作               | 推荐工具                                                                           |
| ------------------ | ---------------------------------------------------------------------------------- |
| 读取文件           | `team_mgmt_read_file`                                                              |
| 搜索内容           | `team_mgmt_ripgrep_snippets`                                                       |
| 创建新文件         | `team_mgmt_create_new_file`                                                        |
| 小改动（行号范围） | `team_mgmt_prepare_file_range_edit` → `team_mgmt_apply_file_modification`          |
| 末尾追加           | `team_mgmt_prepare_file_append` → `team_mgmt_apply_file_modification`              |
| 锚点插入           | `team_mgmt_prepare_file_insert_after/before` → `team_mgmt_apply_file_modification` |
| 块替换             | `team_mgmt_prepare_file_block_replace` → `team_mgmt_apply_file_modification`       |
| 覆盖整个文件       | `team_mgmt_overwrite_entire_file`                                                  |
| 验证配置           | `team_mgmt_validate_team_cfg({})`                                                  |
