import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { supplySubdialogResponseToAssignedCallerIfPendingV2 } from '../../main/llm/kernel-driver/subdialog';
import { DialogPersistence } from '../../main/persistence';
import { formatRegisteredTellaskCallerUpdateNotice } from '../../main/shared/i18n/driver-messages';
import { getWorkLanguage } from '../../main/shared/runtime-language';
import type { TellaskResponseRecord } from '../../main/shared/types/storage';
import {
  formatAssignmentFromSupdialog,
  formatTellaskResponseContent,
  formatUpdatedAssignmentFromSupdialog,
} from '../../main/shared/utils/inter-dialog-format';

import {
  createRootDialog,
  listTellaskResultContents,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createRootDialog('tester');
    root.disableDiligencePush = true;
    const language = getWorkLanguage();
    const sessionSlug = 'sticky-session';
    const initialTrigger = 'Start the registered sideline.';
    const initialBody = 'Initial assignment';
    const updatedTrigger = 'Update the registered sideline with newer requirements.';

    const initialAssignmentPrompt = formatAssignmentFromSupdialog({
      callName: 'tellask',
      fromAgentId: 'tester',
      toAgentId: 'pangu',
      mentionList: ['@pangu'],
      tellaskContent: initialBody,
      language,
      sessionSlug,
      collectiveTargets: ['pangu'],
    });

    await writeMockDb(tmpRoot, [
      {
        message: initialTrigger,
        role: 'user',
        response: 'Starting the sideline.',
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
            id: 'subdialog-q4h-blocker',
            name: 'askHuman',
            arguments: {
              tellaskContent: 'Please keep this sideline waiting for the updated request test.',
            },
          },
        ],
      },
      {
        message: updatedTrigger,
        role: 'user',
        response: 'Updating the sideline now.',
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

    const subdialog = root.lookupSubdialog('pangu', sessionSlug);
    assert.ok(subdialog, 'expected registered subdialog after the first tellask');

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
    const expectedReplacement = formatTellaskResponseContent({
      callName: 'tellask',
      responderId: 'pangu',
      requesterId: 'tester',
      mentionList: ['@pangu'],
      sessionSlug,
      tellaskContent: initialBody,
      responseBody: formatRegisteredTellaskCallerUpdateNotice(language),
      status: 'failed',
      language,
    });
    await waitFor(
      async () => listTellaskResultContents(root.msgs).includes(expectedReplacement),
      3_000,
      'caller replacement notice to land',
    );
    await waitForAllDialogsUnlocked(root, 3_000);

    const expectedUpdatedPrompt = formatUpdatedAssignmentFromSupdialog({
      callName: 'tellask',
      fromAgentId: 'tester',
      toAgentId: 'pangu',
      mentionList: ['@pangu'],
      sessionSlug,
      tellaskContent: 'Updated assignment',
      language,
      collectiveTargets: ['pangu'],
    });
    const subdialogEventsAfterUpdate = await DialogPersistence.loadCourseEvents(
      subdialog.id,
      subdialog.currentCourse,
      subdialog.status,
    );
    assert.ok(
      subdialogEventsAfterUpdate.some(
        (event) => event.type === 'human_text_record' && event.content === expectedUpdatedPrompt,
      ),
      'expected updated assignment to be rendered locally for the subdialog',
    );
    assert.ok(
      subdialogEventsAfterUpdate.some(
        (event) =>
          event.type === 'tellask_call_anchor_record' &&
          event.anchorRole === 'assignment' &&
          event.callId === 'call-updated-round',
      ),
      'expected updated assignment anchor to be persisted for the replacement round',
    );

    const pendingAfterUpdate = await DialogPersistence.loadPendingSubdialogs(root.id, root.status);
    assert.equal(pendingAfterUpdate.length, 1, 'expected exactly one pending round after update');
    assert.equal(pendingAfterUpdate[0]?.callId, 'call-updated-round');
    assert.ok(
      listTellaskResultContents(root.msgs).includes(expectedReplacement),
      'caller should receive the failed system result for the replaced round',
    );

    const supplied = await supplySubdialogResponseToAssignedCallerIfPendingV2({
      subdialog,
      responseText: 'Old reply that should not be delivered to the updated round.',
      responseGenseq: 1,
      scheduleDrive: async () => {},
    });
    assert.equal(
      supplied,
      false,
      'expected stale reply to stay local until the updated assignment is rendered',
    );

    const pendingAfterBlockedReply = await DialogPersistence.loadPendingSubdialogs(
      root.id,
      root.status,
    );
    assert.equal(
      pendingAfterBlockedReply[0]?.callId,
      'call-updated-round',
      'updated pending round should remain waiting after blocked stale reply',
    );

    const rootEvents = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const updatedRoundResponse = rootEvents.find(
      (event): event is TellaskResponseRecord =>
        event.type === 'tellask_response_record' && event.callId === 'call-updated-round',
    );
    assert.equal(
      updatedRoundResponse,
      undefined,
      'updated round should not receive a response before the updated assignment prompt lands locally',
    );
  });

  console.log('kernel-driver subdialog-registered-update-replaces-pending-round: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver subdialog-registered-update-replaces-pending-round: FAIL\n${message}`,
  );
  process.exit(1);
});
