import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { registerEnabledAppsToolProxies } from '../main/apps/runtime';
import { getProblemsSnapshot, removeProblemsByPrefix } from '../main/problems';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import '../main/tools/builtins';
import { teamMgmtOverwriteEntireFileTool } from '../main/tools/team_mgmt';

import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { toolOutputData } from './helpers/tool-output';
import { createMainDialog, withTempRtws, writeStandardMinds } from './kernel-driver/helpers';
const evidence = semanticEvidenceCollector('dominds-derived-problems-');
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
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);
    setWorkLanguage('en');
    removeProblemsByPrefix(APPS_PROBLEM_PREFIX);
    removeProblemsByPrefix(TEAM_PROBLEM_PREFIX);

    const dlg = await createMainDialog();
    dlg.setLastUserLanguageCode('en');
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

    const appId = 'apps/apps_resolution/required_dependency_missing/missing_required_app';
    const teamId = 'team/team_yaml_error/members/tester/name/invalid_ignored';
    const before = getProblemsSnapshot().problems;
    const appProblem = before.find((p) => p.id === appId);
    const teamProblem = before.find((p) => p.id === teamId);
    assert.ok(appProblem && !appProblem.resolved);
    assert.ok(teamProblem && !teamProblem.resolved, JSON.stringify(before));
    assert.equal(appProblem.kind, 'generic_problem');
    assert.equal(appProblem.source, 'system');
    assert.equal(teamProblem.kind, 'team_workspace_config_error');
    assert.equal(teamProblem.source, 'team');

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
    assert.equal(toolOutputData(overwriteAppResult).status, 'ok');
    assert.equal(toolOutputData(overwriteAppResult).mode, 'overwrite_entire_file');
    assert.equal(await fs.readFile(appFileAbs, 'utf8'), validAppYaml);
    const afterApp = getProblemsSnapshot().problems;
    const resolvedApp = afterApp.find((p) => p.id === appId);
    assert.ok(resolvedApp?.resolved && resolvedApp.resolvedAt);
    assert.deepEqual(
      { ...resolvedApp, resolved: appProblem.resolved, resolvedAt: appProblem.resolvedAt },
      appProblem,
    );
    assert.deepEqual(
      afterApp.find((p) => p.id === teamId),
      teamProblem,
    );
    evidence.record({
      id: 'app-repair-receipt',
      scenario:
        'The scoped write repairs a missing component dependency while tester.name remains invalid.',
      businessValue:
        'A successful configuration edit must refresh its derived Problems without masking an unrelated team error.',
      context: {
        before: JSON.stringify(before),
        after: JSON.stringify(afterApp),
        file: validAppYaml,
      },
      reviewQuestions: [
        'Is the actual write receipt consistent with the file written and the bounded scope of the operation?',
      ],
      actualText: overwriteAppResult,
    });
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
    assert.equal(toolOutputData(overwriteTeamResult).status, 'ok');
    assert.equal(toolOutputData(overwriteTeamResult).mode, 'overwrite_entire_file');
    assert.equal(await fs.readFile(teamFileAbs, 'utf8'), validTeamYaml);
    const afterTeam = getProblemsSnapshot().problems;
    const resolvedTeam = afterTeam.find((p) => p.id === teamId);
    assert.ok(resolvedTeam?.resolved && resolvedTeam.resolvedAt);
    assert.deepEqual(
      { ...resolvedTeam, resolved: teamProblem.resolved, resolvedAt: teamProblem.resolvedAt },
      teamProblem,
    );
    assert.deepEqual(
      afterTeam.find((p) => p.id === appId),
      resolvedApp,
    );
    evidence.record({
      id: 'team-repair-receipt',
      scenario: 'The scoped write now repairs tester.name and resolves that same Problems record.',
      businessValue:
        'An executing agent can continue from the actual accepted configuration write.',
      context: {
        before: JSON.stringify(afterApp),
        after: JSON.stringify(afterTeam),
        file: validTeamYaml,
      },
      reviewQuestions: [
        'Does the complete receipt describe the actual write without overclaiming validation or other execution?',
      ],
      actualText: overwriteTeamResult,
    });
    assert.deepEqual(
      listActiveProblemIds(TEAM_PROBLEM_PREFIX),
      [],
      'team_mgmt overwrite should clear active team yaml problems after fixing team.yaml',
    );

    console.log('✅ team_mgmt-derived-problems-refresh tests passed');
  });
  await evidence.write();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
