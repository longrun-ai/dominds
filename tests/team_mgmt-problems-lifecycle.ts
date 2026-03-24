#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getProblemsSnapshot, removeProblemsByPrefix } from '../main/problems';
import { Team } from '../main/team';
import '../main/tools/builtins';
import {
  teamMgmtClearProblemsTool,
  teamMgmtListProblemsTool,
  teamMgmtValidateTeamCfgTool,
} from '../main/tools/team_mgmt';

const TEAM_PROBLEM_PREFIX = 'team/team_yaml_error/';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf8');
}

async function withTempRtws(run: () => Promise<void>): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-team-mgmt-problems-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    await run();
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function listTeamProblems(): ReturnType<typeof getProblemsSnapshot>['problems'] {
  return getProblemsSnapshot().problems.filter((problem) =>
    problem.id.startsWith(TEAM_PROBLEM_PREFIX),
  );
}

async function main(): Promise<void> {
  await withTempRtws(async () => {
    removeProblemsByPrefix(TEAM_PROBLEM_PREFIX);

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

    const invalidTeamYaml = [
      'member_defaults:',
      '  provider: stub',
      '  model: fake_model',
      'members:',
      '  tester:',
      '    name: 123',
      '',
    ].join('\n');
    const validTeamYaml = [
      'member_defaults:',
      '  provider: stub',
      '  model: fake_model',
      'members:',
      '  tester:',
      '    name: Tester',
      '',
    ].join('\n');

    await writeText(path.join(process.cwd(), '.minds', 'team.yaml'), invalidTeamYaml);

    const dlg = {
      getLastUserLanguageCode: () => 'en' as const,
    };
    const caller = new Team.Member({ id: 'tester', name: 'Tester' });

    const invalidOut = await teamMgmtValidateTeamCfgTool.call(dlg, caller, {});
    assert.ok(
      invalidOut.includes('Active Problems'),
      'validate_team_cfg should report active problems in a dedicated section',
    );
    assert.ok(
      listTeamProblems().some((problem) => problem.resolved !== true),
      'invalid team.yaml should leave active team problems in the snapshot',
    );

    const prematureClearOut = await teamMgmtClearProblemsTool.call(dlg, caller, {
      source: 'team',
      path: 'team.yaml',
    });
    assert.ok(
      prematureClearOut.includes('cleared 0 problem(s)'),
      'default clear should not remove active problems',
    );

    await writeText(path.join(process.cwd(), '.minds', 'team.yaml'), validTeamYaml);

    const validOut = await teamMgmtValidateTeamCfgTool.call(dlg, caller, {});
    assert.ok(
      validOut.includes('team.yaml Validation Passed'),
      'validate_team_cfg should pass after team.yaml is fixed',
    );
    assert.ok(
      validOut.includes('Resolved But Not Yet Cleared'),
      'resolved history should be reported in a separate section',
    );
    assert.ok(
      validOut.includes('team_mgmt_clear_problems({ source: "team", path: "team.yaml" })'),
      'resolved-history section should include the clear hint',
    );

    const listedOut = await teamMgmtListProblemsTool.call(dlg, caller, {
      source: 'team',
      path: 'team.yaml',
    });
    assert.ok(
      listedOut.includes('Resolved But Not Yet Cleared'),
      'list_problems should split resolved history into its own section',
    );
    assert.ok(
      listedOut.includes('active: false'),
      'list_problems YAML block should expose active=false for resolved history',
    );

    const clearOut = await teamMgmtClearProblemsTool.call(dlg, caller, {
      source: 'team',
      path: 'team.yaml',
    });
    assert.ok(
      clearOut.includes('cleared 1 problem(s)'),
      'clear_problems should remove resolved team problems by source/path',
    );
    assert.deepEqual(
      listTeamProblems(),
      [],
      'clearing resolved team problems should leave no team problem residue',
    );
  });

  console.log('team_mgmt problems lifecycle tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`team_mgmt problems lifecycle tests: failed: ${message}`);
  process.exit(1);
});
