import assert from 'node:assert/strict';

import { EndOfStream, type SubChan } from '@longrun-ai/kernel/evt';
import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import type { TellaskResultRecord } from '@longrun-ai/kernel/types/storage';
import { dialogEventRegistry } from '../../main/evt-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { supplySideDialogResponseToAssignedAskerIfPendingV2 } from '../../main/llm/kernel-driver/sideDialog';
import { DialogPersistence } from '../../main/persistence';
import { formatRegisteredTellaskTellaskerUpdateNotice } from '../../main/runtime/driver-messages';
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

async function waitForCalleeLinkEvent(args: {
  subChan: SubChan<TypedDialogEvent>;
  callId: string;
  calleeDialogId: string;
  requireAssignmentTarget?: boolean;
  timeoutMs: number;
}): Promise<TypedDialogEvent | null> {
  const deadline = Date.now() + args.timeoutMs;
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return null;
    const event = await Promise.race([
      args.subChan.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remainingMs)),
    ]);
    if (event === null || event === EndOfStream) return null;
    if (
      event.type === 'tellask_callee_evt' &&
      event.callId === args.callId &&
      event.calleeDialogId === args.calleeDialogId &&
      (!args.requireAssignmentTarget ||
        (typeof event.calleeCourse === 'number' &&
          event.calleeCourse > 0 &&
          typeof event.calleeGenseq === 'number' &&
          event.calleeGenseq > 0))
    ) {
      return event;
    }
  }
}

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

    const rootSubChan = dialogEventRegistry.createSubChan(root.id);
    try {
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
      assert.ok(
        await waitForCalleeLinkEvent({
          subChan: rootSubChan,
          callId: 'call-updated-round',
          calleeDialogId: sideDialog.id.selfId,
          timeoutMs: 1_000,
        }),
        'registered update should immediately link the new requester call-site to the reused callee dialog',
      );
      await waitForAllDialogsUnlocked(root, 3_000);
      assert.ok(
        await waitForCalleeLinkEvent({
          subChan: rootSubChan,
          callId: 'call-updated-round',
          calleeDialogId: sideDialog.id.selfId,
          requireAssignmentTarget: true,
          timeoutMs: 1_000,
        }),
        'registered update should notify the requester call-site with the reused callee assignment genseq before reply completion',
      );
    } finally {
      rootSubChan.cancel();
    }

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
          event.type === 'tellask_anchor_record' &&
          event.anchorRole === 'assignment' &&
          event.callId === 'call-updated-round',
      ),
      'expected updated assignment anchor to be persisted for the replacement round',
    );

    const pendingAfterUpdate = await DialogPersistence.loadPendingSideDialogs(root.id, root.status);
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
      pendingReminderAfterUpdate.content.includes('Initial assignment'),
      false,
      'pending tellask reminder should not show the replaced assignment',
    );
    assert.equal(
      pendingReminderAfterUpdate.content.includes('Updated assignment'),
      true,
      'pending tellask reminder should show the latest assignment',
    );

    const rootEventsAfterUpdate = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const updatedRoundCalleeRecords = rootEventsAfterUpdate.filter(
      (event) =>
        event.type === 'tellask_callee_record' &&
        event.callId === 'call-updated-round' &&
        event.calleeDialogId === sideDialog.id.selfId,
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
    assert.equal(
      replacedRoundNotice.content.includes(formatRegisteredTellaskTellaskerUpdateNotice(language)),
      true,
      'replacement notice should explain that the earlier tellask no longer needs waiting',
    );
    const replacementRoute = replacedRoundNotice.route;
    assert.ok(replacementRoute, 'replacement notice should keep the callee dialog route');
    assert.equal(replacementRoute.calleeDialogId, sideDialog.id.selfId);
    assert.equal(
      replacementRoute.calleeCourse,
      undefined,
      'replacement notice must not link to the old assignment genseq',
    );
    assert.equal(
      replacementRoute.calleeGenseq,
      undefined,
      'replacement notice must wait for the new assignment anchor before deep-linking to a genseq',
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
      'expected stale reply to stay local until the updated assignment is rendered',
    );

    const pendingAfterBlockedReply = await DialogPersistence.loadPendingSideDialogs(
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
