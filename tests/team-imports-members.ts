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
    mustHaveProblemPrefix(
      'team/team_yaml_error/members/scribe/from_app/common_agents/scribe/use_and_import_conflict',
    );

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
    mustHaveProblemPrefix(
      'team/team_yaml_error/members/librarian/from_app/_unknown_from_app_/librarian/missing',
    );

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
    mustHaveProblemPrefix(
      'team/team_yaml_error/members/bad_from/from_app/_unknown_from_app_/bad_from/invalid',
    );
    mustHaveProblemPrefix(
      'team/team_yaml_error/members/bad_use/from_app/knowledge_base/_unknown_from_member_/use_invalid',
    );
    mustHaveProblemPrefix(
      'team/team_yaml_error/members/bad_import/from_app/common_agents/_unknown_from_member_/import_invalid',
    );

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
    mustNotHaveProblemPrefix('team/team_yaml_error/members/librarian/from_app/');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
