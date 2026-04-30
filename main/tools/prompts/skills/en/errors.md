# skills Error Handling

Common errors:

- `skill_id` is empty or contains `/`, `\`, or `..`: use one segment such as `repo-debugger`
- Add fails because the file exists: use `replace_personal_skill`
- Replace/delete fails because the file does not exist: create it first with `add_personal_skill`, or check `variant`
- `content` is empty: provide complete SKILL markdown, or provide `name` / `description` / `body` together
- Import from file fails because `replace_frontmatter=true` lacks `name` / `description`: provide both, since the source frontmatter will be discarded
- Linked personal skill deletion: `drop_personal_skill` removes the personal symlink reference itself without touching the linked target
- Linked personal skill editing: add/replace first materializes a personal copy, so the original symlink target is not modified

The personal skill path is isolated by current member id automatically; do not include the member id in `skill_id`.
