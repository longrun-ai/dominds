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
  return (await tool.call(dlg as never, caller, { toolsetId: 'team_mgmt', topics: ['team'] }))
    .content;
}

async function main(): Promise<void> {
  const zh = await render('zh');
  const en = await render('en');

  assert.ok(
    zh.includes('object key 完全 freeform'),
    'zh team manual should say gofor object keys are freeform',
  );
  assert.ok(
    zh.includes('给其他队友/人类看的“正向诉请路由卡”'),
    'zh team manual should frame gofor as a routing card for others',
  );
  assert.ok(zh.includes('`members.<id>.nogo`'), 'zh team manual should mention nogo');
  assert.ok(
    zh.includes('不要把该成员自己的执行守则'),
    'zh team manual should say gofor is not for the member’s own rules',
  );
  assert.ok(
    zh.includes('`- When: ...` / `- Ask: ...`') && zh.includes('YAML list，也仍然允许'),
    'zh team manual should say structured gofor lists are still allowed',
  );
  assert.ok(
    zh.includes('`team_mgmt_validate_team_cfg({})` 会给 warning'),
    'zh team manual should mention the warning for structured gofor lists',
  );

  assert.ok(
    en.includes('object keys are fully freeform'),
    'en team manual should say gofor object keys are freeform',
  );
  assert.ok(
    en.includes('positive routing card for other teammates/humans'),
    'en team manual should frame gofor as a routing card for others',
  );
  assert.ok(en.includes('`members.<id>.nogo`'), 'en team manual should mention nogo');
  assert.ok(
    en.includes('do not dump the member’s own operating rules') ||
      en.includes('operating rules, work mode, acceptance bar'),
    'en team manual should say gofor is not for the member’s own rules',
  );
  assert.ok(
    en.includes('it is still accepted, but `team_mgmt_validate_team_cfg({})` will warn'),
    'en team manual should mention the warning for structured gofor lists',
  );
  assert.ok(
    en.includes('YAML list like `- When: ...` / `- Ask: ...`') ||
      en.includes('`- When: ...` / `- Ask: ...`'),
    'en team manual should say structured gofor lists are still allowed',
  );

  console.log('team_mgmt manual via man team-gofor-shapes tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt manual via man team-gofor-shapes tests: failed: ${message}`);
  process.exit(1);
});
