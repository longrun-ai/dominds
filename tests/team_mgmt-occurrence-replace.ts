import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import {
  teamMgmtApplyOccurrenceReplaceTool,
  teamMgmtPrepareOccurrenceReplaceTool,
  teamMgmtTools,
} from '../main/tools/team_mgmt';
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

const evidence = semanticEvidenceCollector('dominds-scoped-edit-plans-');
async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      const dlg = await createMainDialog('editor');
      dlg.setLastUserLanguageCode(language);
      const alice = new Team.Member({
        id: 'editor',
        name: 'Editor',
        read_dirs: ['**'],
        write_dirs: ['**'],
      });

      const scopedPath = `occurrences-${language}.md`;
      const actualPath = `.minds/${scopedPath}`;
      await fs.writeFile(actualPath, 'read_file: alpha\nread_file: beta\nread_file: gamma\n');
      const toolNames = new Set(teamMgmtTools.map((tool) => tool.name));
      assert.ok(toolNames.has('team_mgmt_prepare_occurrence_replace'));
      assert.ok(toolNames.has('team_mgmt_apply_occurrence_replace'));

      const replacement = 'new_name';
      const prepare = (
        await teamMgmtPrepareOccurrenceReplaceTool.call(dlg, alice, {
          path: scopedPath,
          find: 'read_file',
          content: replacement,
        })
      ).content;
      assert.equal(toolOutputData(prepare).status, 'ok');
      assert.ok(toolOutputData(prepare).mode === 'prepare_occurrence_replace');
      assert.equal(toolOutputData(prepare).path, actualPath);
      assert.equal(toolOutputData(prepare).find, 'read_file');
      assert.ok(toolOutputData(prepare).selected_count === 3);
      assert.ok(!prepare.includes(replacement), 'prepare should not echo replacement by default');
      assert.equal(
        await fs.readFile(actualPath, 'utf8'),
        'read_file: alpha\nread_file: beta\nread_file: gamma\n',
        'prepare must not write',
      );

      const genericApply = await applyOccurrenceReplaceTool.call(dlg, alice, {
        plan_id: extractPlanId(prepare),
      });
      assert.equal(genericApply.outcome, 'failure');
      assert.equal(
        await fs.readFile(actualPath, 'utf8'),
        'read_file: alpha\nread_file: beta\nread_file: gamma\n',
      );
      const apply = (
        await teamMgmtApplyOccurrenceReplaceTool.call(dlg, alice, {
          plan_id: extractPlanId(prepare),
        })
      ).content;
      assert.equal(toolOutputData(apply).status, 'ok');
      assert.ok(toolOutputData(apply).mode === 'apply_occurrence_replace');
      assert.equal(toolOutputData(apply).path, actualPath);
      assert.ok(!apply.includes(replacement), 'apply should not echo replacement by default');
      assert.equal(
        await fs.readFile(actualPath, 'utf8'),
        `${replacement}: alpha\n${replacement}: beta\n${replacement}: gamma\n`,
      );

      const consumed = await teamMgmtApplyOccurrenceReplaceTool.call(dlg, alice, {
        plan_id: extractPlanId(prepare),
      });
      assert.equal(consumed.outcome, 'failure');
      assert.equal(toolOutputData(consumed.content).error, 'PLAN_NOT_FOUND');
      assert.equal(
        await fs.readFile(actualPath, 'utf8'),
        `${replacement}: alpha\n${replacement}: beta\n${replacement}: gamma\n`,
      );
      const singleSelectionPrepare = (
        await teamMgmtPrepareOccurrenceReplaceTool.call(dlg, alice, {
          path: scopedPath,
          find: replacement,
          content: 'single',
          occurrence_indexes: [2],
        })
      ).content;
      assert.equal(toolOutputData(singleSelectionPrepare).status, 'ok');
      assert.ok(toolOutputData(singleSelectionPrepare).selected_count === 1);
      assert.ok(toolOutputData(singleSelectionPrepare).notice === 'NOT_MULTI_OCCURRENCE');
      const singleSelectionApply = (
        await teamMgmtApplyOccurrenceReplaceTool.call(dlg, alice, {
          plan_id: extractPlanId(singleSelectionPrepare),
        })
      ).content;
      assert.equal(toolOutputData(singleSelectionApply).status, 'ok');
      assert.ok(toolOutputData(singleSelectionApply).mode === 'apply_occurrence_replace');
      assert.equal(
        await fs.readFile(actualPath, 'utf8'),
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
      assert.equal(toolOutputData(padWrite).status, 'ok');
      assert.ok(!padWrite.includes(padReplacement), 'pad_write should not echo pad body');
      const preparePad = (
        await teamMgmtPrepareOccurrenceReplaceTool.call(dlg, alice, {
          path: 'pad-target.md',
          find: 'red\n',
          pad_id: 'team_occurrence_src',
          occurrence_indexes: [1, 3],
        })
      ).content;
      assert.equal(toolOutputData(preparePad).status, 'ok');
      assert.equal(toolOutputData(preparePad).find, 'red\n');
      assert.ok(toolOutputData(preparePad).source === 'pad');
      assert.ok(!preparePad.includes(padReplacement), 'pad prepare must not echo pad body');
      const applyPad = (
        await teamMgmtApplyOccurrenceReplaceTool.call(dlg, alice, {
          plan_id: extractPlanId(preparePad),
        })
      ).content;
      assert.equal(toolOutputData(applyPad).status, 'ok');
      assert.ok(!applyPad.includes(padReplacement), 'pad apply must not echo pad body');
      assert.equal(
        await fs.readFile(path.join(tmpRoot, '.minds', 'pad-target.md'), 'utf8'),
        `${padReplacement}\nred\n${padReplacement}\n`,
      );

      const outsideFile = `outside-plan-${language}.md`;
      await fs.writeFile(outsideFile, 'outside-original\n');
      const outsidePlan = await prepareOccurrenceReplaceTool.call(dlg, alice, {
        path: outsideFile,
        find: 'outside',
        content: 'replaced',
      });
      assert.equal(outsidePlan.outcome, 'success');
      const outsideDenied = await teamMgmtApplyOccurrenceReplaceTool.call(dlg, alice, {
        plan_id: extractPlanId(outsidePlan.content),
      });
      assert.equal(outsideDenied.outcome, 'failure');
      assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside-original\n');
      const outsideApplied = await applyOccurrenceReplaceTool.call(dlg, alice, {
        plan_id: extractPlanId(outsidePlan.content),
      });
      assert.equal(outsideApplied.outcome, 'success');
      assert.equal(await fs.readFile(outsideFile, 'utf8'), 'replaced-original\n');
      evidence.record({
        id: language,
        scenario:
          'Team-scoped prepare/apply updates .minds data exactly, supports a valid single selection and pad source without echoing the replacement.',
        businessValue:
          'Give the team editor an applicable plan/application and recovery path that preserves the capability boundary and input data.',
        context: {
          language,
          scopedPath: actualPath,
          originalFindIsInputData: 'read_file',
          prepareDidNotWrite: true,
          appliedExactFile: true,
          genericApplyToMindsDenied: true,
          scopedApplyToWorkspacePlanDenied: true,
          prepareTool: teamMgmtPrepareOccurrenceReplaceTool.name,
          applyTool: teamMgmtApplyOccurrenceReplaceTool.name,
        },
        reviewQuestions: [
          'Do the actual next step and single-selection guidance refer to functions usable under .minds?',
          'Are planning and application accurately separated, while input-data fields retain their original values?',
        ],
        actualText: JSON.stringify(
          {
            plan: prepare,
            consumed: consumed.content,
            single: singleSelectionPrepare,
            pad: preparePad,
            applied: applyPad,
            outsidePlanDenied: outsideDenied.content,
          },
          null,
          2,
        ),
      });
      console.log('✅ team_mgmt occurrence replace tests passed');
    }
  });
  await evidence.write();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
