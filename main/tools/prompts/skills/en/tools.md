# skills Tools Reference

### add_personal_skill

Create a personal skill for the current agent.

Pass full `content`, or pass `name` / `description` / `body` and let the tool generate SKILL frontmatter.

If the target personal skill package is currently a symlink, the tool materializes a personal copy before writing the new variant.

### import_personal_skill_from_file

Import a skill variant from an rtws markdown file. Use this after incrementally editing a downloaded or local skill file with normal file tools.

By default the source file must already be complete SKILL markdown with valid frontmatter. Set `replace_frontmatter=true` to strip the source frontmatter and rebuild it from `name` / `description` and optional metadata arguments; this lets you keep a long body in a file without copying it into tool arguments.

### replace_personal_skill

Replace an existing personal skill variant. The default variant is `neutral`, which writes `SKILL.md`.

If the target personal skill package is currently a symlink, the tool materializes a personal copy before replacing content. The original symlink target is not modified.

### drop_personal_skill

Delete a personal skill package. If `variant` is provided, delete only the matching `SKILL.cn.md` / `SKILL.en.md` / `SKILL.md`.

For a linked personal skill package, this tool removes your personal symlink reference itself without touching the linked target.
