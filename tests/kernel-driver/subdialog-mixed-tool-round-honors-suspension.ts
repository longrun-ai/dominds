import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { formatAssignmentFromSupdialog } from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage } from '../../main/runtime/work-language';

import {
  createRootDialog,
  makeDriveOptions,
  makeUserPrompt,
  waitForAllDialogsUnlocked,
  withTempRtws,
  wrapPromptWithExpectedReplyTool,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, {
      includePangu: true,
      memberTools: ['env_get'],
    });

    const trigger = 'Start one round that emits tellask and env_get together.';
    const sessionSlug = 'mixed-tool-suspend';
    const tellaskBody = 'Please ask the human a blocker question before you finish.';
    const language = getWorkLanguage();
    const followUpAnswer = 'I finished the local env check while @pangu is still pending.';

    const expectedSubdialogPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromSupdialog({
        callName: 'tellask',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: ['@pangu'],
        tellaskContent: tellaskBody,
        language,
        sessionSlug,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellask',
      language,
    });

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: 'I will ask @pangu and run a readonly inspection first.',
        funcCalls: [
          {
            id: 'call-root-tellask',
            name: 'tellask',
            arguments: {
              targetAgentId: 'pangu',
              sessionSlug,
              tellaskContent: tellaskBody,
            },
          },
          {
            id: 'call-root-env-get',
            name: 'env_get',
            arguments: {
              key: 'DOMINDS_TEST_MIXED_TOOL_ROUND',
            },
          },
        ],
      },
      {
        message: '(unset)',
        role: 'tool',
        response: followUpAnswer,
      },
      {
        message: expectedSubdialogPrompt,
        role: 'user',
        response: 'I need a human blocker before I can finish.',
        funcCalls: [
          {
            id: 'call-subdialog-q4h',
            name: 'askHuman',
            arguments: {
              tellaskContent: 'Please answer this blocker later.',
            },
          },
        ],
      },
    ]);

    const root = await createRootDialog('tester');
    root.disableDiligencePush = true;

    await driveDialogStream(
      root,
      makeUserPrompt(trigger, 'kernel-driver-subdialog-mixed-tool-round-honors-suspension'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const rootEvents = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const genStartCount = rootEvents.filter((event) => event.type === 'gen_start_record').length;
    assert.equal(
      genStartCount,
      2,
      'ordinary tool use should allow one more follow-up generation even while subdialogs are pending',
    );
    assert.ok(
      rootEvents.some((event) => event.type === 'func_call_record' && event.name === 'env_get'),
      'ordinary tool call should still execute in the original round',
    );
    assert.ok(
      rootEvents.some((event) => event.type === 'func_result_record' && event.name === 'env_get'),
      'ordinary tool result should still persist before the follow-up round',
    );

    const assistantSayings = root.msgs.filter(
      (
        msg,
      ): msg is Extract<(typeof root.msgs)[number], { type: 'saying_msg'; role: 'assistant' }> =>
        msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    assert.equal(
      assistantSayings.length,
      2,
      'root dialog should open exactly one post-tool follow-up assistant round while subdialogs are pending',
    );
    assert.equal(
      assistantSayings[assistantSayings.length - 1]?.content,
      followUpAnswer,
      'follow-up assistant round should complete before the dialog suspends on pending subdialogs',
    );

    const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(root.id, root.status);
    assert.equal(
      pendingSubdialogs.length,
      1,
      'expected the tellask-created subdialog to remain pending after the follow-up round suspends',
    );
  });

  console.log('kernel-driver subdialog-mixed-tool-round-honors-suspension: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver subdialog-mixed-tool-round-honors-suspension: FAIL\n${message}`);
  process.exit(1);
});
