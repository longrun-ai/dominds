import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
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
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { toolOutputData } from './helpers/tool-output';
import { createMainDialog, withTempRtws } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-edit-output-');
function extractPlanId(output: string): string {
  const id = toolOutputData(output).plan_id;
  assert.equal(typeof id, 'string');
  return String(id);
}

function assertBoundedEditOutput(output: string, toolName: string): void {
  const data = toolOutputData(output);
  assert.equal(data.status, 'ok');
  assert.equal(data.mode, toolName);
  assert.ok(output.length <= 48_000, `public tool output budget exceeded: ${output.length}`);
}

function assertOccurrenceIndexesPreviewed(output: string): void {
  const data = toolOutputData(output);
  assert.equal(data.status, 'ok');
  assert.equal(data.selected_occurrences_truncated, true);
  const shown = data.selected_occurrences;
  assert.ok(Array.isArray(shown));
  assert.ok(shown.length > 0 && shown.length < 10_000);
  assert.deepEqual(
    shown,
    Array.from({ length: shown.length }, (_value, index) => index + 1),
  );
  assert.equal(data.selected_occurrences_shown_count, shown.length);
  assert.equal(data.selected_occurrences_omitted_count, 10_000 - shown.length);
  assert.equal(data.selected_occurrences_last, 10_000);
  assert.equal(data.selected_count, 10_000);
  assert.ok(
    output.length <= 12_000,
    `compact public index preview budget exceeded: ${output.length}`,
  );
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      const dlg = await createMainDialog('tester');
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
      assertBoundedEditOutput(rangeOutput, 'file_range_edit');
      assert.equal(
        await fs.readFile(path.join(tmpRoot, 'range.txt'), 'utf8'),
        'before\nanchor\nafter\n',
        'preview must preserve the exact file',
      );

      await fs.writeFile(path.join(tmpRoot, 'append.txt'), 'before\n', 'utf8');
      const appendOutput = (
        await fileAppendTool.call(dlg, caller, {
          path: 'append.txt',
          content: `${hugeLine}\n`,
          preview: true,
          show_diff: true,
        })
      ).content;
      assertBoundedEditOutput(appendOutput, 'file_append');
      assert.equal(
        await fs.readFile(path.join(tmpRoot, 'append.txt'), 'utf8'),
        'before\n',
        'preview must preserve the exact file',
      );

      const actualAppend = await fileAppendTool.call(dlg, caller, {
        path: 'append.txt',
        content: `${hugeLine}\n`,
      });
      assert.equal(actualAppend.outcome, 'success');
      assert.equal(await fs.readFile('append.txt', 'utf8'), `before\n${hugeLine}\n`);
      assert.equal(actualAppend.content.includes(hugeLine), false);

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
      assertBoundedEditOutput(insertOutput, 'file_insert_after');
      assert.equal(
        await fs.readFile(path.join(tmpRoot, 'insert.txt'), 'utf8'),
        'top\nanchor\nbottom\n',
        'preview must preserve the exact file',
      );

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
      assertBoundedEditOutput(blockOutput, 'file_block_replace');
      assert.equal(
        await fs.readFile(path.join(tmpRoot, 'block.txt'), 'utf8'),
        'top\nBEGIN\nold\nEND\nbottom\n',
        'preview must preserve the exact file',
      );

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
      const expectedOldYaml = `${Array.from({ length: 10_000 }, (_value, index) => `needle ${index}`).join('\n')}\n`;
      assert.equal(await fs.readFile('occurrence-yaml.txt', 'utf8'), expectedOldYaml);

      const applyYamlOutput = (
        await applyOccurrenceReplaceTool.call(dlg, caller, {
          plan_id: extractPlanId(prepareYamlOutput),
        })
      ).content;
      assertOccurrenceIndexesPreviewed(applyYamlOutput);
      assert.equal(
        await fs.readFile('occurrence-yaml.txt', 'utf8'),
        `${Array.from({ length: 10_000 }, (_value, index) => `replacement ${index}`).join('\n')}\n`,
      );

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
      assertBoundedEditOutput(prepareOutput, 'prepare_occurrence_replace');
      assert.equal(
        await fs.readFile('occurrence.txt', 'utf8'),
        `${Array.from({ length: 5000 }, (_value, index) => `needle ${index}`).join('\n')}\n`,
      );

      const applyOutput = (
        await applyOccurrenceReplaceTool.call(dlg, caller, {
          plan_id: extractPlanId(prepareOutput),
          show_diff: true,
        })
      ).content;
      assertBoundedEditOutput(applyOutput, 'apply_occurrence_replace');
      const expectedApplied = `${Array.from({ length: 5000 }, (_value, index) => `replacement ${index}`).join('\n')}\n`;
      assert.equal(await fs.readFile('occurrence.txt', 'utf8'), expectedApplied);
      const reapplied = await applyOccurrenceReplaceTool.call(dlg, caller, {
        plan_id: extractPlanId(prepareOutput),
      });
      assert.equal(reapplied.outcome, 'failure');
      assert.equal(toolOutputData(reapplied.content).error, 'PLAN_NOT_FOUND');
      assert.equal(await fs.readFile('occurrence.txt', 'utf8'), expectedApplied);
      evidence.record({
        id: `preview-${language}`,
        scenario:
          'A requested diff includes a single 80,000-character replacement line; the public output is capped while preview leaves the file unchanged.',
        businessValue:
          'Keep agent context bounded while making the omitted preview and actual write status clear.',
        context: {
          language,
          proposedLineCharacters: hugeLine.length,
          publicOutputCharacters: rangeOutput.length,
          outputBudgetCharacters: 48_000,
          actualFileUnchanged: true,
          originalFile: 'before\nanchor\nafter\n',
          requestedRange: '2',
        },
        reviewQuestions: [
          'Does the actual bounded output disclose the omitted material and accurately distinguish preview from a completed write?',
          'Can the agent assess what the preview does and does not establish without assuming omitted content was reviewed?',
        ],
        actualText: rangeOutput,
      });
      evidence.record({
        id: `append-preview-${language}`,
        scenario:
          'Preview an 80,000-character single-line append; keep its YAML metadata readable and the diff bounded, then apply the same full body without shortening the file data.',
        businessValue:
          'Preserve useful status/summary metadata when field previews are too large, while keeping actual edits lossless.',
        context: {
          language,
          proposedLineCharacters: hugeLine.length,
          publicOutputCharacters: appendOutput.length,
          originalFile: 'before\n',
          previewFileUnchanged: true,
          laterActualAppendHasExactFullBody: true,
        },
        reviewQuestions: [
          'Do the actual field previews and clipped diff clearly disclose their partial nature?',
          'Does the output accurately distinguish preview from completed writing and retain usable status/summary information?',
        ],
        actualText: appendOutput,
      });
      evidence.record({
        id: `occurrences-${language}`,
        scenario:
          'Prepare a 5,000-occurrence replacement with a clipped diff, apply the plan and clip that result, then reject reapplication of the consumed plan.',
        businessValue:
          'Distinguish a bounded proposed diff from an actual completed edit and avoid treating omission or plan reuse as evidence of new effects.',
        context: {
          language,
          occurrences: 5000,
          prepareFileUnchanged: true,
          appliedExactFile: true,
          consumedPlanReapplicationRejected: true,
          publicOutputBudgetCharacters: 48_000,
          scope:
            'Real filesystem and process-local edit plans; not restart durability or provider behavior.',
        },
        reviewQuestions: [
          'Do the actual outputs accurately distinguish planning, completed application and rejected reuse?',
          'Do the clipped outputs disclose their limits without implying every omitted change has been shown?',
        ],
        actualText: JSON.stringify(
          { prepare: prepareOutput, apply: applyOutput, reapply: reapplied.content },
          null,
          2,
        ),
      });

      console.log('✓ edit output truncation tests passed');
    }
  });
  await evidence.write();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
