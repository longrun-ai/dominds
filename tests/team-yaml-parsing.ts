import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getProblemsSnapshot, removeProblemsByPrefix } from '../main/problems';
import { Team } from '../main/team';

async function writeText(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf-8');
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-team-yaml-'));

  try {
    process.chdir(tmpRoot);

    removeProblemsByPrefix('team/team_yaml_error/');

    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: openai',
        '  model: gpt-4',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    toolsets: [ws_read]',
        '  bob:',
        '    name: 123',
        '    toolsets: ws_read',
        '  charlie: "oops"',
        '',
      ].join('\n'),
    );

    const team = await Team.load();

    assert.ok(team.getMember('alice'), 'alice should be loaded');
    assert.equal(team.getMember('bob'), undefined, 'bob should be omitted due to invalid config');
    assert.equal(
      team.getMember('charlie'),
      undefined,
      'charlie should be omitted due to invalid config',
    );

    const snapshot = getProblemsSnapshot();
    const ids = snapshot.problems.map((p) => p.id).sort();
    assert.ok(ids.includes('team/team_yaml_error/members/bob'), 'problem for bob should exist');
    assert.ok(
      ids.includes('team/team_yaml_error/members/charlie'),
      'problem for charlie should exist',
    );

    const bobProblem = snapshot.problems.find((p) => p.id === 'team/team_yaml_error/members/bob');
    assert.ok(bobProblem && bobProblem.kind === 'team_workspace_config_error');
    assert.ok(bobProblem.detail.errorText.includes('members.bob.name'));
    assert.ok(bobProblem.detail.errorText.includes('members.bob.toolsets'));

    const charlieProblem = snapshot.problems.find(
      (p) => p.id === 'team/team_yaml_error/members/charlie',
    );
    assert.ok(charlieProblem && charlieProblem.kind === 'team_workspace_config_error');
    assert.ok(charlieProblem.detail.errorText.includes('members.charlie'));

    console.log('✅ team-yaml-parsing tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
