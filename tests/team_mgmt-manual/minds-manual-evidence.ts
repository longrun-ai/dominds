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

function excerptAround(haystack: string, marker: string): string {
  const idx = haystack.indexOf(marker);
  if (idx < 0) return `[missing marker: ${marker}]`;
  const start = Math.max(0, idx - 140);
  const end = Math.min(haystack.length, idx + 420);
  return haystack.slice(start, end).trim();
}

async function main(): Promise<void> {
  const zhMinds = await render('zh', 'minds');
  const enMinds = await render('en', 'minds');

  console.log('=== zh minds evidence ===');
  console.log(excerptAround(zhMinds, '共同去向（按当前实现）'));
  console.log();
  console.log(excerptAround(zhMinds, 'knowhow.*.md：'));
  console.log();
  console.log(excerptAround(zhMinds, 'pitfalls.*.md：'));
  console.log();
  console.log(excerptAround(zhMinds, '标题层级约束：'));
  console.log();

  console.log('=== en minds evidence ===');
  console.log(excerptAround(enMinds, 'Shared destination (current implementation)'));
  console.log();
  console.log(excerptAround(enMinds, 'knowhow.*.md:'));
  console.log();
  console.log(excerptAround(enMinds, 'pitfalls.*.md:'));
  console.log();
  console.log(excerptAround(enMinds, 'Heading rule:'));
  console.log();

  console.log('=== review prompts ===');
  console.log('- Check that the manual names the injected sections and file kinds consistently.');
  console.log(
    '- Check that `knowhow/pitfalls` semantics match the intended positive/negative split.',
  );
  console.log(
    '- Check that migration wording matches runtime behavior: new names preferred, legacy names fallback-only.',
  );
  console.log(
    '- Check that heading guidance still matches the actual system-prompt wrapper titles.',
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt manual evidence export failed: ${message}`);
  process.exit(1);
});
