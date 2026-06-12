import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DialogStore } from '../main/dialog';
import { MainDialog } from '../main/dialog';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import {
  applyOccurrenceReplaceTool,
  fileAppendTool,
  fileBlockReplaceTool,
  fileInsertAfterTool,
  fileRangeEditTool,
  prepareOccurrenceReplaceTool,
} from '../main/tools/txt';

function extractPlanId(output: string): string {
  const match = output.match(/plan_id: '([^']+)'/);
  assert.ok(match, `missing plan_id in output:\n${output}`);
  return match[1] ?? '';
}

function assertToolOutputTruncated(output: string, toolName: string): void {
  assert.ok(
    output.includes(`tool_output_truncated_in_tool tool=${toolName}`),
    `expected ${toolName} truncation marker`,
  );
  assert.ok(output.length <= 48_000, `expected bounded output, got ${output.length} chars`);
}

function assertOccurrenceIndexesPreviewed(output: string): void {
  assert.ok(
    output.includes('selected_occurrences_truncated: true'),
    'expected selected_occurrences field-level truncation',
  );
  assert.ok(
    output.includes('selected_occurrences_omitted_count:'),
    'expected selected_occurrences omitted metadata',
  );
  assert.ok(
    !output.includes('tool_output_truncated_in_tool'),
    'ordinary occurrence YAML should not require whole-output truncation',
  );
  assert.ok(output.length <= 12_000, `expected compact YAML preview, got ${output.length} chars`);
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-edit-output-truncation-'));
  try {
    process.chdir(tmpRoot);
    setWorkLanguage('en');

    const dlg = new MainDialog(
      {} as unknown as DialogStore,
      'edit-output-truncation.tsk',
      undefined,
      'tester',
    );
    const caller = new Team.Member({
      id: 'tester',
      name: 'Tester',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    const hugeLine = 'x'.repeat(80_000);

    await fs.writeFile(path.join(tmpRoot, 'range.txt'), 'before\nanchor\nafter\n', 'utf8');
    const rangeOutput = (
      await fileRangeEditTool.call(dlg, caller, {
        path: 'range.txt',
        range: '2',
        content: `${hugeLine}\n`,
        preview: true,
        show_diff: true,
      })
    ).content;
    assertToolOutputTruncated(rangeOutput, 'file_range_edit');

    await fs.writeFile(path.join(tmpRoot, 'append.txt'), 'before\n', 'utf8');
    const appendOutput = (
      await fileAppendTool.call(dlg, caller, {
        path: 'append.txt',
        content: `${hugeLine}\n`,
        preview: true,
        show_diff: true,
      })
    ).content;
    assertToolOutputTruncated(appendOutput, 'file_append');

    await fs.writeFile(path.join(tmpRoot, 'insert.txt'), 'top\nanchor\nbottom\n', 'utf8');
    const insertOutput = (
      await fileInsertAfterTool.call(dlg, caller, {
        path: 'insert.txt',
        anchor: 'anchor',
        content: `${hugeLine}\n`,
        preview: true,
        show_diff: true,
      })
    ).content;
    assertToolOutputTruncated(insertOutput, 'file_insert_after');

    await fs.writeFile(path.join(tmpRoot, 'block.txt'), 'top\nBEGIN\nold\nEND\nbottom\n', 'utf8');
    const blockOutput = (
      await fileBlockReplaceTool.call(dlg, caller, {
        path: 'block.txt',
        start_anchor: 'BEGIN',
        end_anchor: 'END',
        content: `${hugeLine}\n`,
        preview: true,
        show_diff: true,
      })
    ).content;
    assertToolOutputTruncated(blockOutput, 'file_block_replace');

    await fs.writeFile(
      path.join(tmpRoot, 'occurrence-yaml.txt'),
      `${Array.from({ length: 10_000 }, (_value, index) => `needle ${index}`).join('\n')}\n`,
      'utf8',
    );
    const prepareYamlOutput = (
      await prepareOccurrenceReplaceTool.call(dlg, caller, {
        path: 'occurrence-yaml.txt',
        find: 'needle',
        content: 'replacement',
      })
    ).content;
    assertOccurrenceIndexesPreviewed(prepareYamlOutput);

    const applyYamlOutput = (
      await applyOccurrenceReplaceTool.call(dlg, caller, {
        plan_id: extractPlanId(prepareYamlOutput),
      })
    ).content;
    assertOccurrenceIndexesPreviewed(applyYamlOutput);

    await fs.writeFile(
      path.join(tmpRoot, 'occurrence.txt'),
      `${Array.from({ length: 5000 }, (_value, index) => `needle ${index}`).join('\n')}\n`,
      'utf8',
    );
    const prepareOutput = (
      await prepareOccurrenceReplaceTool.call(dlg, caller, {
        path: 'occurrence.txt',
        find: 'needle',
        content: 'replacement',
        show_diff: true,
      })
    ).content;
    assertToolOutputTruncated(prepareOutput, 'prepare_occurrence_replace');

    const applyOutput = (
      await applyOccurrenceReplaceTool.call(dlg, caller, {
        plan_id: extractPlanId(prepareOutput),
        show_diff: true,
      })
    ).content;
    assertToolOutputTruncated(applyOutput, 'apply_occurrence_replace');

    console.log('✓ edit output truncation tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
