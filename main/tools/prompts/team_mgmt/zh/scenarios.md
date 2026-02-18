# team_mgmt 使用场景

## 模板（场景）

### 场景格式

- 目标
- 前置条件
- 步骤
- 期望信号
- 失败分支处理
- 完成判据

## 常见场景

### 1. 读取团队配置

```text
Call the function tool `team_mgmt_read_file` with:
{ "path": "team.yaml" }
```

### 2. 列出可用的 providers / models

先看当前有哪些 provider（内置 + rtws）：

```text
调用函数工具 `team_mgmt_list_providers`：
{ "provider_pattern": "*", "show_models": true }
```

再按 provider/model 过滤查看模型清单：

```text
调用函数工具 `team_mgmt_list_models`：
{ "source": "effective", "provider_pattern": "openai*", "model_pattern": "*", "include_param_options": false }
```

### 3. 修改团队配置（两步）

**步骤 1: Prepare**

```text
Call the function tool `team_mgmt_prepare_file_range_edit` with:
{ "path": "team.yaml", "range": "10~12", "content": "new-content: value" }
```

**步骤 2: Apply（必须单独一轮）**

```text
Call the function tool `team_mgmt_apply_file_modification` with:
{ "hunk_id": "<hunk_id>" }
```

### 4. 创建新的 mind 文件

```text
Call the function tool `team_mgmt_create_new_file` with:
{ "path": "team/domains/new-domain.md", "content": "" }
```

或者创建带初始内容：

```text
Call the function tool `team_mgmt_prepare_file_append` with:
{ "path": "team/domains/new-domain.md", "content": "# New Domain\n\nContent here.", "create": true }
```

然后 apply。

### 5. 为成员补充 persona / lessons 资产（推荐）

强烈建议每个成员都维护 `persona/knowledge/lessons` 资产。下面给一个最小可用起点（可按团队语境改写）：

```markdown
# .minds/team/coder/persona.zh.md

# @coder 角色设定

## 核心身份

- 专业程序员，负责按规格完成代码开发。

## 工作边界

- 不负责需求分析或产品策略决策。
- 只根据已确认的开发规格进行实现与重构。
```

```markdown
# .minds/team/coder/lessons.zh.md

# @coder 经验教训

- 修改前先定位调用链与数据流，避免“只改表面”。
- 涉及权限/配置时，改完立即运行对应校验工具并清空 Problems。
```

### 6. 验证配置

修改完 `.minds/team.yaml` 后务必运行：

```text
Call the function tool `team_mgmt_validate_team_cfg` with:
{}
```

确保 Problems 面板无错误后再继续。

修改完 `.minds/mcp.yaml` 后务必运行：

```text
Call the function tool `team_mgmt_validate_mcp_cfg` with:
{}
```

确保 Problems 面板无 MCP 相关错误后再继续。

### 7. 配置 shell 专员（使用 os 工具集）

`os` 包含 `shell_cmd` / `stop_daemon` / `get_daemon_output`。建议只给少数专员成员，并同步设置 `shell_specialists`：

```yaml
shell_specialists: [ops]
members:
  ops:
    toolsets: [ws_read, ws_mod, os]
```

改完后运行 `team_mgmt_validate_team_cfg({})`，确认无 `shell_specialists` 相关错误。

### 8. 搜索团队配置

```text
Call the function tool `team_mgmt_ripgrep_snippets` with:
{ "pattern": "member", "path": "team.yaml" }
```

### 9. 覆盖整个配置文件

```text
Call the function tool `team_mgmt_read_file` with:
{ "path": "team.yaml" }
```

获取 `total_lines` 和 `size_bytes` 后：

```text
Call the function tool `team_mgmt_overwrite_entire_file` with:
{ "path": "team.yaml", "content": "members:\n  - id: user1\n    name: User One\n", "known_old_total_lines": 10, "known_old_total_bytes": 256 }
```

## 使用决策树

1. **操作什么类型的文件？**
   - `team.yaml` 或其他配置 → 继续
   - mind 文件 → 继续

2. **是否要创建新文件？**
   - 是 → `team_mgmt_create_new_file`
   - 否 → 继续

3. **是否要完全覆盖？**
   - 是 → `team_mgmt_read_file` 获取快照 → `team_mgmt_overwrite_entire_file`
   - 否 → 继续

4. **是否知道行号？**
   - 是 → `team_mgmt_prepare_file_range_edit` → `team_mgmt_apply_file_modification`
   - 否 → 继续

5. **是否可以用锚点定位？**
   - 是 → `team_mgmt_prepare_file_insert_after/before` 或 `team_mgmt_prepare_file_block_replace`
   - 搜索锚点 → 先用 `team_mgmt_ripgrep_snippets`

## 重要提醒

- 每次修改 `team.yaml` 后都要运行 `team_mgmt_validate_team_cfg({})` 并确认无错误
- 每次修改 `mcp.yaml` 后都要运行 `team_mgmt_validate_mcp_cfg({})` 并确认无错误
- 如授予 `os` 或其他 shell 工具，必须同步维护顶层 `shell_specialists`
- 使用 prepare/apply 时，prepare 和 apply 必须分两轮
- 所有路径会自动加上 `.minds/` 前缀
