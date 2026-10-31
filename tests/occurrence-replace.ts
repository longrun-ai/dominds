import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import '../main/tools/builtins';
import { getToolset } from '../main/tools/registry';
import {
  applyOccurrenceReplaceTool,
  padWriteTool,
  prepareOccurrenceReplaceTool,
} from '../main/tools/txt';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { toolOutputData } from './helpers/tool-output';
import { createMainDialog, withTempRtws } from './kernel-driver/helpers';

function extractPlanId(output: string): string {
  const id = toolOutputData(output).plan_id;
  assert.equal(typeof id, 'string');
  return String(id);
}

const evidence = semanticEvidenceCollector('dominds-edit-plans-');
async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      const dlg = await createMainDialog('tester');
      dlg.setLastUserLanguageCode(language);
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
      assert.equal(toolOutputData(prepareAll).status, 'ok');
      assert.ok(toolOutputData(prepareAll).mode === 'prepare_occurrence_replace');
      assert.ok(toolOutputData(prepareAll).selected_count === 3);
      assert.ok(toolOutputData(prepareAll).selected_occurrences_truncated === false);
      assert.ok(
        !prepareAll.includes(replacement),
        'prepare should not echo replacement by default',
      );
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
      assert.equal(toolOutputData(applyAll).status, 'ok');
      assert.ok(toolOutputData(applyAll).mode === 'apply_occurrence_replace');
      assert.ok(!applyAll.includes(replacement), 'apply should not echo replacement by default');
      assert.equal(
        await fs.readFile(path.join(tmpRoot, 'target.txt'), 'utf8'),
        `${replacement} one\n${replacement} two\n${replacement} three\n`,
      );

      const singleSelectionPrepare = (
        await prepareOccurrenceReplaceTool.call(dlg, caller, {
          path: 'target.txt',
          find: replacement,
          content: 'single',
          occurrence_indexes: [2],
        })
      ).content;
      assert.equal(toolOutputData(singleSelectionPrepare).status, 'ok');
      assert.ok(toolOutputData(singleSelectionPrepare).selected_count === 1);
      assert.ok(toolOutputData(singleSelectionPrepare).notice === 'NOT_MULTI_OCCURRENCE');
      const singleSelectionApply = (
        await applyOccurrenceReplaceTool.call(dlg, caller, {
          plan_id: extractPlanId(singleSelectionPrepare),
        })
      ).content;
      assert.equal(toolOutputData(singleSelectionApply).status, 'ok');
      assert.ok(toolOutputData(singleSelectionApply).mode === 'apply_occurrence_replace');
      assert.equal(
        await fs.readFile(path.join(tmpRoot, 'target.txt'), 'utf8'),
        `${replacement} one\nsingle two\n${replacement} three\n`,
      );

      await fs.writeFile(path.join(tmpRoot, 'pad-target.txt'), 'red\nred\nred\n', 'utf8');
      const padReplacement = 'BLUE_PAD_TOKEN';
      const padWrite = (
        await padWriteTool.call(dlg, caller, {
          pad_id: 'replace_src',
          content: padReplacement,
        })
      ).content;
      assert.equal(toolOutputData(padWrite).status, 'ok');
      assert.ok(!padWrite.includes(padReplacement), 'pad_write should not echo pad body');
      const preparePad = (
        await prepareOccurrenceReplaceTool.call(dlg, caller, {
          path: 'pad-target.txt',
          find: 'red\n',
          pad_id: 'replace_src',
          occurrence_indexes: [1, 3],
        })
      ).content;
      assert.equal(toolOutputData(preparePad).status, 'ok');
      assert.equal(toolOutputData(preparePad).find, 'red\n');
      assert.ok(toolOutputData(preparePad).source === 'pad');
      assert.deepEqual(toolOutputData(preparePad).selected_occurrences, [1, 3]);
      assert.ok(toolOutputData(preparePad).selected_occurrences_truncated === false);
      assert.ok(!preparePad.includes(padReplacement), 'pad prepare must not echo pad body');
      const applyPad = (
        await applyOccurrenceReplaceTool.call(dlg, caller, {
          plan_id: extractPlanId(preparePad),
        })
      ).content;
      assert.equal(toolOutputData(applyPad).status, 'ok');
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
      assert.equal(toolOutputData(prepareDrift).status, 'ok');
      await fs.writeFile(path.join(tmpRoot, 'drift.txt'), 'cat\ncat\ncat\n', 'utf8');
      const applyDrift = (
        await applyOccurrenceReplaceTool.call(dlg, caller, {
          plan_id: extractPlanId(prepareDrift),
        })
      ).content;
      assert.ok(toolOutputData(applyDrift).error === 'FILE_CHANGED_SINCE_PREPARE');
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
      assert.equal(toolOutputData(prepareLongLine).status, 'ok');
      const matchPreview = toolOutputData(prepareLongLine).match_preview;
      assert.equal(typeof matchPreview, 'string');
      assert.ok(String(matchPreview).length < longLine.length * 2);
      assert.ok(
        !prepareLongLine.includes(longLine),
        'match preview should not echo full long lines',
      );

      const appliedLong = await applyOccurrenceReplaceTool.call(dlg, caller, {
        plan_id: extractPlanId(prepareLongLine),
      });
      assert.equal(appliedLong.outcome, 'success');
      assert.equal(
        await fs.readFile('long-line.txt', 'utf8'),
        `${'x'.repeat(400)}done\n${'x'.repeat(400)}done\n`,
      );
      await fs.writeFile('same-size.txt', 'cat\ncat\n');
      const sameSize = await prepareOccurrenceReplaceTool.call(dlg, caller, {
        path: 'same-size.txt',
        find: 'cat',
        content: 'dog',
      });
      assert.equal(sameSize.outcome, 'success');
      await fs.writeFile('same-size.txt', 'cat\nbat\n');
      const sameSizeRefused = await applyOccurrenceReplaceTool.call(dlg, caller, {
        plan_id: extractPlanId(sameSize.content),
      });
      assert.equal(sameSizeRefused.outcome, 'failure');
      assert.equal(toolOutputData(sameSizeRefused.content).error, 'FILE_CHANGED_SINCE_PREPARE');
      assert.equal(await fs.readFile('same-size.txt', 'utf8'), 'cat\nbat\n');
      await fs.writeFile('owner.txt', 'owner-data\n');
      const owned = await prepareOccurrenceReplaceTool.call(dlg, caller, {
        path: 'owner.txt',
        find: 'owner',
        content: 'changed',
      });
      assert.equal(owned.outcome, 'success');
      const other = new Team.Member({ id: 'other', name: 'Other' });
      const wrongOwner = await applyOccurrenceReplaceTool.call(dlg, other, {
        plan_id: extractPlanId(owned.content),
      });
      assert.equal(wrongOwner.outcome, 'failure');
      assert.equal(toolOutputData(wrongOwner.content).error, 'WRONG_OWNER');
      assert.equal(await fs.readFile('owner.txt', 'utf8'), 'owner-data\n');
      const ownerApplied = await applyOccurrenceReplaceTool.call(dlg, caller, {
        plan_id: extractPlanId(owned.content),
      });
      assert.equal(ownerApplied.outcome, 'success');
      assert.equal(await fs.readFile('owner.txt', 'utf8'), 'changed-data\n');
      const consumed = await applyOccurrenceReplaceTool.call(dlg, caller, {
        plan_id: extractPlanId(owned.content),
      });
      assert.equal(consumed.outcome, 'failure');
      assert.equal(toolOutputData(consumed.content).error, 'PLAN_NOT_FOUND');
      assert.equal(await fs.readFile('owner.txt', 'utf8'), 'changed-data\n');
      evidence.record({
        id: language,
        scenario:
          'Plan/apply all and selected literal occurrences, use a pad replacement, refuse changed files including equal-size drift, reject a different owner and keep long-line edits complete.',
        businessValue:
          'Keep a proposed edit tied to the observed file and authorized owner; bounded evidence must not shorten actual file data.',
        context: {
          language,
          allAndSelectedWritesExact: true,
          prepareFileUnchanged: true,
          wrongOwnerRejected: true,
          sameSizeDriftRejected: true,
          ownerCanStillApply: true,
          longLineAppliedInFull: true,
          scope:
            'Direct public tools, real files and process-local plans; not restart durability or an OS transaction.',
        },
        reviewQuestions: [
          'Are planning/success/refusal and safe recovery guidance consistent with actual effects and the available public tools?',
          'Does the single-occurrence notice remain useful without rejecting a valid plan?',
          'Does bounded match evidence disclose its limits without claiming omitted data was reviewed?',
        ],
        actualText: JSON.stringify(
          {
            singlePlan: singleSelectionPrepare,
            consumed: consumed.content,
            changedFile: applyDrift,
            sameSizeDrift: sameSizeRefused.content,
            wrongOwner: wrongOwner.content,
            longMatch: prepareLongLine,
          },
          null,
          2,
        ),
      });
      console.log('✓ occurrence replace tests passed');
    }
  });
  await evidence.write();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
