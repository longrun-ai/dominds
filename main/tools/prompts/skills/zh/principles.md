# skills 原则

个人 skill 适合承接“你自己会长期复用的操作指引”，例如跨工作区可复用的调试套路、个人审查清单、常见任务的执行路径。

- 若内容是团队共识或应被多个队友共享，优先让团队管理智能体写到 `.minds/skills/team_shared` 或 `.minds/skills/linkable`
- 若内容只是事实/索引/经验笔记，而不是会被当作提示词执行的操作指引，优先使用 `personal_memory`
- 选型原则：工作区关联强的事实、路径、局部契约 -> `personal_memory` / `team_memory` / `.minds/env*.md`；独立于工作区内容的操作方法、检查清单、触发条件与边界 -> skill
- 团队协作 SOP 通常优先做成团队共享 skill：描述职责、输入输出、交接/升级/同步节奏和验收口径；涉及当前工作区资产时，先抽象成可泛指概念，具体路径/成员/工具绑定放到 memory/env/team.yaml
- 若一个经验同时包含通用方法和当前仓库事实，请拆开：skill 写通用步骤，memory/env 写当前 rtws 的路径、命令入口、局部契约；skill 中只提示需要先读取相应 memory/env
- 若内容依赖脚本、工具权限、MCP 或外部能力，不要只写 skill；应配套 Dominds app/toolset 或团队权限配置
- `allowed-tools` 只是上游格式元数据，不会自动授予 Dominds 工具权限；权限仍由 team.yaml / toolsets / apps 决定
- `skill_id` 只写单段标识，例如 `repo-debugger`，不要包含成员 id 或路径
