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

function excerptAround(haystack: string, marker: string): string {
  const idx = haystack.indexOf(marker);
  if (idx < 0) return `[missing marker: ${marker}]`;
  const start = Math.max(0, idx - 120);
  const end = Math.min(haystack.length, idx + 360);
  return haystack.slice(start, end).trim();
}

async function main(): Promise<void> {
  const zh = await render('zh', ['minds']);
  const en = await render('en', ['minds']);

  console.log('=== zh heading evidence ===');
  console.log(excerptAround(zh, '标题层级约束：'));
  console.log();
  console.log(excerptAround(zh, 'persona.*.md：角色设定'));
  console.log();

  console.log('=== en heading evidence ===');
  console.log(excerptAround(en, 'Heading rule:'));
  console.log();
  console.log(excerptAround(en, 'persona.*.md: persona and operating style.'));
  console.log();

  console.log('=== review prompts ===');
  console.log('- Check that heading guidance matches the current wrapper titles exactly.');
  console.log(
    '- Check that the manual still instructs direct second-person authoring for persona files.',
  );
  console.log('- Check that examples do not accidentally teach duplicate top-level headings.');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt manual heading evidence export failed: ${message}`);
  process.exit(1);
});
