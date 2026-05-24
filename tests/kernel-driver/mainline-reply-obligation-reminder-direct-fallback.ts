import assert from 'node:assert/strict';

import type { ChatMessage } from '../../main/llm/client';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import {
  createKernelDriverRuntimeState,
  type KernelDriverDriveCallOptions,
} from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import { formatTellaskResponseContent } from '../../main/runtime/inter-dialog-format';
import {
  buildReplyToolReminderText,
  isReplyToolReminderPromptContent,
} from '../../main/runtime/reply-prompt-copy';
import {
  createMainDialog,
  makeDriveOptions,
  waitFor,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

function findTellaskBackResult(
  msgs: readonly ChatMessage[],
  callId: string,
): Extract<ChatMessage, { type: 'tellask_result_msg' }> | undefined {
  return msgs.find(
    (msg): msg is Extract<ChatMessage, { type: 'tellask_result_msg' }> =>
      msg.type === 'tellask_result_msg' && msg.callName === 'tellaskBack' && msg.callId === callId,
  );
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { diligencePushMax: 1 });

    const plainReplyPrompt = 'Continue the ask-back answer without calling replyTellaskBack.';
    const firstPlainAnswer = 'The answer is ready, but I am still not calling the reply tool.';
    const secondPlainAnswer = 'Repeating the same answer without the reply tool.';
    const targetCallId = 'mainline-askback-call';
    const tellaskContent = 'Please answer the ask-back request.';
    const root = await createMainDialog('tester');
    root.disableDiligencePush = false;
    root.diligencePushRemainingBudget = 1;
    const replyDirective = {
      expectedReplyCallName: 'replyTellaskBack' as const,
      targetDialogId: root.id.selfId,
      targetCallId,
      tellaskContent,
    };
    const replyReminderPrompt = buildReplyToolReminderText({
      language: 'en',
      directive: replyDirective,
      replyTargetAgentId: 'tester',
    });
    const expectedDirectFallbackResult = formatTellaskResponseContent({
      callName: 'tellaskBack',
      callId: targetCallId,
      responderId: 'tester',
      tellaskerId: 'tester',
      tellaskContent,
      responseBody: secondPlainAnswer,
      status: 'completed',
      deliveryMode: 'direct_fallback',
      directFallbackSource: 'saying',
      language: 'en',
    });

    await writeMockDb(tmpRoot, [
      {
        message: plainReplyPrompt,
        role: 'user',
        response: firstPlainAnswer,
      },
      {
        message: replyReminderPrompt,
        role: 'user',
        response: secondPlainAnswer,
      },
    ]);

    await DialogPersistence.setActiveTellaskReplyObligation(root.id, replyDirective, root.status);
    await root.persistFunctionCall(
      targetCallId,
      'tellaskBack',
      JSON.stringify({ tellaskContent }),
      1,
    );

    const scheduled: KernelDriverDriveCallOptions[] = [];
    await executeDriveRound({
      runtime: createKernelDriverRuntimeState(),
      driveArgs: [
        root,
        {
          content: plainReplyPrompt,
          msgId: 'mainline-reply-obligation-first-plain-answer',
          grammar: 'markdown',
          origin: 'runtime',
          tellaskReplyDirective: replyDirective,
        },
        true,
        makeDriveOptions(),
      ],
      scheduleDrive: (scheduledDialog, options) => {
        assert.equal(scheduledDialog, root);
        scheduled.push(options);
      },
      driveDialog: async () => {},
    });

    assert.equal(
      root.diligencePushRemainingBudget,
      1,
      'active reply obligation must not consume mainline Diligence Push budget',
    );
    assert.equal(
      scheduled.length,
      1,
      'plain answer with reply obligation should schedule reminder',
    );
    assert.equal(
      scheduled[0]?.driveOptions?.businessContinuation?.kind,
      'inter_dialog_reply',
      'reply reminder follow-up should carry the reply obligation continuation',
    );
    const queuedReminder = root.peekQueuedPrompt();
    assert.ok(queuedReminder, 'reply reminder should be queued durably before fallback');
    assert.equal(queuedReminder.kind, 'new_course_runtime_reply');
    assert.equal(queuedReminder.tellaskReplyDirective?.targetCallId, targetCallId);
    assert.equal(
      isReplyToolReminderPromptContent(queuedReminder.prompt),
      true,
      'first plain answer should queue a reply-tool reminder, not direct fallback immediately',
    );
    assert.equal(
      findTellaskBackResult(root.msgs, targetCallId),
      undefined,
      'first plain answer must not direct-fallback before the reminder generation',
    );

    await executeDriveRound({
      runtime: createKernelDriverRuntimeState(),
      driveArgs: [
        root,
        scheduled[0]?.humanPrompt,
        scheduled[0]?.waitInQue ?? true,
        scheduled[0]?.driveOptions ??
          makeDriveOptions({ source: 'kernel_driver_follow_up', reason: 'follow_up_prompt' }),
      ],
      scheduleDrive: (_scheduledDialog, options) => {
        assert.notEqual(
          options.driveOptions?.businessContinuation?.kind,
          'inter_dialog_reply',
          'direct fallback should not schedule another reply reminder',
        );
      },
      driveDialog: async () => {},
    });

    await waitFor(
      async () => findTellaskBackResult(root.msgs, targetCallId) !== undefined,
      3_000,
      'mainline ask-back direct fallback result',
    );
    assert.equal(
      findTellaskBackResult(root.msgs, targetCallId)?.content,
      expectedDirectFallbackResult,
      'after the reminder, a second plain answer should use direct fallback',
    );
    assert.equal(
      await DialogPersistence.loadActiveTellaskReplyObligation(root.id, root.status),
      undefined,
      'direct fallback should clear the active reply obligation',
    );
    const events = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    assert.equal(
      events.some(
        (event) => event.type === 'prompting_msg_record' && event.origin === 'diligence_push',
      ),
      false,
      'mainline active reply obligation should not insert a Diligence Push prompt',
    );
  });

  console.log('kernel-driver mainline-reply-obligation-reminder-direct-fallback: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `kernel-driver mainline-reply-obligation-reminder-direct-fallback: FAIL\n${message}`,
  );
  process.exit(1);
});
