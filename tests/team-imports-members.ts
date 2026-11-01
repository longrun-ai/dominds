import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { getProblemsSnapshot, removeProblemsByPrefix } from '../main/problems';
import { Team } from '../main/team';
import '../main/tools/builtins';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { withTempRtws, writeStandardMinds } from './kernel-driver/helpers';
const evidence = semanticEvidenceCollector('dominds-team-imports-');
async function load(id: string, scenario: string) {
  const team = await Team.load();
  const problems = getProblemsSnapshot().problems.filter(
    (p) => p.kind === 'team_workspace_config_error' && !p.resolved,
  );
  evidence.record({
    id,
    scenario,
    businessValue:
      'Healthy team members remain usable while an agent can identify and repair a malformed member import.',
    context: {
      teamYaml: await fs.readFile('.minds/team.yaml', 'utf8'),
      problems: JSON.stringify(problems),
      scope:
        'Current component import compatibility and local overrides; no host tool invocation or new App destination architecture.',
    },
    reviewQuestions: [
      'Do all actual problem diagnostics accurately explain the supplied declarations and repairable conflicts?',
    ],
    actualText: problems
      .map((p) =>
        JSON.stringify(
          { message: p.message, messageI18n: p.messageI18n, detail: p.detail },
          null,
          2,
        ),
      )
      .join('\n\n'),
  });
  const builder = team.getMember('builder');
  assert.ok(builder);
  assert.equal(builder.provider, 'local-mock');
  assert.equal(builder.model, 'default');
  assert.equal(
    problems.some((p) => p.id.startsWith('team/team_yaml_error/member_defaults/')),
    false,
  );
  return team;
}

async function writeText(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf-8');
}

async function writeLocalAppPackage(params: {
  packageRootAbs: string;
  appId: string;
  teammatesYamlRelPath?: string;
}): Promise<void> {
  await writeText(
    path.join(params.packageRootAbs, 'package.json'),
    JSON.stringify(
      {
        name: params.appId,
        version: '0.0.0',
        bin: 'bin.js',
      },
      null,
      2,
    ),
  );
  const contributesLines =
    params.teammatesYamlRelPath === undefined
      ? []
      : [
          `  contributes: { teammatesYamlRelPath: ${JSON.stringify(params.teammatesYamlRelPath)} },`,
        ];
  await writeText(
    path.join(params.packageRootAbs, 'bin.js'),
    [
      "'use strict';",
      "if (!process.argv.includes('--dominds-app')) throw new Error('expected --dominds-app');",
      'const json = {',
      `  appId: ${JSON.stringify(params.appId)},`,
      '  package: {',
      `    name: ${JSON.stringify(params.appId)},`,
      "    version: '0.0.0',",
      '    rootAbs: process.cwd(),',
      '  },',
      "  host: { kind: 'node_module', moduleRelPath: 'index.js', exportName: 'main' },",
      ...contributesLines,
      '};',
      'process.stdout.write(JSON.stringify(json));',
      '',
    ].join('\n'),
  );
  await writeText(
    path.join(params.packageRootAbs, '.minds', 'app.yaml'),
    ['apiVersion: dominds.io/v1alpha1', 'kind: DomindsApp', `id: ${params.appId}`, ''].join('\n'),
  );
}

function listTeamProblems(): string[] {
  const snapshot = getProblemsSnapshot();
  return snapshot.problems
    .filter((p) => !p.resolved && p.kind === 'team_workspace_config_error')
    .map((p) => p.id)
    .sort();
}

function mustHaveProblemPrefix(prefix: string): void {
  const ids = listTeamProblems();
  assert.ok(
    ids.some((id) => id.startsWith(prefix)),
    `Expected at least one problem with prefix '${prefix}', got: ${ids.join(', ')}`,
  );
}

function mustNotHaveProblemPrefix(prefix: string): void {
  const ids = listTeamProblems();
  assert.ok(
    ids.every((id) => !id.startsWith(prefix)),
    `Expected no problems with prefix '${prefix}', got: ${ids.join(', ')}`,
  );
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);
    // Case 1: use+import conflict should be surfaced without breaking Team.load().
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: local-mock',
        '  model: default',
        'default_responder: builder',
        'members:',
        '  builder:',
        '    name: Builder',
        '    toolsets: []',
        '  scribe:',
        '    name: Scribe',
        '    from: common_agents',
        '    use: scribe',
        '    import: scribe',
        '',
      ].join('\n'),
    );
    const team1 = await load(
      'conflicting-use-import',
      'scribe declares both use and import from common_agents.',
    );
    assert.ok(team1.getMember('builder'), 'team should remain usable');
    mustHaveProblemPrefix('team/team_yaml_error/members/rtws/scribe/use_and_import_conflict');

    // Case 2: use without from should be surfaced.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: local-mock',
        '  model: default',
        'default_responder: builder',
        'members:',
        '  builder:',
        '    name: Builder',
        '    toolsets: []',
        '  librarian:',
        '    name: Librarian',
        '    use: librarian',
        '',
      ].join('\n'),
    );
    await load('use-without-from', 'librarian declares use without from.');
    mustHaveProblemPrefix('team/team_yaml_error/members/rtws/librarian/from/missing');

    // Case 3: invalid types for from/use/import should be surfaced.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: local-mock',
        '  model: default',
        'default_responder: builder',
        'members:',
        '  builder:',
        '    name: Builder',
        '    toolsets: []',
        '  bad_from:',
        '    name: BadFrom',
        '    from: 123',
        '  bad_use:',
        '    name: BadUse',
        '    from: knowledge_base',
        '    use: 123',
        '  bad_import:',
        '    name: BadImport',
        '    from: common_agents',
        '    import: true',
        '',
      ].join('\n'),
    );
    await load(
      'invalid-member-types',
      'bad_from.from is number123; bad_use.use is number123; bad_import.import is boolean true.',
    );
    mustHaveProblemPrefix('team/team_yaml_error/members/rtws/bad_from/from/invalid');
    mustHaveProblemPrefix('team/team_yaml_error/members/rtws/bad_use/use/invalid');
    mustHaveProblemPrefix('team/team_yaml_error/members/rtws/bad_import/import/invalid');

    // Case 4: current compatibility: from-only remains a local definition without import problems.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: local-mock',
        '  model: default',
        'default_responder: builder',
        'members:',
        '  builder:',
        '    name: Builder',
        '    toolsets: []',
        '  librarian:',
        '    name: Librarian',
        '    from: knowledge_base',
        '',
      ].join('\n'),
    );
    const team4 = await Team.load();
    assert.ok(team4.getMember('builder'));
    const local = team4.getMember('librarian');
    assert.ok(local);
    assert.equal(local.name, 'Librarian');
    assert.equal(local.provider, 'local-mock');
    assert.equal(local.model, 'default');
    mustNotHaveProblemPrefix('team/team_yaml_error/members/rtws/librarian/');

    // Case 5: current compatibility: from+use imports a teammate from a component package,
    // with local overrides winning.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'app.yaml'),
      [
        'apiVersion: dominds.io/v1alpha1',
        'kind: DomindsApp',
        'id: rtws_root',
        'dependencies:',
        '  - id: common_agents',
        '',
      ].join('\n'),
    );
    const commonAgentsRoot = path.join(tmpRoot, 'dominds-apps', 'common_agents');
    await writeLocalAppPackage({
      packageRootAbs: commonAgentsRoot,
      appId: 'common_agents',
      teammatesYamlRelPath: 'team.yaml',
    });
    await writeText(
      path.join(tmpRoot, '.apps', 'override', 'common_agents', 'team.yaml'),
      [
        'members:',
        '  scribe:',
        '    name: ScribeFromApp',
        '    gofor:',
        '      - from app',
        '    toolsets: [repo_tools]',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: local-mock',
        '  model: default',
        'default_responder: builder',
        'members:',
        '  builder:',
        '    name: Builder',
        '    toolsets: []',
        '  local_scribe:',
        '    from: common_agents',
        '    use: scribe',
        '    name: LocalNameOverride',
        '',
      ].join('\n'),
    );
    const team5 = await Team.load();
    const localScribe = team5.getMember('local_scribe');
    assert.ok(localScribe, 'expected local_scribe to be present');
    assert.equal(localScribe.provider, 'local-mock');
    assert.equal(localScribe.model, 'default');
    assert.equal(localScribe.name, 'LocalNameOverride', 'local overrides should win');
    assert.deepEqual(localScribe.gofor, ['from app']);
    assert.deepEqual(localScribe.toolsets, ['repo_tools']);
  });
  await evidence.write();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
