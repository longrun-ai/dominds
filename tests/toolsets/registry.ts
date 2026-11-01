import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import yaml from 'yaml';
import { Team } from '../../main/team';
import { type FuncTool, toolSuccess } from '../../main/tool';
import '../../main/tools/builtins';
import {
  getTool,
  getToolset,
  listTools,
  listToolsets,
  registerTool,
  registerToolset,
  unregisterTool,
  unregisterToolset,
} from '../../main/tools/registry';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

function names(tools: readonly { name: string }[]) {
  return tools.map((tool) => tool.name).sort();
}
function requiredSet(name: string) {
  const tools = getToolset(name);
  assert.ok(tools, `required toolset ${name}`);
  return tools;
}
async function main() {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws);
    const loadedToolsets = listToolsets();
    const loadedTools = listTools();
    assert.ok(Object.keys(loadedToolsets).length > 0);
    assert.ok(loadedTools.length > 0);
    for (const id of ['ws_read', 'fs_read', 'personal_memory', 'team_memory', 'skills'])
      assert.ok(Array.isArray(requiredSet(id)));
    assert.equal(getToolset('__registry_unknown__'), undefined);
    assert.equal(getTool('__registry_unknown__'), undefined);
    for (const name of [
      'list_dir',
      'read_file',
      'fs_read_file',
      'read_picture',
      'fs_read_picture',
      'write_picture',
      'add_personal_memory',
      'add_personal_skill',
      'import_personal_skill_from_file',
      'move_personal_skill',
      'readonly_shell',
      'apply_patch',
      'do_mind',
      'mind_more',
      'never_mind',
    ]) {
      const tool = getTool(name);
      assert.ok(tool);
      assert.equal(tool.name, name);
    }
    assert.ok(names(requiredSet('skills')).includes('move_personal_skill'));
    assert.ok(names(requiredSet('fs_read')).includes('fs_read_file'));
    assert.ok(names(requiredSet('fs_read')).includes('fs_ripgrep_search'));
    const controlIds = ['do_mind', 'mind_more', 'change_mind', 'never_mind'];
    for (const id of controlIds) assert.ok(names(requiredSet('control')).includes(id));
    const explicitControl = new Team.Member({
      id: 'control-test',
      name: 'Control',
      toolsets: ['control'],
    });
    assert.equal(
      explicitControl.listResolvedToolsetNames({ onMissing: 'silent' }).includes('control'),
      false,
    );
    assert.equal(
      explicitControl
        .listTools({ onMissingToolset: 'silent' })
        .some((t) => controlIds.includes(t.name)),
      false,
    );
    const wildcard = new Team.Member({ id: 'wildcard-test', name: 'Wildcard', toolsets: ['*'] });
    assert.equal(
      wildcard.listResolvedToolsetNames({ onMissing: 'silent' }).includes('control'),
      false,
    );
    assert.equal(
      wildcard.listResolvedToolsetNames({ onMissing: 'silent' }).includes('fs_read'),
      false,
    );
    assert.equal(
      wildcard.listTools({ onMissingToolset: 'silent' }).some((t) => t.name === 'fs_read_file'),
      false,
    );
    const explicitFs = new Team.Member({
      id: 'fs-read-explicit',
      name: 'FS read',
      toolsets: ['fs_read'],
    });
    assert.ok(explicitFs.listResolvedToolsetNames({ onMissing: 'silent' }).includes('fs_read'));
    assert.ok(names(explicitFs.listTools({ onMissingToolset: 'silent' })).includes('fs_read_file'));
    for (const [set, ids] of [
      ['ws_read', ['read_picture', 'read_symlink']],
      ['ws_mod', ['read_picture', 'write_picture', 'read_symlink', 'create_symlink', 'rm_symlink']],
      ['team_mgmt', ['team_mgmt_read_symlink', 'team_mgmt_create_symlink', 'team_mgmt_rm_symlink']],
    ] as const)
      for (const id of ids) assert.ok(names(requiredSet(set)).includes(id));
    assert.deepEqual(names(requiredSet('codex_inspect_and_patch_tools')), [
      'apply_patch',
      'readonly_shell',
    ]);

    const mixed = new Team.Member({
      id: 'mixed',
      name: 'Mixed',
      toolsets: ['ws_read', 'personal_memory'],
      tools: ['file_append', 'list_dir'],
    });
    const expectedMixed = new Set([
      ...names(requiredSet('ws_read')),
      ...names(requiredSet('personal_memory')),
      'file_append',
      'list_dir',
    ]);
    const mixedNames = names(mixed.listTools());
    assert.deepEqual(mixedNames, [...expectedMixed].sort());
    assert.equal(new Set(mixedNames).size, mixedNames.length);
    const duplicated = new Team.Member({
      id: 'duplicated',
      name: 'Duplicated',
      toolsets: ['ws_read', 'ws_mod'],
      tools: ['list_dir', 'read_file'],
    });
    const expectedDuplicate = new Set([
      ...names(requiredSet('ws_read')),
      ...names(requiredSet('ws_mod')),
      'list_dir',
      'read_file',
    ]);
    const duplicateNames = names(duplicated.listTools());
    assert.deepEqual(duplicateNames, [...expectedDuplicate].sort());
    assert.equal(new Set(duplicateNames).size, duplicateNames.length);

    await fs.writeFile(
      '.minds/team.yaml',
      yaml.stringify({
        member_defaults: { provider: 'local-mock', model: 'default' },
        default_responder: 'gd',
        members: {
          gd: { name: 'GD', toolsets: ['ws_read', 'ws_mod'], tools: ['list_dir', 'read_file'] },
        },
      }),
    );
    const team = await Team.load();
    const gd = team.getMember('gd');
    assert.ok(gd);
    assert.equal(gd.provider, 'local-mock');
    assert.equal(gd.model, 'default');
    const gdNames = names(gd.listTools());
    assert.deepEqual(gdNames, [...expectedDuplicate].sort());
    assert.equal(new Set(gdNames).size, gdNames.length);
    // The registry exposes actual tool handles. JSON serialization cannot compare handlers.
    for (const [id, tools] of Object.entries(listToolsets())) {
      assert.ok(Array.isArray(tools), id);
      for (const tool of tools)
        assert.strictEqual(
          getTool(tool.name),
          tool,
          `${id}/${tool.name} must resolve the registered handle`,
        );
    }
    const dialog = await createMainDialog('gd');
    const calls: Array<{ dialog: string; caller: string; value: unknown }> = [];
    const probe: FuncTool = {
      type: 'func',
      name: '__registry_owned_probe__',
      description: 'Owned handler input-data fixture.',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
      call: async (dlg, caller, args) => {
        calls.push({ dialog: dlg.id.key(), caller: caller.id, value: args.value });
        return toolSuccess(JSON.stringify({ value: args.value }));
      },
    };
    registerTool(probe);
    registerToolset('__registry_owned_set__', [probe]);
    registerToolset('__registry_owned_empty__', []);
    try {
      assert.strictEqual(getTool(probe.name), probe);
      const fromSet = requiredSet('__registry_owned_set__')[0];
      assert.strictEqual(fromSet, probe);
      assert.deepEqual(getToolset('__registry_owned_empty__'), []);
      assert.deepEqual(
        listToolsets()['__registry_owned_empty__'],
        [],
        'empty capability placeholders remain valid registry data',
      );
      assert.ok(fromSet && fromSet.type === 'func');
      const result = await fromSet.call(dialog, gd, { value: 'owned-handler-payload' });
      assert.equal(result.outcome, 'success');
      assert.deepEqual(JSON.parse(result.content) as unknown, { value: 'owned-handler-payload' });
      assert.deepEqual(calls, [
        { dialog: dialog.id.key(), caller: 'gd', value: 'owned-handler-payload' },
      ]);
    } finally {
      unregisterTool(probe.name);
      unregisterToolset('__registry_owned_set__');
      unregisterToolset('__registry_owned_empty__');
    }
    assert.equal(getTool(probe.name), undefined);
    assert.equal(getToolset('__registry_owned_set__'), undefined);
    assert.equal(getToolset('__registry_owned_empty__'), undefined);
  });
  console.log('Registry handlers, selector grants and actual team data: passed');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
