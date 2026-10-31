import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import {
  teamMgmtFileAppendTool,
  teamMgmtFileBlockReplaceTool,
  teamMgmtFileInsertAfterTool,
  teamMgmtFileInsertBeforeTool,
  teamMgmtFileRangeEditTool,
} from '../main/tools/team_mgmt';
import { padWriteTool } from '../main/tools/txt';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { toolOutputData } from './helpers/tool-output';
import { createMainDialog, withTempRtws } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-scoped-direct-edit-');
async function main(): Promise<void> {
  await withTempRtws(async () => {
    const caller = new Team.Member({ id: 'manager', name: 'Manager' });
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      const dlg = await createMainDialog('manager');
      dlg.setLastUserLanguageCode(language);
      const file = `direct-${language}.md`;
      const fullPath = `.minds/${file}`;
      await fs.writeFile(fullPath, 'one\ntwo\nthree\n');
      const token = `range-body-${language}`;
      const range = await teamMgmtFileRangeEditTool.call(dlg, caller, {
        path: file,
        range: '2~2',
        content: `${token}\n`,
      });
      assert.equal(range.outcome, 'success');
      assert.equal(toolOutputData(range.content).mode, 'file_range_edit');
      assert.equal(toolOutputData(range.content).path, fullPath);
      assert.equal(range.content.includes(token), false);
      assert.equal(await fs.readFile(fullPath, 'utf8'), `one\n${token}\nthree\n`);

      const padBody = `pad-range-body-${language}`;
      const pad = await padWriteTool.call(dlg, caller, {
        pad_id: 'scoped_range',
        content: `${padBody}\n`,
        intent: 'replace the last data line',
        completion: 'after the intended edits are accepted',
      });
      assert.equal(pad.outcome, 'success');
      assert.equal(pad.content.includes(padBody), false);
      const fromPad = await teamMgmtFileRangeEditTool.call(dlg, caller, {
        path: fullPath,
        range: '3~3',
        pad_id: 'scoped_range',
      });
      assert.equal(fromPad.outcome, 'success');
      assert.equal(toolOutputData(fromPad.content).source, 'pad');
      assert.equal(fromPad.content.includes(padBody), false);
      const beforePreview = `one\n${token}\n${padBody}\n`;
      assert.equal(await fs.readFile(fullPath, 'utf8'), beforePreview);
      const preview = await teamMgmtFileRangeEditTool.call(dlg, caller, {
        path: file,
        range: '2~2',
        content: 'PREVIEW_ONLY_DATA\n',
        preview: true,
        show_diff: true,
      });
      assert.equal(preview.outcome, 'success');
      assert.equal(toolOutputData(preview.content).preview, true);
      assert.match(preview.content, /^```diff\r?\n/m, 'public unified-diff block grammar');
      assert.equal(await fs.readFile(fullPath, 'utf8'), beforePreview);

      const appended = await teamMgmtFileAppendTool.call(dlg, caller, {
        path: file,
        content: 'tail-data\n',
      });
      assert.equal(appended.outcome, 'success');
      assert.equal(toolOutputData(appended.content).mode, 'file_append');
      assert.equal(appended.content.includes('tail-data'), false);
      assert.equal(await fs.readFile(fullPath, 'utf8'), `${beforePreview}tail-data\n`);
      const before = await teamMgmtFileInsertBeforeTool.call(dlg, caller, {
        path: file,
        anchor: 'one',
        content: 'head-data\n',
      });
      assert.equal(before.outcome, 'success');
      assert.equal(await fs.readFile(fullPath, 'utf8'), `head-data\n${beforePreview}tail-data\n`);
      const after = await teamMgmtFileInsertAfterTool.call(dlg, caller, {
        path: fullPath,
        anchor: 'tail-data',
        content: 'after-data\n',
      });
      assert.equal(after.outcome, 'success');
      assert.equal(
        await fs.readFile(fullPath, 'utf8'),
        `head-data\n${beforePreview}tail-data\nafter-data\n`,
      );
      const block = await teamMgmtFileBlockReplaceTool.call(dlg, caller, {
        path: file,
        start_anchor: 'one',
        end_anchor: 'tail-data',
        content: 'block-data\n',
        include_anchors: true,
      });
      assert.equal(block.outcome, 'success');
      assert.equal(
        await fs.readFile(fullPath, 'utf8'),
        'head-data\none\nblock-data\ntail-data\nafter-data\n',
      );
      evidence.record({
        id: language,
        scenario:
          'Direct .minds range, pad, append, before/after and block edits write exact intended data; preview shows a different body without writing.',
        businessValue:
          'Let a team editor safely review and apply targeted changes using tools valid for the team directory.',
        context: {
          language,
          previewFileUnchanged: true,
          exactFinalBytesChecked: true,
          scope:
            'Direct public tools with real disk and pad/dialog objects; no driver discovery, model, browser or live configuration reload claim.',
        },
        reviewQuestions: [
          'Do actual summaries distinguish preview from completed writes?',
          'Is pad cleanup guidance applicable only after the dependent edits are complete?',
          'Does the displayed diff describe the proposed change and avoid implying that preview wrote it?',
        ],
        actualText: JSON.stringify(
          {
            range: range.content,
            pad: fromPad.content,
            preview: preview.content,
            append: appended.content,
            before: before.content,
            after: after.content,
            block: block.content,
          },
          null,
          2,
        ),
      });
    }
  });
  await evidence.write();
  console.log('team-scoped direct edits, distinct preview, pad and anchor effects: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
