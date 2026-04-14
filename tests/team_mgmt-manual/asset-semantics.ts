#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { Team } from '../../main/team';
import '../../main/tools/builtins';
import { buildToolsetManualTools } from '../../main/tools/toolset-manual';

async function render(
  lang: 'en' | 'zh',
  topic: 'minds' | 'skills' | 'priming' | 'env',
): Promise<string> {
  const built = buildToolsetManualTools({ toolsetNames: [], existingToolNames: new Set<string>() });
  const tool = built.tools.find((entry) => entry.name === 'man');
  assert.ok(tool, 'man tool should be available');
  const dlg = {
    getLastUserLanguageCode: () => lang,
  };
  const caller = new Team.Member({ id: 'tester', name: 'Tester', toolsets: ['team_mgmt'] });
  return (await tool.call(dlg as never, caller, { toolsetId: 'team_mgmt', topics: [topic] }))
    .content;
}

async function main(): Promise<void> {
  const zhMinds = await render('zh', 'minds');
  assert.ok(
    zhMinds.includes('分别拼进 system prompt 的 `## 角色设定` / `## 知识` / `## 经验` 章节'),
    'zh minds manual should explain where persona/knowledge/lessons are injected',
  );
  assert.ok(
    zhMinds.includes('knowledge.*.md：领域知识。它会进入 `## 知识`'),
    'zh minds manual should explain knowledge tone and destination',
  );
  assert.ok(
    zhMinds.includes('lessons.*.md：经验教训。它会进入 `## 经验`'),
    'zh minds manual should explain lessons tone and destination',
  );
  assert.ok(
    zhMinds.includes('标题层级约束：`persona/knowledge/lessons` 文件里不要再写重复的总标题') &&
      zhMinds.includes('不要再把文件名或“角色设定/知识/经验”重复当标题写一遍'),
    'zh minds manual should explain heading levels and duplicate-title avoidance',
  );

  const enMinds = await render('en', 'minds');
  assert.ok(
    enMinds.includes(
      'are read at every dialog start and are spliced into the system prompt as `## Persona` / `## Knowledge` / `## Lessons`',
    ),
    'en minds manual should explain where persona/knowledge/lessons are injected',
  );
  assert.ok(
    enMinds.includes('knowledge.*.md: domain knowledge. It lands in `## Knowledge`'),
    'en minds manual should explain knowledge tone and destination',
  );
  assert.ok(
    enMinds.includes('lessons.*.md: lessons learned. It lands in `## Lessons`'),
    'en minds manual should explain lessons tone and destination',
  );
  assert.ok(
    enMinds.includes(
      'Heading rule: do not add top-level titles that duplicate the system prompt wrapper',
    ) && enMinds.includes('should not restate the filename or wrapper title as a heading'),
    'en minds manual should explain heading levels and duplicate-title avoidance',
  );

  const zhSkills = await render('zh', 'skills');
  assert.ok(
    zhSkills.includes('`name` 会成为 skills 小节里的标题') &&
      zhSkills.includes('正文会原样进入 `Prompt` 区块'),
    'zh skills manual should explain where skill title/description/body go',
  );
  assert.ok(
    zhSkills.includes('不要写成 marketplace 营销文案'),
    'zh skills manual should prescribe the right skill tone',
  );
  assert.ok(
    zhSkills.includes(
      'skills 模板已经自动包好 `### Skills（工作技能）` 和每个 skill 的 `#### <name>` 标题',
    ) && !zhSkills.includes('# Repo Debugger'),
    'zh skills manual should explain heading levels and avoid duplicated body title',
  );

  const enSkills = await render('en', 'skills');
  assert.ok(
    enSkills.includes('`name` is rendered as the skill heading') &&
      enSkills.includes(
        'the body is inserted verbatim into the `Prompt` block inside system prompt',
      ),
    'en skills manual should explain where skill title/description/body go',
  );
  assert.ok(
    enSkills.includes('avoid marketplace sales copy'),
    'en skills manual should prescribe the right skill tone',
  );
  assert.ok(
    enSkills.includes(
      'the wrapper already provides `### Skills` and `#### <name>` for each skill',
    ) && !enSkills.includes('# Repo Debugger'),
    'en skills manual should explain heading levels and avoid duplicated body title',
  );

  const zhPriming = await render('zh', 'priming');
  assert.ok(
    zhPriming.includes('frontmatter 里的 `reminders` 会先恢复为该对话的提醒状态') &&
      zhPriming.includes('随后脚本 records 会被追加进持久化事件流'),
    'zh priming manual should explain reminder restore and record replay',
  );
  assert.ok(
    zhPriming.includes('`human_text_record` 会变成 `role=user`') &&
      zhPriming.includes('`agent_words_record` 会变成 `role=assistant`'),
    'zh priming manual should explain tone by record role',
  );
  assert.ok(
    zhPriming.includes(
      '`ui_only_markdown_record` 以及若干运行时技术 record 会被持久化，但不会转成喂给模型的 chat message',
    ),
    'zh priming manual should explain which records do not steer model context',
  );
  assert.ok(
    zhPriming.includes('顶层 frontmatter + 多个 `### record <type>` 块') &&
      zhPriming.includes('不要再包一层 `# 启动脚本` / `## 历史`'),
    'zh priming manual should explain outer structure instead of decorative headings',
  );

  const enPriming = await render('en', 'priming');
  assert.ok(
    enPriming.includes('frontmatter `reminders` are restored into dialog reminder state first') &&
      enPriming.includes(
        'records are appended to the persisted event stream and replayed into dialog history',
      ),
    'en priming manual should explain reminder restore and record replay',
  );
  assert.ok(
    enPriming.includes('`human_text_record` becomes a `role=user` prompting message') &&
      enPriming.includes('`agent_words_record` becomes a visible `role=assistant` reply'),
    'en priming manual should explain tone by record role',
  );
  assert.ok(
    enPriming.includes('persist on disk but do not become chat messages for model context'),
    'en priming manual should explain which records do not steer model context',
  );
  assert.ok(
    enPriming.includes('top-level frontmatter + repeated `### record <type>` blocks') &&
      enPriming.includes(
        'Do not wrap the script in decorative `# Startup Script` / `## History` headings',
      ),
    'en priming manual should explain outer structure instead of decorative headings',
  );

  const zhEnv = await render('zh', 'env');
  assert.ok(
    zhEnv.includes('`## 运行环境` 章节') && zhEnv.includes('给当前成员做环境定向'),
    'zh env manual should explain exact prompt destination and tone',
  );
  assert.ok(
    zhEnv.includes('不要把 `env.*.md` 写成 persona、skill、工具手册或仓库总规范大杂烩'),
    'zh env manual should explain env authoring boundaries',
  );
  assert.ok(
    zhEnv.includes('系统模板已经提供 `## 运行环境` 标题') &&
      !zhEnv.includes('## 本 rtws 的 Dominds 运行环境说明'),
    'zh env manual should explain heading levels and avoid duplicated wrapper title',
  );

  const enEnv = await render('en', 'env');
  assert.ok(
    enEnv.includes('`## Runtime Environment` section of the agent system prompt') &&
      enEnv.includes('environmental orientation rather than persona definition'),
    'en env manual should explain exact prompt destination and tone',
  );
  assert.ok(
    enEnv.includes(
      'do not turn `env.*.md` into a persona file, skill, tool manual, or giant repo-policy dump',
    ),
    'en env manual should explain env authoring boundaries',
  );
  assert.ok(
    enEnv.includes('the system template already provides the `## Runtime Environment` heading') &&
      !enEnv.includes('## Dominds runtime environment notes'),
    'en env manual should explain heading levels and avoid duplicated wrapper title',
  );

  console.log('team_mgmt manual via man asset-semantics tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt manual via man asset-semantics tests: failed: ${message}`);
  process.exit(1);
});
