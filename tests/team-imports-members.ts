import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getProblemsSnapshot, removeProblemsByPrefix } from '../main/problems';
import { Team } from '../main/team';
import '../main/tools/builtins';

async function writeText(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf-8');
}

function listTeamProblems(): string[] {
  const snapshot = getProblemsSnapshot();
  return snapshot.problems
    .filter((p) => p.kind === 'team_workspace_config_error')
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
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-team-imports-members-'));

  try {
    process.chdir(tmpRoot);

    // Case 1: use+import conflict should be surfaced (fail-open).
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: openai',
        '  model: gpt-4',
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
    const team1 = await Team.load();
    assert.ok(team1.getMember('builder'), 'team should remain usable');
    mustHaveProblemPrefix('team/team_yaml_error/members/rtws/scribe/use_and_import_conflict');

    // Case 2: use without from should be surfaced.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: openai',
        '  model: gpt-4',
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
    await Team.load();
    mustHaveProblemPrefix('team/team_yaml_error/members/rtws/librarian/from/missing');

    // Case 3: invalid types for from/use/import should be surfaced.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: openai',
        '  model: gpt-4',
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
    await Team.load();
    mustHaveProblemPrefix('team/team_yaml_error/members/rtws/bad_from/from/invalid');
    mustHaveProblemPrefix('team/team_yaml_error/members/rtws/bad_use/use/invalid');
    mustHaveProblemPrefix('team/team_yaml_error/members/rtws/bad_import/import/invalid');

    // Case 4: from-only should be accepted as a default (no from_app Problems in v0).
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: openai',
        '  model: gpt-4',
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
    await Team.load();
    mustNotHaveProblemPrefix('team/team_yaml_error/members/rtws/librarian/');

    // Case 5: from+use should import config from enabled app teammates YAML (with local overrides winning).
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.apps', 'resolution.yaml'),
      [
        'schemaVersion: 1',
        'apps:',
        '  - id: common_agents',
        '    enabled: true',
        '    source:',
        '      kind: local',
        `      pathAbs: ${JSON.stringify(path.join(tmpRoot, 'app-common-agents'))}`,
        '    assignedPort: null',
        '    installJson:',
        '      schemaVersion: 1',
        '      appId: common_agents',
        '      package:',
        '        name: app-common-agents',
        '        version: null',
        `        rootAbs: ${JSON.stringify(path.join(tmpRoot, 'app-common-agents'))}`,
        '      host:',
        '        kind: node_module',
        '        moduleRelPath: index.js',
        '        exportName: main',
        '      contributes:',
        '        teammatesYamlRelPath: team.yaml',
        '',
      ].join('\n'),
    );
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
      path.join(tmpRoot, 'app-common-agents', '.minds', 'app.yaml'),
      [
        'apiVersion: dominds.io/v1alpha1',
        'kind: DomindsApp',
        'id: common_agents',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: openai',
        '  model: gpt-4',
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
    assert.equal(localScribe.name, 'LocalNameOverride', 'local overrides should win');
    assert.deepEqual(localScribe.gofor, ['from app']);
    assert.deepEqual(localScribe.toolsets, ['repo_tools']);
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
