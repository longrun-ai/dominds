#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { renderTeamMgmtGuideContent } from '../../main/tools/team_mgmt-manual';

async function render(lang: 'en' | 'zh', topics: ReadonlyArray<string>): Promise<string> {
  return await renderTeamMgmtGuideContent(lang, [...topics]);
}

async function main(): Promise<void> {
  const zhMinds = await render('zh', ['minds']);
  const enMinds = await render('en', ['minds']);
  const zhTeam = await render('zh', ['team']);
  const enTeam = await render('en', ['team']);

  assert.ok(
    !zhMinds.includes('stock Codex 内置系统提示'),
    'zh minds manual should avoid historical prompt-splicing baggage',
  );
  assert.ok(
    !enMinds.includes('stock Codex built-in system prompt'),
    'en minds manual should avoid historical prompt-splicing baggage',
  );

  assert.ok(
    zhTeam.includes('行为接近 stock Codex 的显在队友') && zhTeam.includes('`provider: codex`'),
    'zh team manual should guide team managers to create a visible codex teammate when needed',
  );
  assert.ok(
    zhTeam.includes('`ws_read` / `ws_mod` / `codex_inspect_and_patch_tools`') &&
      zhTeam.includes('`gpt-5.x`'),
    'zh team manual should recommend codex_inspect_and_patch_tools for gpt-5.x models',
  );
  assert.ok(
    enTeam.includes('visible teammate that behaves close to stock Codex') &&
      enTeam.includes('`provider: codex`'),
    'en team manual should guide team managers to create a visible codex teammate when needed',
  );
  assert.ok(
    enTeam.includes('`ws_read` / `ws_mod` / `codex_inspect_and_patch_tools`') &&
      enTeam.includes('`gpt-5.x`'),
    'en team manual should recommend codex_inspect_and_patch_tools for gpt-5.x models',
  );

  console.log('team_mgmt manual codex-teammate-guidance tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt manual codex-teammate-guidance tests: failed: ${message}`);
  process.exit(1);
});
