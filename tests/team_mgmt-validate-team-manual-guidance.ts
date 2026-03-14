#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Team } from '../main/team';
import '../main/tools/builtins';
import { teamMgmtManualTool, teamMgmtValidateTeamCfgTool } from '../main/tools/team_mgmt';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf8');
}

async function withTempRtws(run: () => Promise<void>): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-team-mgmt-guidance-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    await run();
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await withTempRtws(async () => {
    await writeText(
      path.join(process.cwd(), '.minds', 'llm.yaml'),
      [
        'providers:',
        '  stub:',
        '    name: Stub',
        '    apiType: openai',
        '    baseUrl: https://example.invalid',
        '    apiKeyEnvVar: STUB_API_KEY',
        '    models:',
        '      fake_model: { name: "fake-model" }',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(process.cwd(), '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: stub',
        '  model: fake_model',
        'members:',
        '  team_admin:',
        '    name: Team Admin',
        '    toolsets:',
        '      - playwright_interactive',
        '',
      ].join('\n'),
    );

    const dlg = {
      getLastUserLanguageCode: () => 'en' as const,
    };
    const caller = new Team.Member({ id: 'tester', name: 'Tester' });

    const validateOut = await teamMgmtValidateTeamCfgTool.call(dlg, caller, {});
    assert.ok(
      validateOut.includes(
        'team-management validation tools such as `team_mgmt_validate_team_cfg({})`, `team_mgmt_validate_mcp_cfg({})`, and `team_mgmt_manual({})` should remain usable',
      ),
      'validate_team_cfg should remind that validation/manual tools remain available during app/toolset failures',
    );
    assert.ok(
      validateOut.includes(
        'inspect `.minds/app.yaml` via `team_mgmt_read_file({ path: "app.yaml" })`',
      ),
      'validate_team_cfg should guide the team manager to inspect app.yaml when app toolset bindings fail',
    );
    assert.ok(
      validateOut.includes('`team_mgmt_manual({ topics: ["toolsets","troubleshooting"] })`'),
      'validate_team_cfg should guide the team manager to the relevant manual topics',
    );

    const manualOut = await teamMgmtManualTool.call(dlg, caller, { topics: ['troubleshooting'] });
    assert.ok(
      manualOut.includes(
        'app-provided toolset referenced from `team.yaml` is missing / app capability is unavailable',
      ),
      'troubleshooting manual should include the app toolset failure symptom',
    );
    assert.ok(
      manualOut.includes('`team_mgmt_validate_team_cfg({})` remains available'),
      'troubleshooting manual should explicitly say validate_team_cfg remains available',
    );
  });

  console.log('team_mgmt validate/manual guidance tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt validate/manual guidance tests: failed: ${message}`);
  process.exit(1);
});
