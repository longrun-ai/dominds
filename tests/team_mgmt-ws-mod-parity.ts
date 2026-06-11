import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DialogStore } from '../main/dialog';
import { MainDialog } from '../main/dialog';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import type { FuncTool, ToolArguments } from '../main/tool';
import '../main/tools/builtins';
import { getToolset } from '../main/tools/registry';
import {
  teamMgmtApplyOccurrenceReplaceTool,
  teamMgmtCreateNewFileTool,
  teamMgmtFileAppendTool,
  teamMgmtFileBlockReplaceTool,
  teamMgmtFileInsertAfterTool,
  teamMgmtFileInsertBeforeTool,
  teamMgmtFileRangeEditTool,
  teamMgmtOverwriteEntireFileTool,
  teamMgmtPrepareOccurrenceReplaceTool,
  teamMgmtTools,
} from '../main/tools/team_mgmt';

type MirrorSpec = Readonly<{
  ws: string;
  team: string;
  supportsSource: boolean;
}>;

const mirroredTextEditTools: readonly MirrorSpec[] = [
  { ws: 'create_new_file', team: 'team_mgmt_create_new_file', supportsSource: true },
  {
    ws: 'overwrite_entire_file',
    team: 'team_mgmt_overwrite_entire_file',
    supportsSource: true,
  },
  { ws: 'file_range_edit', team: 'team_mgmt_file_range_edit', supportsSource: true },
  { ws: 'file_append', team: 'team_mgmt_file_append', supportsSource: true },
  { ws: 'file_insert_after', team: 'team_mgmt_file_insert_after', supportsSource: true },
  { ws: 'file_insert_before', team: 'team_mgmt_file_insert_before', supportsSource: true },
  { ws: 'file_block_replace', team: 'team_mgmt_file_block_replace', supportsSource: true },
  {
    ws: 'prepare_occurrence_replace',
    team: 'team_mgmt_prepare_occurrence_replace',
    supportsSource: true,
  },
  {
    ws: 'apply_occurrence_replace',
    team: 'team_mgmt_apply_occurrence_replace',
    supportsSource: false,
  },
];

const removedSingleBlockPrepareTools = [
  'prepare_file_range_edit',
  'prepare_file_append',
  'prepare_file_insert_after',
  'prepare_file_insert_before',
  'prepare_file_block_replace',
] as const;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function schemaProperties(tool: FuncTool): readonly string[] {
  const schema = asRecord(tool.parameters, `${tool.name}.parameters`);
  const propertiesUnknown = schema['properties'];
  const properties =
    propertiesUnknown === undefined
      ? {}
      : asRecord(propertiesUnknown, `${tool.name}.parameters.properties`);
  return Object.keys(properties).sort();
}

function schemaRequired(tool: FuncTool): readonly string[] {
  const schema = asRecord(tool.parameters, `${tool.name}.parameters`);
  const requiredUnknown = schema['required'];
  if (requiredUnknown === undefined) return [];
  if (!Array.isArray(requiredUnknown)) {
    throw new Error(`${tool.name}.parameters.required must be an array when present`);
  }
  for (const item of requiredUnknown) {
    if (typeof item !== 'string') {
      throw new Error(`${tool.name}.parameters.required must contain strings only`);
    }
  }
  return [...requiredUnknown].sort();
}

function getRequiredTool(tools: ReadonlyMap<string, FuncTool>, name: string): FuncTool {
  const tool = tools.get(name);
  assert.ok(tool, `expected tool ${name}`);
  return tool;
}

function assertIncludesAll(actual: readonly string[], expected: readonly string[], label: string) {
  for (const item of expected) {
    assert.ok(actual.includes(item), `${label} should include ${item}`);
  }
}

async function assertTeamMgmtPathEscapeRejected(params: {
  dlg: MainDialog;
  caller: Team.Member;
  tool: FuncTool;
  args: ToolArguments;
  tmpRoot: string;
}) {
  const output = (await params.tool.call(params.dlg, params.caller, params.args)).content;
  assert.ok(
    output.includes('Path must be within .minds/'),
    `${params.tool.name} should reject path traversal, got:\n${output}`,
  );
  await assert.rejects(
    async () => await fs.stat(path.join(params.tmpRoot, 'escape.txt')),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT',
    `${params.tool.name} must not create or modify an escaped file`,
  );
}

async function main(): Promise<void> {
  setWorkLanguage('en');

  const wsModTools = new Map((getToolset('ws_mod') ?? []).map((tool) => [tool.name, tool]));
  const teamMgmtToolMap = new Map(teamMgmtTools.map((tool) => [tool.name, tool]));

  for (const spec of mirroredTextEditTools) {
    const wsTool = getRequiredTool(wsModTools, spec.ws);
    const teamTool = getRequiredTool(teamMgmtToolMap, spec.team);
    assert.deepEqual(
      schemaProperties(teamTool),
      schemaProperties(wsTool),
      `${spec.team} parameter names should mirror ${spec.ws}`,
    );
    assert.deepEqual(
      schemaRequired(teamTool),
      schemaRequired(wsTool),
      `${spec.team} required parameters should mirror ${spec.ws}`,
    );

    if (spec.supportsSource) {
      assertIncludesAll(schemaProperties(wsTool), ['content', 'pad_id', 'pad_range'], spec.ws);
      assertIncludesAll(schemaProperties(teamTool), ['content', 'pad_id', 'pad_range'], spec.team);
    }
  }

  const wsNames = new Set(wsModTools.keys());
  const teamNames = new Set(teamMgmtToolMap.keys());
  for (const oldName of removedSingleBlockPrepareTools) {
    assert.ok(!wsNames.has(oldName), `ws_mod must not expose obsolete ${oldName}`);
    assert.ok(
      !teamNames.has(`team_mgmt_${oldName}`),
      `team_mgmt must not expose obsolete team_mgmt_${oldName}`,
    );
  }
  assert.ok(wsNames.has('prepare_occurrence_replace'));
  assert.ok(wsNames.has('apply_occurrence_replace'));
  assert.ok(teamNames.has('team_mgmt_prepare_occurrence_replace'));
  assert.ok(teamNames.has('team_mgmt_apply_occurrence_replace'));

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-team-mgmt-parity-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(tmpRoot);
    const dlg = new MainDialog(
      {} as unknown as DialogStore,
      'team-mgmt-parity.tsk',
      undefined,
      'tester',
    );
    const caller = new Team.Member({
      id: 'tester',
      name: 'Tester',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });
    const pathEscapeCases: ReadonlyArray<Readonly<{ tool: FuncTool; args: ToolArguments }>> = [
      { tool: teamMgmtCreateNewFileTool, args: { path: '../escape.txt', content: 'x\n' } },
      {
        tool: teamMgmtOverwriteEntireFileTool,
        args: {
          path: '../escape.txt',
          known_old_total_lines: 0,
          known_old_total_bytes: 0,
          content: 'x\n',
        },
      },
      {
        tool: teamMgmtFileRangeEditTool,
        args: { path: '../escape.txt', range: '1~1', content: 'x\n' },
      },
      { tool: teamMgmtFileAppendTool, args: { path: '../escape.txt', content: 'x\n' } },
      {
        tool: teamMgmtFileInsertAfterTool,
        args: { path: '../escape.txt', anchor: 'anchor', content: 'x\n' },
      },
      {
        tool: teamMgmtFileInsertBeforeTool,
        args: { path: '../escape.txt', anchor: 'anchor', content: 'x\n' },
      },
      {
        tool: teamMgmtFileBlockReplaceTool,
        args: {
          path: '../escape.txt',
          start_anchor: 'BEGIN',
          end_anchor: 'END',
          content: 'x\n',
        },
      },
      {
        tool: teamMgmtPrepareOccurrenceReplaceTool,
        args: { path: '../escape.txt', find: 'old', content: 'new' },
      },
    ];
    for (const testCase of pathEscapeCases) {
      await assertTeamMgmtPathEscapeRejected({
        dlg,
        caller,
        tool: testCase.tool,
        args: testCase.args,
        tmpRoot,
      });
    }

    assert.deepEqual(schemaProperties(teamMgmtApplyOccurrenceReplaceTool), [
      'plan_id',
      'show_diff',
    ]);

    console.log('✅ team_mgmt/ws_mod parity tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
