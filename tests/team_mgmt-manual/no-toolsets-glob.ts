#!/usr/bin/env tsx

import { Team } from 'dominds/team';
import { teamMgmtManualTool } from 'dominds/tools/team_mgmt';
import assert from 'node:assert/strict';

function assertNotIncludes(haystack: string, needle: string): void {
  assert.ok(!haystack.includes(needle), `Expected output not to include: ${needle}`);
}

async function render(lang: 'en' | 'zh', topics: ReadonlyArray<string>): Promise<string> {
  const dlg = {
    getLastUserLanguageCode: () => lang,
  };
  const caller = new Team.Member({ id: 'tester', name: 'Tester' });
  return await teamMgmtManualTool.call(dlg, caller, { topics: [...topics] });
}

async function main(): Promise<void> {
  const outputs = [
    await render('zh', ['toolsets']),
    await render('en', ['toolsets']),
    await render('zh', ['team']),
    await render('en', ['team']),
  ];

  for (const out of outputs) {
    assertNotIncludes(out, '!team_mgmt');
    assertNotIncludes(out, '!diag');
    assertNotIncludes(out, 'toolsets: ["*"]');
    assertNotIncludes(out, "toolsets: ['*']");
    assertNotIncludes(out, "toolsets supports '*'");
    assertNotIncludes(out, '`toolsets` 支持 `*`');
  }

  console.log('team_mgmt_manual no-toolsets-glob tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt_manual no-toolsets-glob tests: failed: ${message}`);
  process.exit(1);
});
