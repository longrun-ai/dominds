# team_mgmt 工具参考

## 模板（工具）

### 阅读方式

- "工具契约（Schema）" 为参数/返回的权威来源。

### 单工具字段顺序

1. 用途
2. 调用签名
3. 参数（参见 schema）
4. 前置条件
5. 成功信号
6. 失败/错误
7. 可直接执行示例
8. 常见误用

## 读取/定位工具

- `team_mgmt_read_file`：读取 `.minds/` 下的文件内容，带 YAML header（含 total_lines/size_bytes）
- `team_mgmt_list_dir`：列出 `.minds/` 下的目录内容
- `team_mgmt_list_providers`：列出内置与 rtws 的 provider，显示 env 变量就绪情况与模型概览（可用通配符过滤）
- `team_mgmt_list_models`：按 provider/model 通配符列出模型，可选展示 `model_param_options`
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
  - 会读取 `.minds/mcp.yaml` 声明做 toolset 绑定校验；即使当前场景未加载 MCP toolsets（例如 read mind），也会检查 `members.<id>.toolsets` 是否引用了不存在/无效的 MCP serverId
  - 同时建议检查是否显式设置了 `default_responder`（不是硬性必填，但推荐）
- `team_mgmt_validate_mcp_cfg({})`：验证 `.minds/mcp.yaml` 配置与 MCP 相关问题
  - 修改完 `mcp.yaml` 后必须运行
  - 清空 Problems 面板里的 MCP 相关错误后再继续

## 常见 toolset 能力速览

- `os`：shell 与进程管理（`shell_cmd` / `stop_daemon` / `get_daemon_output`），并包含环境变量工具（`env_get` / `env_set` / `env_unset`）
- `memory`：个人记忆维护（添加/替换/删除/清空个人 memory）
- `team_memory`：团队共享记忆维护（添加/替换/删除/清空 shared memory）
- `codex_style_tools`：Codex 风格工具（`apply_patch` / `readonly_shell` / `update_plan`）；**Windows 环境下不要配置该 toolset**
- `mcp_admin`：MCP 运维（`mcp_restart` / `mcp_release`），并包含环境变量工具（`env_get` / `env_set` / `env_unset`）
- MCP 声明型 toolset：来源于 `.minds/mcp.yaml` 的 `servers.<serverId>` 动态映射（toolset 名称 = `serverId`）。具体能力以该 MCP server 实际暴露工具为准；可在 `team_mgmt_manual({ topics: ["toolsets"] })` 查看当前映射快照
  - 可选：在 `servers.<serverId>.manual` 放手册内容，支持 `content`（总说明）+ `sections`（章节）
  - 注意：没有手册 **不代表** toolset 不可用；这表示团队管理文档不足。应继续阅读每个工具的 description/参数并使用
  - 团队管理者应在 MCP 配置验证通过后：先精读该 server 各工具说明，再与人类用户讨论本 rtws 的使用意图，最后把典型用法与主要意图方向写入 `servers.<serverId>.manual`

## ripgrep 依赖（检测与安装）

- `team_mgmt_ripgrep_*` 与 `ws_read/ws_mod` 的搜索能力依赖系统可执行 `rg`（ripgrep）
- 检测：`rg --version`
- Windows 安装（任选其一）：`winget install BurntSushi.ripgrep.MSVC` / `choco install ripgrep` / `scoop install ripgrep`
- macOS：`brew install ripgrep`
- Ubuntu/Debian：`sudo apt-get update && sudo apt-get install -y ripgrep`
- Fedora：`sudo dnf install -y ripgrep`

## 工具选择指南

| 操作               | 推荐工具                                                                           |
| ------------------ | ---------------------------------------------------------------------------------- |
| 读取文件           | `team_mgmt_read_file`                                                              |
| 列出 provider      | `team_mgmt_list_providers`                                                         |
| 列出模型           | `team_mgmt_list_models`                                                            |
| 搜索内容           | `team_mgmt_ripgrep_snippets`                                                       |
| 创建新文件         | `team_mgmt_create_new_file`                                                        |
| 小改动（行号范围） | `team_mgmt_prepare_file_range_edit` → `team_mgmt_apply_file_modification`          |
| 末尾追加           | `team_mgmt_prepare_file_append` → `team_mgmt_apply_file_modification`              |
| 锚点插入           | `team_mgmt_prepare_file_insert_after/before` → `team_mgmt_apply_file_modification` |
| 块替换             | `team_mgmt_prepare_file_block_replace` → `team_mgmt_apply_file_modification`       |
| 覆盖整个文件       | `team_mgmt_overwrite_entire_file`                                                  |
| 验证 team 配置     | `team_mgmt_validate_team_cfg({})`                                                  |
| 验证 mcp 配置      | `team_mgmt_validate_mcp_cfg({})`                                                   |
