import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { MAIN_DIALOG_GOAL_REMINDER_ID } from '../../main/main-dialog-goal-reminder';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import type { FuncTool } from '../../main/tool';
import { toolPartialFailure } from '../../main/tool';
import { registerTool, unregisterTool } from '../../main/tools/registry';

import {
  createMainDialog,
  lastAssistantSaying,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

const PARTIAL_FAILURE_TOOL_NAME = 'clear_mind_sibling_partial_failure_probe';

function nonGoalReminderCount(dlg: Awaited<ReturnType<typeof createMainDialog>>): number {
  return dlg.reminders.filter((reminder) => reminder.id !== MAIN_DIALOG_GOAL_REMINDER_ID).length;
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('zh');
    const partialFailureTool: FuncTool = {
      type: 'func',
      name: PARTIAL_FAILURE_TOOL_NAME,
      description: 'Test-only tool that returns partial_failure.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      argsValidation: 'passthrough',
      async call() {
        return toolPartialFailure('局部失败探针结果');
      },
    };
    registerTool(partialFailureTool);
    try {
      await writeStandardMinds(tmpRoot, { memberTools: [PARTIAL_FAILURE_TOOL_NAME] });

      const trigger = '请同轮更新不存在的提醒项，然后 clear_mind。';
      const clearFirstTrigger = '请同轮先 clear_mind，然后更新不存在的提醒项。';
      const invalidSpecialTrigger = '请同轮 askHuman 参数错误，然后 clear_mind。';
      const partialFailureTrigger = '请同轮触发 partial_failure 工具，然后 clear_mind。';
      const failedUpdateCallId = 'clear-mind-sibling-update-missing';
      const clearMindCallId = 'clear-mind-sibling-blocked';
      const clearFirstCallId = 'clear-mind-first-sibling-blocked';
      const clearFirstFailedUpdateCallId = 'clear-mind-first-sibling-update-missing';
      const invalidAskHumanCallId = 'clear-mind-invalid-ask-human';
      const invalidSpecialClearMindCallId = 'clear-mind-invalid-special-blocked';
      const partialFailureCallId = 'clear-mind-partial-failure-probe';
      const partialFailureClearMindCallId = 'clear-mind-partial-failure-blocked';
      const blockedClearMindResult = [
        '错误：本轮 clear_mind 与其它工具一起调用，但其它工具返回了失败结果。',
        '',
        `- update_reminder (callId=${failedUpdateCallId}, outcome=failure)`,
        '',
        'clear_mind 已拒绝开启新一程。请先确保其它工具调用正常完成（必要时修正参数、重试或处理失败），然后再次调用 clear_mind。',
      ].join('\n');
      const clearFirstBlockedClearMindResult = [
        '错误：本轮 clear_mind 与其它工具一起调用，但其它工具返回了失败结果。',
        '',
        `- update_reminder (callId=${clearFirstFailedUpdateCallId}, outcome=failure)`,
        '',
        'clear_mind 已拒绝开启新一程。请先确保其它工具调用正常完成（必要时修正参数、重试或处理失败），然后再次调用 clear_mind。',
      ].join('\n');
      const invalidSpecialBlockedClearMindResult = [
        '错误：本轮 clear_mind 与其它工具一起调用，但其它工具返回了失败结果。',
        '',
        `- askHuman (callId=${invalidAskHumanCallId}, outcome=failure)`,
        '',
        'clear_mind 已拒绝开启新一程。请先确保其它工具调用正常完成（必要时修正参数、重试或处理失败），然后再次调用 clear_mind。',
      ].join('\n');
      const partialFailureBlockedClearMindResult = [
        '错误：本轮 clear_mind 与其它工具一起调用，但其它工具返回了失败结果。',
        '',
        `- ${PARTIAL_FAILURE_TOOL_NAME} (callId=${partialFailureCallId}, outcome=partial_failure)`,
        '',
        'clear_mind 已拒绝开启新一程。请先确保其它工具调用正常完成（必要时修正参数、重试或处理失败），然后再次调用 clear_mind。',
      ].join('\n');
      const finalAnswer = '我会先修正失败的提醒项操作，再重新考虑 clear_mind。';
      const clearFirstFinalAnswer = '即使 clear_mind 在前，也会先处理失败工具。';
      const invalidSpecialFinalAnswer = 'askHuman 参数失败时也不会换程。';
      const partialFailureFinalAnswer = 'partial_failure 也会阻止 clear_mind 换程。';

      await writeMockDb(tmpRoot, [
        {
          message: trigger,
          role: 'user',
          response: '我先尝试这两个工具。',
          funcCalls: [
            {
              id: failedUpdateCallId,
              name: 'update_reminder',
              arguments: { reminder_id: 'missing-reminder', content: '新的接续信息' },
            },
            {
              id: clearMindCallId,
              name: 'clear_mind',
              arguments: { reminder_content: '如果换程成功，这条提醒会出现。' },
            },
          ],
        },
        {
          message: blockedClearMindResult,
          role: 'tool',
          response: finalAnswer,
        },
        {
          message: clearFirstTrigger,
          role: 'user',
          response: '我先写 clear_mind，再写另一个工具。',
          funcCalls: [
            {
              id: clearFirstCallId,
              name: 'clear_mind',
              arguments: { reminder_content: '如果前置 clear_mind 换程成功，这条提醒会出现。' },
            },
            {
              id: clearFirstFailedUpdateCallId,
              name: 'update_reminder',
              arguments: { reminder_id: 'missing-reminder', content: '新的接续信息' },
            },
          ],
        },
        {
          message: "提醒项 'missing-reminder' 不存在。",
          role: 'tool',
          contextContains: [clearFirstBlockedClearMindResult],
          response: clearFirstFinalAnswer,
        },
        {
          message: invalidSpecialTrigger,
          role: 'user',
          response: '我会错误调用 askHuman，再调用 clear_mind。',
          funcCalls: [
            {
              id: invalidAskHumanCallId,
              name: 'askHuman',
              arguments: {},
            },
            {
              id: invalidSpecialClearMindCallId,
              name: 'clear_mind',
              arguments: { reminder_content: '如果 special 失败后仍换程，这条提醒会出现。' },
            },
          ],
        },
        {
          message: invalidSpecialBlockedClearMindResult,
          role: 'tool',
          response: invalidSpecialFinalAnswer,
        },
        {
          message: partialFailureTrigger,
          role: 'user',
          response: '我会调用局部失败探针，再调用 clear_mind。',
          funcCalls: [
            {
              id: partialFailureCallId,
              name: PARTIAL_FAILURE_TOOL_NAME,
              arguments: {},
            },
            {
              id: partialFailureClearMindCallId,
              name: 'clear_mind',
              arguments: { reminder_content: '如果 partial_failure 后仍换程，这条提醒会出现。' },
            },
          ],
        },
        {
          message: partialFailureBlockedClearMindResult,
          role: 'tool',
          response: partialFailureFinalAnswer,
        },
      ]);

      const dlg = await createMainDialog('tester');
      dlg.disableDiligencePush = true;

      await driveDialogStream(
        dlg,
        {
          content: trigger,
          msgId: 'kernel-driver-clear-mind-blocks-on-sibling-tool-failure',
          grammar: 'markdown',
          origin: 'user',
        },
        true,
      );

      assert.equal(dlg.currentCourse, 1, 'blocked clear_mind must not switch to a new course');
      assert.equal(lastAssistantSaying(dlg), finalAnswer);
      assert.equal(
        nonGoalReminderCount(dlg),
        0,
        'blocked clear_mind must not create its continuation reminder',
      );

      const clearMindResult = dlg.msgs.find(
        (msg) =>
          msg.type === 'func_result_msg' && msg.id === clearMindCallId && msg.name === 'clear_mind',
      );
      assert.ok(clearMindResult, 'expected clear_mind to receive a tool result');
      assert.equal(clearMindResult.content, blockedClearMindResult);

      const latest = await DialogPersistence.loadDialogLatest(dlg.id, dlg.status);
      assert.equal(
        latest?.pendingRuntimePrompt,
        undefined,
        'blocked clear_mind must not queue a new-course runtime prompt',
      );
      assert.equal(
        latest?.nextStep.triggers.some((trigger) => trigger.kind === 'queued_prompt'),
        false,
        'blocked clear_mind must not leave a queued-prompt trigger',
      );

      await driveDialogStream(
        dlg,
        {
          content: clearFirstTrigger,
          msgId: 'kernel-driver-clear-mind-first-blocks-on-later-sibling-tool-failure',
          grammar: 'markdown',
          origin: 'user',
        },
        true,
      );

      assert.equal(
        dlg.currentCourse,
        1,
        'clear_mind must not switch course even when it appears before the failed sibling tool',
      );
      assert.equal(lastAssistantSaying(dlg), clearFirstFinalAnswer);
      assert.equal(
        nonGoalReminderCount(dlg),
        0,
        'front-position blocked clear_mind must not create its continuation reminder',
      );

      const clearFirstResult = dlg.msgs.find(
        (msg) =>
          msg.type === 'func_result_msg' &&
          msg.id === clearFirstCallId &&
          msg.name === 'clear_mind',
      );
      assert.ok(clearFirstResult, 'expected front-position clear_mind to receive a tool result');
      assert.equal(clearFirstResult.content, clearFirstBlockedClearMindResult);

      await driveDialogStream(
        dlg,
        {
          content: invalidSpecialTrigger,
          msgId: 'kernel-driver-clear-mind-blocks-on-invalid-special-tool-failure',
          grammar: 'markdown',
          origin: 'user',
        },
        true,
      );

      assert.equal(
        dlg.currentCourse,
        1,
        'clear_mind must not switch course when an invalid special tool fails in the same round',
      );
      assert.equal(lastAssistantSaying(dlg), invalidSpecialFinalAnswer);
      assert.equal(
        nonGoalReminderCount(dlg),
        0,
        'special-failure blocked clear_mind must not create its continuation reminder',
      );

      const invalidSpecialClearMindResult = dlg.msgs.find(
        (msg) =>
          msg.type === 'func_result_msg' &&
          msg.id === invalidSpecialClearMindCallId &&
          msg.name === 'clear_mind',
      );
      assert.ok(
        invalidSpecialClearMindResult,
        'expected clear_mind to receive a tool result after invalid special failure',
      );
      assert.equal(invalidSpecialClearMindResult.content, invalidSpecialBlockedClearMindResult);

      await driveDialogStream(
        dlg,
        {
          content: partialFailureTrigger,
          msgId: 'kernel-driver-clear-mind-blocks-on-partial-failure',
          grammar: 'markdown',
          origin: 'user',
        },
        true,
      );

      assert.equal(
        dlg.currentCourse,
        1,
        'clear_mind must not switch course when another tool returns partial_failure',
      );
      assert.equal(lastAssistantSaying(dlg), partialFailureFinalAnswer);
      assert.equal(
        nonGoalReminderCount(dlg),
        0,
        'partial-failure blocked clear_mind must not create its continuation reminder',
      );

      const partialFailureClearMindResult = dlg.msgs.find(
        (msg) =>
          msg.type === 'func_result_msg' &&
          msg.id === partialFailureClearMindCallId &&
          msg.name === 'clear_mind',
      );
      assert.ok(
        partialFailureClearMindResult,
        'expected clear_mind to receive a tool result after partial_failure',
      );
      assert.equal(partialFailureClearMindResult.content, partialFailureBlockedClearMindResult);
    } finally {
      unregisterTool(PARTIAL_FAILURE_TOOL_NAME);
    }
  });

  console.log('kernel-driver clear-mind-blocks-on-sibling-tool-failure: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver clear-mind-blocks-on-sibling-tool-failure: FAIL\n${message}`);
  process.exit(1);
});
