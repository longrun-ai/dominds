# skills Principles

Personal skills are for operating guidance that you expect to reuse yourself, such as portable debugging routines, personal review checklists, or repeat task procedures.

- If the content is a team convention or should be shared with multiple teammates, ask a team-management agent to place it under `.minds/skills/team_shared` or `.minds/skills/linkable`
- If the content is a fact, index, or experience note rather than executable prompt guidance, prefer `personal_memory`
- Selection rule: workspace-coupled facts, paths, and local contracts -> `personal_memory` / `team_memory` / `.minds/env*.md`; workspace-independent operating methods, checklists, triggers, and boundaries -> skill
- Team collaboration SOPs should usually be team-shared skills: describe responsibilities, inputs/outputs, handoff/escalation/synchronization cadence, and acceptance policy; when current-workspace assets are involved, abstract them into generic concepts and keep concrete path/member/tool bindings in memory/env/team.yaml
- If an experience contains both a portable method and current-repo facts, split it: put the reusable procedure in the skill, put this rtws's paths, command entrypoints, and local contracts in memory/env, and have the skill say to consult those assets first
- If the content depends on scripts, tool permissions, MCP, or external capabilities, do not ship it as markdown only; pair it with a Dominds app/toolset or explicit team permissions
- `allowed-tools` is upstream-format metadata only; it does not grant Dominds permissions, which still come from team.yaml / toolsets / apps
- `skill_id` must be one segment such as `repo-debugger`; do not include your member id or path separators
