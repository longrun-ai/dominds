#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { Team } from 'dominds/team';
import { teamMgmtManualTool } from 'dominds/tools/team_mgmt';

async function render(lang: 'en' | 'zh', topics: ReadonlyArray<string>): Promise<string> {
  const dlg = {
    getLastUserLanguageCode: () => lang,
  };
  const caller = new Team.Member({ id: 'tester', name: 'Tester' });
  return await teamMgmtManualTool.call(dlg, caller, { topics: [...topics] });
}

function assertNotIncludes(haystack: string, needle: string): void {
  assert.ok(!haystack.includes(needle), `Expected output not to include: ${needle}`);
}

async function main(): Promise<void> {
  const zh = await render('zh', ['minds']);
  const en = await render('en', ['minds']);

  assert.ok(
    zh.includes('系统提示模板会自动添加：`## 角色设定` / `## 知识` / `## 经验`'),
    'zh minds manual should explain auto-added system-prompt headings',
  );
  assert.ok(
    en.includes('The system prompt already adds: `## Persona` / `## Knowledge` / `## Lessons`'),
    'en minds manual should explain auto-added system-prompt headings',
  );

  assertNotIncludes(zh, '# @coder 角色设定');
  assertNotIncludes(zh, '# @coder 经验教训');
  assertNotIncludes(zh, '# .minds/team/coder/persona.zh.md（示例）');
  assertNotIncludes(en, '# @coder Persona');
  assertNotIncludes(en, '# @coder Lessons');
  assertNotIncludes(en, '# .minds/team/coder/persona.en.md (example)');

  console.log('team_mgmt_manual minds-manual-mindset-headings tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt_manual minds-manual-mindset-headings tests: failed: ${message}`);
  process.exit(1);
});
