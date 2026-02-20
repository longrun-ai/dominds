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

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-team-file-ext-'));

  try {
    process.chdir(tmpRoot);

    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: codex',
        '  model: gpt-5.2',
        '  read_file_ext_names: [md]',
        '  write_file_ext_names: [md]',
        '  no_read_file_ext_names: [secret]',
        '  no_write_file_ext_names: [tmp]',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    read_file_ext_names: [md, ts]',
        '    no_write_file_ext_names: [tmp, bak]',
        '  bob:',
        '    name: Bob',
        '',
      ].join('\n'),
    );

    const team = await Team.load();

    assert.deepEqual(team.memberDefaults.read_file_ext_names, ['md']);
    assert.deepEqual(team.memberDefaults.write_file_ext_names, ['md']);
    assert.deepEqual(team.memberDefaults.no_read_file_ext_names, ['secret']);
    assert.deepEqual(team.memberDefaults.no_write_file_ext_names, ['tmp']);

    assert.deepEqual(team.getMember('alice')?.read_file_ext_names, ['md', 'ts']);
    assert.deepEqual(team.getMember('alice')?.write_file_ext_names, ['md']);
    assert.deepEqual(team.getMember('alice')?.no_read_file_ext_names, ['secret']);
    assert.deepEqual(team.getMember('alice')?.no_write_file_ext_names, ['tmp', 'bak']);

    assert.deepEqual(team.getMember('bob')?.read_file_ext_names, ['md']);
    assert.deepEqual(team.getMember('bob')?.write_file_ext_names, ['md']);
    assert.deepEqual(team.getMember('bob')?.no_read_file_ext_names, ['secret']);
    assert.deepEqual(team.getMember('bob')?.no_write_file_ext_names, ['tmp']);

    assert.ok(
      getProblemsSnapshot().problems.every((p) => !p.id.startsWith('team/team_yaml_error/')),
      'no team yaml errors expected for valid file-extension fields',
    );

    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: codex',
        '  model: gpt-5.2',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    read_file_ext_names: md',
        '',
      ].join('\n'),
    );

    const teamInvalid = await Team.load();
    assert.equal(teamInvalid.getMember('alice'), undefined);
    assert.ok(
      getProblemsSnapshot().problems.some((p) => p.id === 'team/team_yaml_error/members/alice'),
      'invalid read_file_ext_names type should surface a member-level team yaml error',
    );

    console.log('team file extension permission tests: ok');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
