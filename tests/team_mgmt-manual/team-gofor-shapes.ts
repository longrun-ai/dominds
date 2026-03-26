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
  return await tool.call(dlg as never, caller, { toolsetId: 'team_mgmt', topics: ['team'] });
}

async function main(): Promise<void> {
  const zh = await render('zh');
  const en = await render('en');

  assert.ok(
    zh.includes('object key 完全 freeform'),
    'zh team manual should say gofor object keys are freeform',
  );
  assert.ok(
    zh.includes('写成 `- Scope: ...` / `- Deliverables: ...` 的 YAML list，也仍然允许'),
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
    en.includes('it is still accepted, but `team_mgmt_validate_team_cfg({})` will warn'),
    'en team manual should mention the warning for structured gofor lists',
  );
  assert.ok(
    en.includes('YAML list like `- Scope: ...` / `- Deliverables: ...`'),
    'en team manual should say structured gofor lists are still allowed',
  );

  console.log('team_mgmt manual via man team-gofor-shapes tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt manual via man team-gofor-shapes tests: failed: ${message}`);
  process.exit(1);
});
