import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import '../main/tools/builtins';
import { getToolset } from '../main/tools/registry';
import {
  fileAppendTool,
  fileBlockReplaceTool,
  fileInsertAfterTool,
  fileInsertBeforeTool,
  padWriteTool,
} from '../main/tools/txt';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { toolOutputData } from './helpers/tool-output';
import { createMainDialog, withTempRtws } from './kernel-driver/helpers';

async function readText(absPath: string): Promise<string> {
  return await fs.readFile(absPath, 'utf8');
}

const evidence = semanticEvidenceCollector('dominds-block-edits-');
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

      const wsModNames = new Set((getToolset('ws_mod') ?? []).map((tool) => tool.name));
      for (const toolName of [
        'file_append',
        'file_insert_after',
        'file_insert_before',
        'file_block_replace',
      ]) {
        assert.ok(wsModNames.has(toolName), `ws_mod should expose ${toolName}`);
      }

      await fs.writeFile(path.join(tmpRoot, 'target.txt'), 'alpha\nanchor\nomega\n', 'utf8');

      const appendToken = 'APPEND_DIRECT_TOKEN';
      const appendOutput = (
        await fileAppendTool.call(dlg, caller, {
          path: 'target.txt',
          content: `${appendToken}\n`,
        })
      ).content;
      assert.equal(toolOutputData(appendOutput).status, 'ok');
      assert.ok(toolOutputData(appendOutput).mode === 'file_append');
      assert.ok(!appendOutput.includes(appendToken), 'file_append should not echo inline body');
      assert.equal(
        await readText(path.join(tmpRoot, 'target.txt')),
        `alpha\nanchor\nomega\n${appendToken}\n`,
      );

      const padToken = 'PAD_INSERT_TOKEN';
      const padWriteOutput = (
        await padWriteTool.call(dlg, caller, {
          pad_id: 'insert_src',
          content: `${padToken}\n`,
        })
      ).content;
      assert.equal(toolOutputData(padWriteOutput).status, 'ok');
      assert.ok(!padWriteOutput.includes(padToken), 'pad_write should not echo pad body');

      const insertAfterOutput = (
        await fileInsertAfterTool.call(dlg, caller, {
          path: 'target.txt',
          anchor: 'anchor',
          pad_id: 'insert_src',
        })
      ).content;
      assert.equal(toolOutputData(insertAfterOutput).status, 'ok');
      assert.ok(toolOutputData(insertAfterOutput).mode === 'file_insert_after');
      assert.ok(toolOutputData(insertAfterOutput).source === 'pad');
      assert.ok(!insertAfterOutput.includes(padToken), 'pad insert should not echo pad body');
      assert.equal(
        await readText(path.join(tmpRoot, 'target.txt')),
        `alpha\nanchor\n${padToken}\nomega\n${appendToken}\n`,
      );

      const beforeToken = 'BEFORE_DIRECT_TOKEN';
      const beforePreview = (
        await fileInsertBeforeTool.call(dlg, caller, {
          path: 'target.txt',
          anchor: 'omega',
          content: `${beforeToken}\n`,
          preview: true,
          show_diff: true,
        })
      ).content;
      assert.equal(toolOutputData(beforePreview).status, 'ok');
      assert.ok(toolOutputData(beforePreview).preview === true);
      assert.ok(beforePreview.includes(beforeToken), 'show_diff preview may explicitly echo body');
      assert.equal(
        await readText(path.join(tmpRoot, 'target.txt')),
        `alpha\nanchor\n${padToken}\nomega\n${appendToken}\n`,
        'preview must not write the file',
      );

      const appliedBefore = await fileInsertBeforeTool.call(dlg, caller, {
        path: 'target.txt',
        anchor: 'omega',
        content: `${beforeToken}\n`,
      });
      assert.equal(appliedBefore.outcome, 'success');
      assert.equal(
        await readText(path.join(tmpRoot, 'target.txt')),
        `alpha\nanchor\n${padToken}\n${beforeToken}\nomega\n${appendToken}\n`,
      );

      await fs.writeFile(
        path.join(tmpRoot, 'block.txt'),
        'top\nBEGIN\nold a\nold b\nEND\nbottom\n',
        'utf8',
      );
      const blockToken = 'BLOCK_PAD_TOKEN';
      await padWriteTool.call(dlg, caller, {
        pad_id: 'block_src',
        content: `${blockToken}\n`,
      });
      const blockOutput = (
        await fileBlockReplaceTool.call(dlg, caller, {
          path: 'block.txt',
          start_anchor: 'BEGIN',
          end_anchor: 'END',
          pad_id: 'block_src',
        })
      ).content;
      assert.equal(toolOutputData(blockOutput).status, 'ok');
      assert.ok(toolOutputData(blockOutput).mode === 'file_block_replace');
      assert.ok(toolOutputData(blockOutput).source === 'pad');
      assert.ok(!blockOutput.includes(blockToken), 'pad block replace should not echo pad body');
      assert.equal(
        await readText(path.join(tmpRoot, 'block.txt')),
        `top\nBEGIN\n${blockToken}\nEND\nbottom\n`,
      );

      evidence.record({
        id: language,
        scenario:
          'Preview a before-anchor insertion, then apply it against the same unchanged file.',
        businessValue:
          'Let the executing agent judge a proposed edit accurately before applying it, without confusing preview with a completed write.',
        context: {
          language,
          previewFileUnchanged: true,
          requestedInsertion: beforeToken,
          anchor: 'omega',
          appliedFileHasExactInsertion: true,
        },
        reviewQuestions: [
          'Does the actual preview accurately describe the proposed change and preserve the distinction between preview and a write?',
          'Are any available next steps consistent with the observed input and tool capabilities?',
        ],
        actualText: beforePreview,
      });
      console.log('✓ file block tools tests passed');
    }
  });
  await evidence.write();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
