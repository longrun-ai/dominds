import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { registerEnabledAppsToolProxies } from '../main/apps/runtime';
import type { Dialog } from '../main/dialog';
import { getProblemsSnapshot, removeProblemsByPrefix } from '../main/problems';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import '../main/tools/builtins';
import { teamMgmtOverwriteEntireFileTool } from '../main/tools/team_mgmt';

const APPS_PROBLEM_PREFIX = 'apps/apps_resolution/';
const TEAM_PROBLEM_PREFIX = 'team/team_yaml_error/';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

function countLogicalLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts.length;
}

async function readFileState(filePathAbs: string): Promise<{ lines: number; bytes: number }> {
  const content = await fs.readFile(filePathAbs, 'utf-8');
  const stat = await fs.stat(filePathAbs);
  return {
    lines: countLogicalLines(content),
    bytes: stat.size,
  };
}

function listActiveProblemIds(prefix: string): string[] {
  return getProblemsSnapshot()
    .problems.filter((problem) => problem.id.startsWith(prefix) && problem.resolved !== true)
    .map((problem) => problem.id)
    .sort();
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-team_mgmt-derived-problems-'));

  try {
    process.chdir(tmpRoot);
    setWorkLanguage('en');
    removeProblemsByPrefix(APPS_PROBLEM_PREFIX);
    removeProblemsByPrefix(TEAM_PROBLEM_PREFIX);

    const dlg = {} as unknown as Dialog;
    const alice = new Team.Member({
      id: 'alice',
      name: 'Alice',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    const invalidAppYaml = [
      'apiVersion: dominds.io/v1alpha1',
      'kind: DomindsApp',
      'id: rtws_root',
      'dependencies:',
      '  - id: missing_required_app',
      '',
    ].join('\n');
    const validAppYaml = [
      'apiVersion: dominds.io/v1alpha1',
      'kind: DomindsApp',
      'id: rtws_root',
      '',
    ].join('\n');
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

    await writeText(
      path.join(tmpRoot, '.minds', 'llm.yaml'),
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
    await writeText(path.join(tmpRoot, '.minds', 'app.yaml'), invalidAppYaml);
    await writeText(path.join(tmpRoot, '.minds', 'team.yaml'), invalidTeamYaml);

    await registerEnabledAppsToolProxies({ rtwsRootAbs: tmpRoot });
    await Team.load();

    assert.ok(
      !listActiveProblemIds(TEAM_PROBLEM_PREFIX).includes(
        'team/team_yaml_error/members/fuxi/toolsets/team_mgmt/missing',
      ),
      'test bootstrap must register built-in toolsets so shadow-member team_mgmt does not appear as noise',
    );

    assert.ok(
      listActiveProblemIds(APPS_PROBLEM_PREFIX).length > 0,
      'expected active apps resolution problems before fixing app.yaml',
    );
    assert.ok(
      listActiveProblemIds(TEAM_PROBLEM_PREFIX).length > 0,
      'expected active team yaml problems before fixing team.yaml',
    );

    const appFileAbs = path.join(tmpRoot, '.minds', 'app.yaml');
    const appState = await readFileState(appFileAbs);
    const overwriteAppResult = (
      await teamMgmtOverwriteEntireFileTool.call(dlg, alice, {
        path: 'app.yaml',
        known_old_total_lines: appState.lines,
        known_old_total_bytes: appState.bytes,
        content: validAppYaml,
      })
    ).content;
    assert.ok(overwriteAppResult.includes('status: ok'));
    assert.ok(overwriteAppResult.includes('mode: overwrite_entire_file'));
    assert.deepEqual(
      listActiveProblemIds(APPS_PROBLEM_PREFIX),
      [],
      'team_mgmt overwrite should clear active apps resolution problems after fixing app.yaml',
    );
    assert.ok(
      listActiveProblemIds(TEAM_PROBLEM_PREFIX).length > 0,
      'fixing app.yaml should not mask still-active team yaml problems',
    );

    const teamFileAbs = path.join(tmpRoot, '.minds', 'team.yaml');
    const teamState = await readFileState(teamFileAbs);
    const overwriteTeamResult = (
      await teamMgmtOverwriteEntireFileTool.call(dlg, alice, {
        path: 'team.yaml',
        known_old_total_lines: teamState.lines,
        known_old_total_bytes: teamState.bytes,
        content: validTeamYaml,
      })
    ).content;
    assert.ok(overwriteTeamResult.includes('status: ok'));
    assert.ok(overwriteTeamResult.includes('mode: overwrite_entire_file'));
    assert.deepEqual(
      listActiveProblemIds(TEAM_PROBLEM_PREFIX),
      [],
      'team_mgmt overwrite should clear active team yaml problems after fixing team.yaml',
    );

    console.log('✅ team_mgmt-derived-problems-refresh tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
    removeProblemsByPrefix(APPS_PROBLEM_PREFIX);
    removeProblemsByPrefix(TEAM_PROBLEM_PREFIX);
  }
}

void main();
