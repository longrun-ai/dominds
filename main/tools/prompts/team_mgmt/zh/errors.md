# team-mgmt 错误处理

## 常见错误

| 错误码                    | 说明                          | 解决方案                           |
| ------------------------- | ----------------------------- | ---------------------------------- |
| `FILE_NOT_FOUND`          | 文件不存在                    | 使用 `create=true` 或先创建文件    |
| `FILE_EXISTS`             | 文件已存在（create_new_file） | 使用其他路径                       |
| `ANCHOR_NOT_FOUND`        | 锚点未找到                    | 用 `ripgrep_snippets` 确认锚点存在 |
| `ANCHOR_AMBIGUOUS`        | 锚点有多个匹配                | 指定 `occurrence`                  |
| `OCCURRENCE_OUT_OF_RANGE` | occurrence 超范围             | 检查 occurrence 值                 |
| `HUNK_NOT_FOUND`          | hunk 过期/不存在              | 重新 prepare                       |
| `WRONG_OWNER`             | 非当前成员规划的 hunk         | 只能 apply 自己生成的 hunk         |
| `CONTEXT_REJECTED`        | 文件已漂移                    | 重新 prepare                       |
| `PATH_OUTSIDE_MINDS`      | 路径解析到 .minds/ 外         | 检查路径是否正确                   |
| `VALIDATION_ERROR`        | team.yaml 验证失败            | 检查配置文件格式                   |

## 路径错误

**PATH_OUTSIDE_MINDS**

- 原因：路径最终解析不在 `.minds/` 内
- 说明：team-mgmt 会自动将 `path` 解析到 `.minds/` 下，任何最终不在 `.minds/` 内的路径都会被拒绝
- 解决：检查提供的路径是否正确

## 配置验证错误

**VALIDATION_ERROR**

- 原因：`.minds/team.yaml` 格式不正确
- 解决：
  1. 运行 `team_mgmt_validate_team_cfg({})` 查看具体错误
  2. 修复 team.yaml 中的格式问题
  3. 重新验证直到无错误
  4. 清空 Problems 面板后再继续

## 错误预防

1. **修改配置后必须验证**：每次修改 `team.yaml` 后运行 `team_mgmt_validate_team_cfg({})`

2. **prepare → apply 必须分两轮**：同轮并行执行可能导致 apply 看不到 hunk

3. **路径会自动加前缀**：提供 `team.yaml` 会自动解析为 `.minds/team.yaml`

4. **hunk 有 TTL**：尽快 apply，避免 hunk 过期

5. **先读后写**：使用 `overwrite_entire_file` 前先读取获取快照
