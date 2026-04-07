#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { renderTeamMgmtGuideContent } from '../../main/tools/team_mgmt';

async function render(lang: 'en' | 'zh', topics: ReadonlyArray<string>): Promise<string> {
  return await renderTeamMgmtGuideContent(lang, [...topics]);
}

async function main(): Promise<void> {
  const zhMinds = await render('zh', ['minds']);
  const enMinds = await render('en', ['minds']);
  const zhTeam = await render('zh', ['team']);
  const enTeam = await render('en', ['team']);

  assert.ok(
    zhMinds.includes('`@codex-system-prompt`') &&
      zhMinds.includes('`@codex-system-prompt:<model>`'),
    'zh minds manual should explain the codex persona directive and model-pinned form',
  );
  assert.ok(
    zhMinds.includes('stock Codex 内置系统提示'),
    'zh minds manual should explain what @codex-system-prompt imports',
  );
  assert.ok(
    enMinds.includes('`@codex-system-prompt`') &&
      enMinds.includes('`@codex-system-prompt:<model>`'),
    'en minds manual should explain the codex persona directive and model-pinned form',
  );
  assert.ok(
    enMinds.includes('stock Codex built-in system prompt'),
    'en minds manual should explain what @codex-system-prompt imports',
  );

  assert.ok(
    zhTeam.includes('行为接近 stock Codex 的显在队友') && zhTeam.includes('`provider: codex`'),
    'zh team manual should guide team managers to create a visible codex teammate when needed',
  );
  assert.ok(
    zhTeam.includes('`ws_read` / `ws_mod` / `codex_style_tools`'),
    'zh team manual should explain the recommended codex teammate toolset combination',
  );
  assert.ok(
    enTeam.includes('visible teammate that behaves close to stock Codex') &&
      enTeam.includes('`provider: codex`'),
    'en team manual should guide team managers to create a visible codex teammate when needed',
  );
  assert.ok(
    enTeam.includes('`ws_read` / `ws_mod` / `codex_style_tools`'),
    'en team manual should explain the recommended codex teammate toolset combination',
  );

  console.log('team_mgmt manual codex-persona-directive tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt manual codex-persona-directive tests: failed: ${message}`);
  process.exit(1);
});
