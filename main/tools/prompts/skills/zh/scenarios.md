# skills 使用场景

创建中文个人技能：

```json
{
  "skill_id": "repo-debugger",
  "variant": "cn",
  "name": "repo-debugger",
  "description": "调试仓库级构建/测试失败时使用；不适合产品决策或需求澄清。",
  "body": "##### 入口\n- 先确认失败信号与复现入口。\n- 再沿调用链定位根因。"
}
```

替换为完整 SKILL markdown：

```json
{
  "skill_id": "review-checklist",
  "content": "---\nname: review-checklist\ndescription: 代码评审检查清单。\n---\n\n- 先看行为契约。\n- 再看测试覆盖。"
}
```

导入已在本地微调过的 skill 文件，并替换上游 frontmatter：

```json
{
  "skill_id": "downloaded-reviewer",
  "source_path": "tmp/downloaded-reviewer.md",
  "variant": "cn",
  "replace_frontmatter": true,
  "name": "downloaded-reviewer",
  "description": "基于下载来的 skill 正文微调后，用于集中代码评审。"
}
```
