import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import { fileRangeEditTool, padWriteTool } from '../main/tools/txt';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { toolOutputData } from './helpers/tool-output';
import { createMainDialog, withTempRtws } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-range-edits-');
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

      await fs.writeFile(path.join(tmpRoot, 'target.txt'), 'one\ntwo\nthree\n', 'utf8');

      const inlineToken = 'INLINE_RANGE_TOKEN';
      const inlineOutput = (
        await fileRangeEditTool.call(dlg, caller, {
          path: 'target.txt',
          range: '2~2',
          content: `${inlineToken}\n`,
        })
      ).content;
      assert.equal(toolOutputData(inlineOutput).status, 'ok');
      assert.ok(toolOutputData(inlineOutput).mode === 'file_range_edit');
      assert.ok(!inlineOutput.includes(inlineToken), 'inline file_range_edit should not echo body');
      assert.equal(
        await fs.readFile(path.join(tmpRoot, 'target.txt'), 'utf8'),
        `one\n${inlineToken}\nthree\n`,
      );

      const padToken = 'PAD_RANGE_TOKEN';
      const padWriteOutput = (
        await padWriteTool.call(dlg, caller, {
          pad_id: 'range_src',
          content: `${padToken}\n`,
        })
      ).content;
      assert.equal(toolOutputData(padWriteOutput).status, 'ok');
      assert.ok(!padWriteOutput.includes(padToken), 'pad_write should not echo pad body');

      const padOutput = (
        await fileRangeEditTool.call(dlg, caller, {
          path: 'target.txt',
          range: '4~',
          pad_id: 'range_src',
        })
      ).content;
      assert.equal(toolOutputData(padOutput).status, 'ok');
      assert.ok(toolOutputData(padOutput).source === 'pad');
      assert.ok(toolOutputData(padOutput).redacted === true);
      assert.ok(!padOutput.includes(padToken), 'pad-sourced file_range_edit should not echo body');
      assert.equal(
        await fs.readFile(path.join(tmpRoot, 'target.txt'), 'utf8'),
        `one\n${inlineToken}\nthree\n${padToken}\n`,
      );

      const deleteOutput = (
        await fileRangeEditTool.call(dlg, caller, {
          path: 'target.txt',
          range: '2~2',
          content: '',
        })
      ).content;
      assert.equal(toolOutputData(deleteOutput).status, 'ok');
      assert.ok(toolOutputData(deleteOutput).action === 'delete');
      assert.equal(
        await fs.readFile(path.join(tmpRoot, 'target.txt'), 'utf8'),
        `one\nthree\n${padToken}\n`,
      );

      const previewToken = 'PREVIEW_RANGE_TOKEN';
      const previewOutput = (
        await fileRangeEditTool.call(dlg, caller, {
          path: 'target.txt',
          range: '2~2',
          content: `${previewToken}\n`,
          preview: true,
          show_diff: true,
        })
      ).content;
      assert.equal(toolOutputData(previewOutput).status, 'ok');
      assert.ok(toolOutputData(previewOutput).preview === true);
      assert.ok(previewOutput.includes('```diff'));
      assert.ok(previewOutput.includes(previewToken), 'show_diff preview may explicitly echo body');
      assert.equal(
        await fs.readFile(path.join(tmpRoot, 'target.txt'), 'utf8'),
        `one\nthree\n${padToken}\n`,
        'preview must not write the file',
      );

      evidence.record({
        id: language,
        scenario:
          'Preview a range replacement after earlier actual inline, pad and deletion operations.',
        businessValue:
          'Let the executing agent judge a proposed edit accurately before applying it, without confusing preview with a completed write.',
        context: {
          language,
          previewFileUnchanged: true,
          requestedReplacement: previewToken,
          originalFile: `one\nthree\n${padToken}\n`,
          range: '2~2',
        },
        reviewQuestions: [
          'Does the actual preview accurately describe the proposed change and preserve the distinction between preview and a write?',
          'Are any available next steps consistent with the observed input and tool capabilities?',
        ],
        actualText: previewOutput,
      });
      console.log('✓ file_range_edit tests passed');
    }
  });
  await evidence.write();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
