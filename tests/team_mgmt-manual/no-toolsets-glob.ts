#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { Team } from '../../main/team';
import '../../main/tools/builtins';
import { buildToolsetManualTools } from '../../main/tools/toolset-manual';

function assertNotIncludes(haystack: string, needle: string): void {
  assert.ok(!haystack.includes(needle), `Expected output not to include: ${needle}`);
}

async function render(lang: 'en' | 'zh', topics: ReadonlyArray<string>): Promise<string> {
  const built = buildToolsetManualTools({ toolsetNames: [], existingToolNames: new Set<string>() });
  const tool = built.tools.find((entry) => entry.name === 'man');
  assert.ok(tool, 'man tool should be available');
  const dlg = {
    getLastUserLanguageCode: () => lang,
  };
  const caller = new Team.Member({ id: 'tester', name: 'Tester', toolsets: ['team_mgmt'] });
  return await tool.call(dlg as never, caller, { toolsetId: 'team_mgmt', topics: [...topics] });
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

  console.log('team_mgmt manual via man no-toolsets-glob tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt manual via man no-toolsets-glob tests: failed: ${message}`);
  process.exit(1);
});
