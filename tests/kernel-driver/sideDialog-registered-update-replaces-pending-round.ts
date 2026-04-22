import assert from 'node:assert/strict';

import type { TellaskResultRecord } from '@longrun-ai/kernel/types/storage';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { supplySideDialogResponseToAssignedCallerIfPendingV2 } from '../../main/llm/kernel-driver/sideDialog';
import { DialogPersistence } from '../../main/persistence';
import {
  formatAssignmentFromAskerDialog,
  formatUpdatedAssignmentFromAskerDialog,
} from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
  waitForAllDialogsUnlocked,
  withTempRtws,
  wrapPromptWithExpectedReplyTool,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    const language = getWorkLanguage();
    const sessionSlug = 'sticky-session';
    const initialTrigger = 'Start the registered side dialog.';
    const initialBody = 'Initial assignment';
    const updatedTrigger = 'Update the registered side dialog with newer requirements.';

    const initialAssignmentPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellask',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: ['@pangu'],
        tellaskContent: initialBody,
        language,
        sessionSlug,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellask',
      language,
    });

    await writeMockDb(tmpRoot, [
      {
        message: initialTrigger,
        role: 'user',
        response: 'Starting the side dialog.',
        funcCalls: [
          {
            id: 'call-initial-round',
            name: 'tellask',
            arguments: {
              targetAgentId: 'pangu',
              sessionSlug,
              tellaskContent: initialBody,
            },
          },
        ],
      },
      {
        message: initialAssignmentPrompt,
        role: 'user',
        response: 'I need an extra nudge before finishing.',
        funcCalls: [
          {
            id: 'sideDialog-q4h-blocker',
            name: 'askHuman',
            arguments: {
              tellaskContent: 'Please keep this side dialog waiting for the updated request test.',
            },
          },
        ],
      },
      {
        message: updatedTrigger,
        role: 'user',
        response: 'Updating the side dialog now.',
        funcCalls: [
          {
            id: 'call-updated-round',
            name: 'tellask',
            arguments: {
              targetAgentId: 'pangu',
              sessionSlug,
              tellaskContent: 'Updated assignment',
            },
          },
        ],
      },
    ]);

    await driveDialogStream(
      root,
      {
        content: initialTrigger,
        msgId: 'kernel-driver-registered-update-initial',
        grammar: 'markdown',
        origin: 'user',
      },
      true,
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const sideDialog = root.lookupSideDialog('pangu', sessionSlug);
    assert.ok(sideDialog, 'expected registered sideDialog after the first tellask');

    await driveDialogStream(
      root,
      {
        content: updatedTrigger,
        msgId: 'kernel-driver-registered-update-second',
        grammar: 'markdown',
        origin: 'user',
      },
      true,
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const expectedUpdatedPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatUpdatedAssignmentFromAskerDialog({
        callName: 'tellask',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: ['@pangu'],
        sessionSlug,
        tellaskContent: 'Updated assignment',
        language,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellask',
      language,
    });
    const sideDialogEventsAfterUpdate = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    assert.ok(
      sideDialogEventsAfterUpdate.some(
        (event) =>
          event.type === 'human_text_record' &&
          event.content.trim() === expectedUpdatedPrompt.trim(),
      ),
      'expected updated assignment to be rendered locally for the sideDialog',
    );
    assert.ok(
      sideDialogEventsAfterUpdate.some(
        (event) =>
          event.type === 'tellask_call_anchor_record' &&
          event.anchorRole === 'assignment' &&
          event.callId === 'call-updated-round',
      ),
      'expected updated assignment anchor to be persisted for the replacement round',
    );

    const pendingAfterUpdate = await DialogPersistence.loadPendingSideDialogs(root.id, root.status);
    assert.equal(pendingAfterUpdate.length, 2, 'expected stacked pending rounds after update');
    assert.deepEqual(
      pendingAfterUpdate.map((record) => record.callId).sort(),
      ['call-initial-round', 'call-updated-round'],
      'new registered assignment should push onto the reply stack instead of replacing the old round',
    );

    const supplied = await supplySideDialogResponseToAssignedCallerIfPendingV2({
      sideDialog,
      responseText: 'Old reply that should not be delivered to the updated round.',
      responseGenseq: 1,
      scheduleDrive: async () => {},
    });
    assert.equal(
      supplied,
      false,
      'expected stale reply to stay local until the updated assignment is rendered',
    );

    const pendingAfterBlockedReply = await DialogPersistence.loadPendingSideDialogs(
      root.id,
      root.status,
    );
    assert.equal(
      pendingAfterBlockedReply[0]?.callId,
      'call-initial-round',
      'earlier pending round should remain present while the newer stack top is blocked',
    );
    assert.equal(pendingAfterBlockedReply[1]?.callId, 'call-updated-round');

    const rootEvents = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const updatedRoundResponse = rootEvents.find(
      (event): event is TellaskResultRecord =>
        event.type === 'tellask_result_record' && event.callId === 'call-updated-round',
    );
    assert.equal(
      updatedRoundResponse,
      undefined,
      'updated round should not receive a response before the updated assignment prompt lands locally',
    );
  });

  console.log('kernel-driver sideDialog-registered-update-replaces-pending-round: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver sideDialog-registered-update-replaces-pending-round: FAIL\n${message}`,
  );
  process.exit(1);
});
