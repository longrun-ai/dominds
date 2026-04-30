# skills Scenarios

Create a Chinese personal skill:

```json
{
  "skill_id": "repo-debugger",
  "variant": "cn",
  "name": "repo-debugger",
  "description": "Use when debugging repository-level build/test failures; not for product decisions or requirement discovery.",
  "body": "##### Entry\n- Confirm the failure signal and reproduction path first.\n- Then trace the call chain to root cause."
}
```

Replace with complete SKILL markdown:

```json
{
  "skill_id": "review-checklist",
  "content": "---\nname: review-checklist\ndescription: Code review checklist.\n---\n\n- Start with behavior contracts.\n- Then inspect test coverage."
}
```

Import a locally edited skill file while replacing upstream frontmatter:

```json
{
  "skill_id": "downloaded-reviewer",
  "source_path": "tmp/downloaded-reviewer.md",
  "variant": "en",
  "replace_frontmatter": true,
  "name": "downloaded-reviewer",
  "description": "Use for focused review after adapting the downloaded skill body."
}
```
