# skills Personal Skills Tools Manual

The `skills` toolset lets the current agent manage its own personal skills.

- Files are written under `.minds/skills/individual/<current member id>/<skill-id>/`
- Personal skills appear in this member's Skills index in later dialogs; bodies are read on demand through `read_skill`
- `allowed-tools` is compatibility metadata for public skill formats; it does not grant Dominds tools
- Use `move_personal_skill` to change `skill_id`; for frontmatter-only changes such as `name` / `description`, currently use `replace_personal_skill` or `import_personal_skill_from_file(replace_frontmatter=true)` to rebuild the target variant
- Team-shared skills and the linkable pool are maintained by team-management agents with `team_mgmt`; when a personal tool edits a linked personal skill, Dominds first materializes a personal copy so the linked target is not modified

For first-time setup, call `add_personal_skill`; the directory is created automatically.
