import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
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

import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { toolOutputData } from './helpers/tool-output';
import { createMainDialog, withTempRtws, writeStandardMinds } from './kernel-driver/helpers';
const evidence = semanticEvidenceCollector('dominds-team-path-boundary-');

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

  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws);
    const caller = new Team.Member({
      id: 'tester',
      name: 'Tester',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      const dlg = await createMainDialog();
      dlg.setLastUserLanguageCode(language);
      const seed = 'alpha\nanchor\nBEGIN\nold\nEND\nomega\n';
      const cases: ReadonlyArray<{
        tool: FuncTool;
        args: ToolArguments;
        expected: string;
        creates?: boolean;
        prepares?: boolean;
      }> = [
        {
          tool: teamMgmtCreateNewFileTool,
          args: { content: 'x\n' },
          expected: 'x\n',
          creates: true,
        },
        {
          tool: teamMgmtOverwriteEntireFileTool,
          args: {
            known_old_total_lines: 6,
            known_old_total_bytes: Buffer.byteLength(seed),
            content: 'x\n',
          },
          expected: 'x\n',
        },
        {
          tool: teamMgmtFileRangeEditTool,
          args: { range: '1~1', content: 'x\n' },
          expected: 'x\nanchor\nBEGIN\nold\nEND\nomega\n',
        },
        { tool: teamMgmtFileAppendTool, args: { content: 'x\n' }, expected: seed + 'x\n' },
        {
          tool: teamMgmtFileInsertAfterTool,
          args: { anchor: 'anchor', content: 'x\n' },
          expected: 'alpha\nanchor\nx\nBEGIN\nold\nEND\nomega\n',
        },
        {
          tool: teamMgmtFileInsertBeforeTool,
          args: { anchor: 'anchor', content: 'x\n' },
          expected: 'alpha\nx\nanchor\nBEGIN\nold\nEND\nomega\n',
        },
        {
          tool: teamMgmtFileBlockReplaceTool,
          args: { start_anchor: 'BEGIN', end_anchor: 'END', content: 'x\n' },
          expected: 'alpha\nanchor\nBEGIN\nx\nEND\nomega\n',
        },
        {
          tool: teamMgmtPrepareOccurrenceReplaceTool,
          args: { find: 'old', content: 'new' },
          expected: seed,
          prepares: true,
        },
      ];
      for (const [index, testCase] of cases.entries()) {
        const file = `boundary-${language}-${index}.txt`;
        if (!testCase.creates) await fs.writeFile(file, seed);
        const escapedArgs = { ...testCase.args, path: '../' + file };
        const denied = await testCase.tool.call(dlg, caller, escapedArgs);
        assert.equal(denied.outcome, 'failure');
        if (testCase.creates) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
        else
          assert.equal(
            await fs.readFile(file, 'utf8'),
            seed,
            'the existing external file remains byte-for-byte intact',
          );
        const legalArgs = { ...testCase.args, path: file };
        if (!testCase.creates) await fs.writeFile('.minds/' + file, seed);
        const accepted = await testCase.tool.call(dlg, caller, legalArgs);
        assert.equal(accepted.outcome, 'success');
        assert.equal(await fs.readFile('.minds/' + file, 'utf8'), testCase.expected);
        if (testCase.prepares) {
          const planId = toolOutputData(accepted.content).plan_id;
          assert.ok(typeof planId === 'string' && planId.length > 0);
          const applied = await teamMgmtApplyOccurrenceReplaceTool.call(dlg, caller, {
            plan_id: planId,
          });
          assert.equal(applied.outcome, 'success');
          assert.equal(
            await fs.readFile('.minds/' + file, 'utf8'),
            'alpha\nanchor\nBEGIN\nnew\nEND\nomega\n',
          );
        }
        if (!testCase.creates) assert.equal(await fs.readFile(file, 'utf8'), seed);
        evidence.record({
          id: testCase.tool.name + '-' + language,
          scenario:
            'A scoped configuration-edit call attempts to escape .minds; the same supplied arguments succeed for a legal configuration path.',
          businessValue:
            'Protect existing workspace data while giving an executing agent a usable explanation of the configuration-edit boundary.',
          context: {
            language,
            rejectedArgs: JSON.stringify(escapedArgs),
            acceptedArgs: JSON.stringify(legalArgs),
            externalBefore: testCase.creates ? 'ABSENT' : seed,
            externalAfter: testCase.creates ? 'ABSENT' : await fs.readFile(file, 'utf8'),
            scope:
              'Actual file effects and parameter-name/required-field compatibility; not complete behavior equivalence of ws_mod and team_mgmt.',
          },
          reviewQuestions: [
            'Does the complete rejection identify the configuration path boundary and help the agent select a valid path?',
          ],
          actualText: denied.content,
        });
      }
    }
    assert.deepEqual(schemaProperties(teamMgmtApplyOccurrenceReplaceTool), [
      'plan_id',
      'show_diff',
    ]);
  });
  await evidence.write();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
