import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DialogStore } from '../main/dialog';
import { MainDialog } from '../main/dialog';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import {
  teamMgmtApplyOccurrenceReplaceTool,
  teamMgmtPrepareOccurrenceReplaceTool,
  teamMgmtTools,
} from '../main/tools/team_mgmt';
import { padWriteTool } from '../main/tools/txt';

function extractPlanId(output: string): string {
  const match = output.match(/plan_id: '([^']+)'/);
  assert.ok(match, `missing plan_id in output:\n${output}`);
  return match[1] ?? '';
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-team_mgmt-occurrence-'));
  try {
    process.chdir(tmpRoot);
    setWorkLanguage('en');

    await fs.mkdir(path.join(tmpRoot, '.minds'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      'old_name: alpha\nold_name: beta\nold_name: gamma\n',
      'utf8',
    );

    const dlg = new MainDialog(
      {} as unknown as DialogStore,
      'team-mgmt-occurrence.tsk',
      undefined,
      'tester',
    );
    const alice = new Team.Member({
      id: 'alice',
      name: 'Alice',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    const toolNames = new Set(teamMgmtTools.map((tool) => tool.name));
    assert.ok(toolNames.has('team_mgmt_prepare_occurrence_replace'));
    assert.ok(toolNames.has('team_mgmt_apply_occurrence_replace'));

    const replacement = 'new_name';
    const prepare = (
      await teamMgmtPrepareOccurrenceReplaceTool.call(dlg, alice, {
        path: 'team.yaml',
        find: 'old_name',
        content: replacement,
      })
    ).content;
    assert.ok(prepare.includes('mode: prepare_occurrence_replace'));
    assert.ok(prepare.includes("path: '.minds/team.yaml'"));
    assert.ok(prepare.includes('selected_count: 3'));
    assert.ok(!prepare.includes(replacement), 'prepare should not echo replacement by default');
    assert.equal(
      await fs.readFile(path.join(tmpRoot, '.minds', 'team.yaml'), 'utf8'),
      'old_name: alpha\nold_name: beta\nold_name: gamma\n',
      'prepare must not write',
    );

    const apply = (
      await teamMgmtApplyOccurrenceReplaceTool.call(dlg, alice, {
        plan_id: extractPlanId(prepare),
      })
    ).content;
    assert.ok(apply.includes('mode: apply_occurrence_replace'));
    assert.ok(apply.includes("path: '.minds/team.yaml'"));
    assert.ok(!apply.includes(replacement), 'apply should not echo replacement by default');
    assert.equal(
      await fs.readFile(path.join(tmpRoot, '.minds', 'team.yaml'), 'utf8'),
      `${replacement}: alpha\n${replacement}: beta\n${replacement}: gamma\n`,
    );

    const singleSelectionPrepare = (
      await teamMgmtPrepareOccurrenceReplaceTool.call(dlg, alice, {
        path: 'team.yaml',
        find: replacement,
        content: 'single',
        occurrence_indexes: [2],
      })
    ).content;
    assert.ok(singleSelectionPrepare.includes('status: ok'));
    assert.ok(singleSelectionPrepare.includes('selected_count: 1'));
    assert.ok(singleSelectionPrepare.includes('notice: NOT_MULTI_OCCURRENCE'));
    const singleSelectionApply = (
      await teamMgmtApplyOccurrenceReplaceTool.call(dlg, alice, {
        plan_id: extractPlanId(singleSelectionPrepare),
      })
    ).content;
    assert.ok(singleSelectionApply.includes('mode: apply_occurrence_replace'));
    assert.equal(
      await fs.readFile(path.join(tmpRoot, '.minds', 'team.yaml'), 'utf8'),
      `${replacement}: alpha\nsingle: beta\n${replacement}: gamma\n`,
    );

    await fs.writeFile(path.join(tmpRoot, '.minds', 'pad-target.md'), 'red\nred\nred\n', 'utf8');
    const padReplacement = 'BLUE_TEAM_PAD';
    const padWrite = (
      await padWriteTool.call(dlg, alice, {
        pad_id: 'team_occurrence_src',
        content: padReplacement,
      })
    ).content;
    assert.ok(!padWrite.includes(padReplacement), 'pad_write should not echo pad body');
    const preparePad = (
      await teamMgmtPrepareOccurrenceReplaceTool.call(dlg, alice, {
        path: 'pad-target.md',
        find: 'red\n',
        pad_id: 'team_occurrence_src',
        occurrence_indexes: [1, 3],
      })
    ).content;
    assert.ok(preparePad.includes('source: pad'));
    assert.ok(!preparePad.includes(padReplacement), 'pad prepare must not echo pad body');
    const applyPad = (
      await teamMgmtApplyOccurrenceReplaceTool.call(dlg, alice, {
        plan_id: extractPlanId(preparePad),
      })
    ).content;
    assert.ok(!applyPad.includes(padReplacement), 'pad apply must not echo pad body');
    assert.equal(
      await fs.readFile(path.join(tmpRoot, '.minds', 'pad-target.md'), 'utf8'),
      `${padReplacement}\nred\n${padReplacement}\n`,
    );

    console.log('✅ team_mgmt occurrence replace tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
