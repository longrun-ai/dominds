# skills 错误处理

常见错误：

- `skill_id` 为空或包含 `/`、`\`、`..`：改为单段标识，例如 `repo-debugger`
- 创建时文件已存在：改用 `replace_personal_skill`
- 替换/删除时文件不存在：先用 `add_personal_skill` 创建，或确认 `variant`
- `content` 为空：提供完整 SKILL markdown，或同时提供 `name` / `description` / `body`
- 从文件导入时若 `replace_frontmatter=true` 缺少 `name` / `description`：必须补齐两者，因为源文件 frontmatter 会被丢弃
- 删除 linked personal skill：`drop_personal_skill` 会删除个人 symlink 引用本身，不触碰链接目标
- 编辑 linked personal skill：add/replace 会先物化成个人副本，因此不会修改原 symlink 目标

个人 skill 路径由系统按当前成员 id 隔离，不要把成员 id 写进 `skill_id`。
