import assert from 'node:assert/strict';

import type { TellaskResultRecord } from '@longrun-ai/kernel/types/storage';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { supplySideDialogResponseToAssignedAskerIfPendingV2 } from '../../main/llm/kernel-driver/sideDialog';
import { DialogPersistence } from '../../main/persistence';
import { formatAssignmentFromAskerDialog } from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage } from '../../main/runtime/work-language';
import { recordDialogEvents } from '../helpers/dialog-events';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

import {
  createMainDialog,
  waitForAllDialogsUnlocked,
  withTempRtws,
  wrapPromptWithExpectedReplyTool,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector('dominds-waiting-assignment-update-');

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    const language = getWorkLanguage();
    const sessionSlug = 'sticky-session';
    const initialTrigger = 'Start the registered side dialog.';
    const initialBody = 'assignment-data-old-62ab';
    const updatedBody = 'assignment-data-new-73bc';
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
              tellaskContent: updatedBody,
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

    const beforeUpdate = await DialogPersistence.loadDialogLatest(sideDialog.id, sideDialog.status);
    assert.equal(
      beforeUpdate?.userWait?.kind,
      'awaiting_user_answer',
      'the replacement scenario genuinely starts with a human-blocked worker',
    );
    const recorder = recordDialogEvents(root);
    {
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
    }
    const liveEvents = await recorder.finish();
    const liveLinks = liveEvents
      .filter((event) => event.type === 'tellask_callee_evt')
      .filter(
        (event) =>
          event.callId === 'call-updated-round' && event.calleeDialogId === sideDialog.id.selfId,
      );
    assert.ok(
      liveLinks.length >= 2,
      'requester observes the reused dialog link and the later assignment anchor',
    );
    const sideDialogEventsAfterUpdate = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    const replacementInputs = sideDialogEventsAfterUpdate
      .filter((event) => event.type === 'human_text_record')
      .filter((event) => event.tellaskReplyDirective?.targetCallId === 'call-updated-round');
    assert.equal(replacementInputs.length, 1);
    assert.ok(
      replacementInputs[0].content.includes(updatedBody),
      'the supplied replacement payload is actually rendered',
    );
    const newAnchor = sideDialogEventsAfterUpdate
      .filter((event) => event.type === 'tellask_anchor_record')
      .find((event) => event.anchorRole === 'assignment' && event.callId === 'call-updated-round');
    assert.ok(newAnchor);
    assert.ok(newAnchor.genseq > 1, 'the stale reply generation precedes the rendered replacement');
    assert.ok(
      liveLinks.some(
        (event) =>
          event.calleeCourse === sideDialog.currentCourse &&
          event.calleeGenseq === newAnchor.genseq,
      ),
    );
    assert.ok(
      sideDialogEventsAfterUpdate.some(
        (event) =>
          event.type === 'tellask_anchor_record' &&
          event.anchorRole === 'assignment' &&
          event.callId === 'call-updated-round',
      ),
      'expected updated assignment anchor to be persisted for the replacement round',
    );

    const pendingAfterUpdate = await DialogPersistence.loadActiveCalleeDispatches(
      root.id,
      root.status,
    );
    assert.equal(
      pendingAfterUpdate.length,
      1,
      'expected updated registered tellask to replace pending',
    );
    assert.deepEqual(
      pendingAfterUpdate.map((record) => record.callId),
      ['call-updated-round'],
      'new registered assignment should replace the old pending round for the same sessionSlug',
    );
    const visibleRemindersAfterUpdate = await root.listVisibleReminders();
    const pendingReminderAfterUpdate = visibleRemindersAfterUpdate.find(
      (reminder) => reminder.owner?.name === 'pendingTellask',
    );
    assert.ok(
      pendingReminderAfterUpdate,
      'expected pending tellask reminder after registered update',
    );
    assert.equal(
      pendingReminderAfterUpdate.content.includes(initialBody),
      false,
      'pending tellask reminder should not show the replaced assignment',
    );
    assert.equal(
      pendingReminderAfterUpdate.content.includes(updatedBody),
      true,
      'pending tellask reminder should show the latest assignment',
    );

    const rootEventsAfterUpdate = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const updatedRoundCalleeRecords = rootEventsAfterUpdate
      .filter((event) => event.type === 'tellask_callee_record')
      .filter(
        (event) =>
          event.callId === 'call-updated-round' && event.calleeDialogId === sideDialog.id.selfId,
      );
    assert.equal(
      updatedRoundCalleeRecords.length >= 2,
      true,
      'registered update should persist requester call-site callee dialog link for replay',
    );
    assert.ok(
      updatedRoundCalleeRecords.some(
        (event) =>
          typeof event.calleeCourse === 'number' &&
          event.calleeCourse > 0 &&
          typeof event.calleeGenseq === 'number' &&
          event.calleeGenseq > 0,
      ),
      'registered update should persist requester-side callee assignment genseq for replay',
    );
    const replacedRoundNotice = rootEventsAfterUpdate.find(
      (event): event is TellaskResultRecord =>
        event.type === 'tellask_result_record' && event.callId === 'call-initial-round',
    );
    assert.ok(
      replacedRoundNotice,
      'replaced registered tellask must leave a same-callId notice in tellasker history',
    );
    assert.equal(replacedRoundNotice.status, 'failed');
    evidence.record({
      id: 'human-blocked-assignment-replacement',
      scenario:
        'A registered worker is waiting on a real askHuman call when its requester replaces the assignment. The old call gets a canonical failed result and the new call remains pending; an old generation reply is rejected.',
      businessValue:
        'Explain supersession without losing the current requester call while the worker is human-blocked.',
      context: {
        language,
        oldCallId: 'call-initial-round',
        newCallId: 'call-updated-round',
        oldAssignmentPayload: initialBody,
        newAssignmentPayload: updatedBody,
        humanWaitBeforeUpdate: 'awaiting_user_answer',
      },
      reviewQuestions: [
        'Does the old-call notice correctly explain its superseded disposition and the current replacement without claiming the new assignment was completed?',
        'Does the actual replacement prompt tell the worker which requirement and reply responsibility now apply without reviving an old result?',
      ],
      actualText: JSON.stringify(
        {
          oldCallNotice: replacedRoundNotice.content,
          updatedAssignment: replacementInputs[0].content,
        },
        null,
        2,
      ),
    });
    const replacementRoute = replacedRoundNotice.route;
    assert.ok(replacementRoute, 'replacement notice should keep the callee dialog route');
    assert.equal(replacementRoute.calleeDialogId, sideDialog.id.selfId);
    assert.equal(
      replacementRoute.calleeCourse,
      undefined,
      'replacement notice itself must not deep-link to an assignment genseq',
    );
    assert.equal(
      replacementRoute.calleeGenseq,
      undefined,
      'replacement notice relies on the replacement call-site link to upgrade after the new assignment anchor',
    );

    const supplied = await supplySideDialogResponseToAssignedAskerIfPendingV2({
      sideDialog,
      responseText: 'Old reply that should not be delivered to the updated round.',
      responseGenseq: 1,
      scheduleDrive: async () => {},
    });
    assert.equal(
      supplied,
      false,
      'reply from the old generation stays local after a newer assignment is rendered',
    );

    const pendingAfterBlockedReply = await DialogPersistence.loadActiveCalleeDispatches(
      root.id,
      root.status,
    );
    assert.deepEqual(
      pendingAfterBlockedReply.map((record) => record.callId),
      ['call-updated-round'],
      'blocked stale response should not restore the replaced pending round',
    );

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
      'updated round must not receive the stale previous-generation candidate',
    );
  });

  await evidence.write();
  console.log('kernel-driver sideDialog-registered-update-replaces-pending-round: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver sideDialog-registered-update-replaces-pending-round: FAIL\n${message}`,
  );
  process.exit(1);
});
