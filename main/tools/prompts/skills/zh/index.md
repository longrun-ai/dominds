# skills 个人技能工具手册

`skills` 工具集用于让当前智能体管理自己的个人 skills。

- 写入位置固定为 `.minds/skills/individual/<当前成员 id>/<skill-id>/`
- 个人 skill 会在之后该成员启动对话时进入 Skills 索引；正文按需通过 `read_skill` 读取
- `allowed-tools` 只是兼容公开 skill 格式的元数据，不会自动授予 Dominds 工具权限
- 改 `skill_id` 用 `move_personal_skill`；只改 frontmatter（例如 `name` / `description`）时目前用 `replace_personal_skill` 或 `import_personal_skill_from_file(replace_frontmatter=true)` 重建目标变体
- 团队共享 skill 与 linkable 池由持有 `team_mgmt` 的团队管理智能体维护；个人工具编辑 linked personal skill 时会先物化为个人副本，避免写穿到链接目标

首次创建时直接调用 `add_personal_skill` 即可，目录会自动创建。
