#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { Team } from '../../main/team';
import '../../main/tools/builtins';
import { buildToolsetManualTools } from '../../main/tools/toolset-manual';

async function render(lang: 'en' | 'zh', topics: ReadonlyArray<string>): Promise<string> {
  const built = buildToolsetManualTools({ toolsetNames: [], existingToolNames: new Set<string>() });
  const tool = built.tools.find((entry) => entry.name === 'man');
  assert.ok(tool, 'man tool should be available');
  const dlg = {
    getLastUserLanguageCode: () => lang,
  };
  const caller = new Team.Member({ id: 'tester', name: 'Tester', toolsets: ['team_mgmt'] });
  return (await tool.call(dlg as never, caller, { toolsetId: 'team_mgmt', topics: [...topics] }))
    .content;
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
    zh.includes(
      '它会进入该成员的 `role=system` 提示，因此默认应直接写给该智能体本人，使用第二人称“你”',
    ),
    'zh minds manual should require second-person authoring for persona files',
  );
  assert.ok(
    en.includes('The system prompt already adds: `## Persona` / `## Knowledge` / `## Lessons`'),
    'en minds manual should explain auto-added system-prompt headings',
  );
  assert.ok(
    en.includes(
      'It is injected into that member\'s `role=system` prompt, so write it directly to the agent in second person ("you")',
    ),
    'en minds manual should require second-person authoring for persona files',
  );

  assertNotIncludes(zh, '# @coder 角色设定');
  assertNotIncludes(zh, '# @coder 经验教训');
  assertNotIncludes(zh, '# .minds/team/coder/persona.zh.md（示例）');
  assertNotIncludes(en, '# @coder Persona');
  assertNotIncludes(en, '# @coder Lessons');
  assertNotIncludes(en, '# .minds/team/coder/persona.en.md (example)');

  console.log('team_mgmt manual via man minds-manual-mindset-headings tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt manual via man minds-manual-mindset-headings tests: failed: ${message}`);
  process.exit(1);
});
