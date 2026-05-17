#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { Team } from '../../main/team';
import '../../main/tools/builtins';
import { buildToolsetManualTools } from '../../main/tools/toolset-manual';

async function render(lang: 'en' | 'zh'): Promise<string> {
  const built = buildToolsetManualTools({ toolsetNames: [], existingToolNames: new Set<string>() });
  const tool = built.tools.find((entry) => entry.name === 'man');
  assert.ok(tool, 'man tool should be available');
  const dlg = {
    getLastUserLanguageCode: () => lang,
  };
  const caller = new Team.Member({ id: 'tester', name: 'Tester', toolsets: ['team_mgmt'] });
  return (await tool.call(dlg as never, caller, { toolsetId: 'team_mgmt', topics: ['skills'] }))
    .content;
}

async function main(): Promise<void> {
  const zh = await render('zh');
  const en = await render('en');

  assert.ok(
    zh.includes('.minds/skills/team_shared/<skill-id>/SKILL.cn.md'),
    'zh skills manual should document the team_shared directory layout',
  );
  assert.ok(
    zh.includes('allowed-tools') && zh.includes('不会自动授予工具权限'),
    'zh skills manual should explain that allowed-tools does not auto-grant Dominds permissions',
  );
  assert.ok(
    zh.includes('Dominds app') && zh.includes('带脚本/工具调用约束'),
    'zh skills manual should recommend app packaging for script-backed public skills',
  );
  assert.ok(
    zh.includes('.minds/skills/linkable') &&
      zh.includes('team_mgmt_rm_symlink') &&
      zh.includes('copy-on-write'),
    'zh skills manual should document broad symlink distribution and personal COW semantics',
  );
  assert.ok(
    zh.includes('Anthropic subagent') && zh.includes('GitHub `copilot-instructions.md`'),
    'zh skills manual should include migration guidance for official public formats',
  );
  assert.ok(
    zh.includes('团队协作 SOP 的资产分流最佳实践') &&
      zh.includes('团队协作 SOP 通常应优先做成团队共享 skill') &&
      zh.includes('绑定外置'),
    'zh skills manual should include team collaboration SOP asset-splitting best practices',
  );
  assert.ok(
    zh.includes('代码评审协作') &&
      zh.includes('WebUI 验收协作') &&
      zh.includes('发布/回滚协作') &&
      zh.includes('反例'),
    'zh skills manual should explain SOP splitting with representative examples',
  );
  assert.ok(
    zh.includes('read_skill({ "skill_id": "..." })') && zh.includes('正文不是默认全量注入'),
    'zh skills manual should describe summary-first read_skill loading semantics',
  );

  assert.ok(
    en.includes('.minds/skills/team_shared/<skill-id>/SKILL.cn.md'),
    'en skills manual should document the team_shared directory layout',
  );
  assert.ok(
    en.includes('allowed-tools') &&
      (en.includes('do not grant tools') || en.includes('informational only in Dominds')),
    'en skills manual should explain allowed-tools mapping clearly',
  );
  assert.ok(
    en.includes('Dominds app') && en.includes('scripts / Bash allowlists / MCP'),
    'en skills manual should recommend app packaging for script-backed public skills',
  );
  assert.ok(
    en.includes('.minds/skills/linkable') &&
      en.includes('team_mgmt_rm_symlink') &&
      en.includes('copy-on-write'),
    'en skills manual should document broad symlink distribution and personal COW semantics',
  );
  assert.ok(
    en.includes('Anthropic subagent') && en.includes('GitHub `copilot-instructions.md`'),
    'en skills manual should include migration guidance for official public formats',
  );
  assert.ok(
    en.includes('Best Practices: Splitting Team Collaboration SOP Assets') &&
      en.includes('team collaboration SOPs usually belong in team-shared skills') &&
      en.includes('Keep bindings outside the SOP'),
    'en skills manual should include team collaboration SOP asset-splitting best practices',
  );
  assert.ok(
    en.includes('code-review collaboration') &&
      en.includes('WebUI acceptance collaboration') &&
      en.includes('release/rollback collaboration') &&
      en.includes('Anti-example'),
    'en skills manual should explain SOP splitting with representative examples',
  );
  assert.ok(
    en.includes('read_skill({ "skill_id": "..." })') && en.includes('not injected eagerly'),
    'en skills manual should describe summary-first read_skill loading semantics',
  );

  console.log('team_mgmt manual via man skills-manual tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt manual via man skills-manual tests: failed: ${message}`);
  process.exit(1);
});
