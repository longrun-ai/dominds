# skills 工具参考

### add_personal_skill

创建当前智能体自己的个人 skill。

可直接传完整 `content`，也可以传 `name` / `description` / `body`，由工具生成 `SKILL*.md` frontmatter。

如果目标个人 skill 包当前是 symlink，本工具会先物化成个人副本，再写入新变体。

### import_personal_skill_from_file

从 rtws markdown 文件导入一个 skill 变体。适合先用普通文件工具增量维护下载来的或本地的 skill 文件，再把结果导入个人 skills。

默认要求源文件已经是完整且 frontmatter 合法的 SKILL markdown。设置 `replace_frontmatter=true` 时，会丢弃源文件 frontmatter，并用 `name` / `description` 及可选元数据参数重建 frontmatter；这样长正文保留在文件里，不需要复制到工具参数中。

### replace_personal_skill

替换已有个人 skill 的指定语言变体。默认变体是 `neutral`，即 `SKILL.md`。

如果目标个人 skill 包当前是 symlink，本工具会先物化成个人副本，再替换内容；原链接目标不会被修改。

### drop_personal_skill

删除一个个人 skill 包；如果传入 `variant`，只删除对应的 `SKILL.cn.md` / `SKILL.en.md` / `SKILL.md`。

对于 linked personal skill 包，本工具会删除你的个人 symlink 引用本身，不触碰链接目标。
