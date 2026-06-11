import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DialogStore } from '../main/dialog';
import { MainDialog } from '../main/dialog';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import '../main/tools/builtins';
import { getToolset } from '../main/tools/registry';
import {
  applyOccurrenceReplaceTool,
  padWriteTool,
  prepareOccurrenceReplaceTool,
} from '../main/tools/txt';

function extractPlanId(output: string): string {
  const match = output.match(/plan_id: '([^']+)'/);
  assert.ok(match, `missing plan_id in output:\n${output}`);
  return match[1] ?? '';
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-occurrence-replace-'));
  try {
    process.chdir(tmpRoot);
    setWorkLanguage('en');

    const dlg = new MainDialog(
      {} as unknown as DialogStore,
      'occurrence-replace.tsk',
      undefined,
      'tester',
    );
    const caller = new Team.Member({
      id: 'tester',
      name: 'Tester',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    const wsModNames = new Set((getToolset('ws_mod') ?? []).map((tool) => tool.name));
    assert.ok(wsModNames.has('prepare_occurrence_replace'));
    assert.ok(wsModNames.has('apply_occurrence_replace'));

    await fs.writeFile(
      path.join(tmpRoot, 'target.txt'),
      'apple one\napple two\napple three\n',
      'utf8',
    );

    const replacement = 'ORANGE_TOKEN';
    const prepareAll = (
      await prepareOccurrenceReplaceTool.call(dlg, caller, {
        path: 'target.txt',
        find: 'apple',
        content: replacement,
      })
    ).content;
    assert.ok(prepareAll.includes('mode: prepare_occurrence_replace'));
    assert.ok(prepareAll.includes('selected_count: 3'));
    assert.ok(!prepareAll.includes(replacement), 'prepare should not echo replacement by default');
    assert.equal(
      await fs.readFile(path.join(tmpRoot, 'target.txt'), 'utf8'),
      'apple one\napple two\napple three\n',
      'prepare must not write the file',
    );

    const applyAll = (
      await applyOccurrenceReplaceTool.call(dlg, caller, {
        plan_id: extractPlanId(prepareAll),
      })
    ).content;
    assert.ok(applyAll.includes('mode: apply_occurrence_replace'));
    assert.ok(!applyAll.includes(replacement), 'apply should not echo replacement by default');
    assert.equal(
      await fs.readFile(path.join(tmpRoot, 'target.txt'), 'utf8'),
      `${replacement} one\n${replacement} two\n${replacement} three\n`,
    );

    const singleSelection = (
      await prepareOccurrenceReplaceTool.call(dlg, caller, {
        path: 'target.txt',
        find: replacement,
        content: 'single',
        occurrence_indexes: [2],
      })
    ).content;
    assert.ok(singleSelection.includes('error: NOT_MULTI_OCCURRENCE'));

    await fs.writeFile(path.join(tmpRoot, 'pad-target.txt'), 'red\nred\nred\n', 'utf8');
    const padReplacement = 'BLUE_PAD_TOKEN';
    const padWrite = (
      await padWriteTool.call(dlg, caller, {
        pad_id: 'replace_src',
        content: padReplacement,
      })
    ).content;
    assert.ok(!padWrite.includes(padReplacement), 'pad_write should not echo pad body');
    const preparePad = (
      await prepareOccurrenceReplaceTool.call(dlg, caller, {
        path: 'pad-target.txt',
        find: 'red\n',
        pad_id: 'replace_src',
        occurrence_indexes: [1, 3],
      })
    ).content;
    assert.ok(preparePad.includes('source: pad'));
    assert.ok(preparePad.includes('selected_occurrences: [1, 3]'));
    assert.ok(!preparePad.includes(padReplacement), 'pad prepare must not echo pad body');
    const applyPad = (
      await applyOccurrenceReplaceTool.call(dlg, caller, {
        plan_id: extractPlanId(preparePad),
      })
    ).content;
    assert.ok(!applyPad.includes(padReplacement), 'pad apply must not echo pad body');
    assert.equal(
      await fs.readFile(path.join(tmpRoot, 'pad-target.txt'), 'utf8'),
      `${padReplacement}\nred\n${padReplacement}\n`,
    );

    await fs.writeFile(path.join(tmpRoot, 'drift.txt'), 'cat\ncat\n', 'utf8');
    const prepareDrift = (
      await prepareOccurrenceReplaceTool.call(dlg, caller, {
        path: 'drift.txt',
        find: 'cat',
        content: 'dog',
      })
    ).content;
    await fs.writeFile(path.join(tmpRoot, 'drift.txt'), 'cat\ncat\ncat\n', 'utf8');
    const applyDrift = (
      await applyOccurrenceReplaceTool.call(dlg, caller, {
        plan_id: extractPlanId(prepareDrift),
      })
    ).content;
    assert.ok(applyDrift.includes('error: FILE_CHANGED_SINCE_PREPARE'));
    assert.equal(await fs.readFile(path.join(tmpRoot, 'drift.txt'), 'utf8'), 'cat\ncat\ncat\n');

    const longLine = `${'x'.repeat(400)}token`;
    await fs.writeFile(path.join(tmpRoot, 'long-line.txt'), `${longLine}\n${longLine}\n`, 'utf8');
    const prepareLongLine = (
      await prepareOccurrenceReplaceTool.call(dlg, caller, {
        path: 'long-line.txt',
        find: 'token',
        content: 'done',
      })
    ).content;
    assert.ok(prepareLongLine.includes('[truncated '), 'match preview should cap long lines');
    assert.ok(!prepareLongLine.includes(longLine), 'match preview should not echo full long lines');

    console.log('✓ occurrence replace tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
