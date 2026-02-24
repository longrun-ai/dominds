#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Team } from 'dominds/team';
import { teamMgmtValidateMcpCfgTool } from 'dominds/tools/team_mgmt';

async function withTempRtws(mcpYamlContent: string, run: () => Promise<void>): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-mcp-validate-'));
  const oldCwd = process.cwd();
  try {
    await fs.mkdir(path.join(tmpDir, '.minds'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.minds', 'mcp.yaml'), mcpYamlContent, 'utf8');
    process.chdir(tmpDir);
    await run();
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await withTempRtws(
    [
      'version: 1',
      'servers:',
      '  sdk_stdio:',
      '    transport: stdio',
      '    command: node',
      "    args: ['-e', 'setInterval(()=>{},1000)']",
      '    tools: { whitelist: [], blacklist: [] }',
      '    transform: []',
      '    manual:',
      '      sections: 42',
      '',
    ].join('\n'),
    async () => {
      const dlg = {
        getLastUserLanguageCode: () => 'en' as const,
      };
      const caller = new Team.Member({ id: 'tester', name: 'Tester' });
      const out = await teamMgmtValidateMcpCfgTool.call(dlg, caller, {});

      assert.ok(
        out.includes('toolset_manual_error'),
        'validate tool should report toolset_manual_error for invalid manual declaration',
      );
      assert.ok(
        out.includes('servers.sdk_stdio.manual.sections'),
        'validate tool should include the precise invalid manual field path',
      );
    },
  );

  console.log('team_mgmt_validate_mcp_cfg manual-errors tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt_validate_mcp_cfg manual-errors tests: failed: ${message}`);
  process.exit(1);
});
