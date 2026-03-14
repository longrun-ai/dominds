import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
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
    const updatedTrigger = 'Update the registered sideline while it is still running.';
    const updatedBody = 'Updated assignment';

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
    const updatedAssignmentPrompt = formatUpdatedAssignmentFromSupdialog({
      callName: 'tellask',
      fromAgentId: 'tester',
      toAgentId: 'pangu',
      mentionList: ['@pangu'],
      tellaskContent: updatedBody,
      language,
      sessionSlug,
      collectiveTargets: ['pangu'],
    });
    const expectedUpdatedResult = formatTellaskResponseContent({
      callName: 'tellask',
      responderId: 'pangu',
      requesterId: 'tester',
      mentionList: ['@pangu'],
      tellaskContent: updatedBody,
      responseBody: 'Updated assignment adopted.',
      status: 'completed',
      language,
      sessionSlug,
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
        response: 'Still working through the initial assignment.',
        delayMs: 1_500,
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
              tellaskContent: updatedBody,
            },
          },
        ],
      },
      {
        message: updatedAssignmentPrompt,
        role: 'user',
        response: 'Updated assignment adopted.',
      },
      {
        message: expectedUpdatedResult,
        role: 'tool',
        response: 'Ack: updated result received.',
      },
    ]);

    await driveDialogStream(
      root,
      {
        content: initialTrigger,
        msgId: 'kernel-driver-registered-update-upnext-initial',
        grammar: 'markdown',
        origin: 'user',
      },
      true,
    );

    await waitFor(
      async () => {
        const subdialog = root.lookupSubdialog('pangu', sessionSlug);
        return subdialog !== undefined && subdialog.isLocked();
      },
      3_000,
      'registered subdialog to start running the initial assignment',
    );

    const subdialog = root.lookupSubdialog('pangu', sessionSlug);
    assert.ok(subdialog, 'expected registered subdialog after the first tellask');

    await driveDialogStream(
      root,
      {
        content: updatedTrigger,
        msgId: 'kernel-driver-registered-update-upnext-second',
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

    const pendingAfterUpdate = await DialogPersistence.loadPendingSubdialogs(root.id, root.status);
    assert.equal(pendingAfterUpdate.length, 1, 'expected exactly one pending round after update');
    assert.equal(pendingAfterUpdate[0]?.callId, 'call-updated-round');

    await waitFor(
      async () => {
        const subdialogEvents = await DialogPersistence.loadCourseEvents(
          subdialog.id,
          subdialog.currentCourse,
          subdialog.status,
        );
        return subdialogEvents.some(
          (event) =>
            event.type === 'human_text_record' &&
            event.content.trim() === updatedAssignmentPrompt.trim(),
        );
      },
      4_000,
      'updated assignment to be rendered after the active turn boundary',
    );
    await waitFor(
      async () => listTellaskResultContents(root.msgs).includes(expectedUpdatedResult),
      4_000,
      'updated assignment result to flow back to caller',
    );
    await waitForAllDialogsUnlocked(root, 6_000);

    const rootEvents = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const updatedRoundResponse = rootEvents.find(
      (event): event is TellaskResponseRecord =>
        event.type === 'tellask_response_record' && event.callId === 'call-updated-round',
    );
    assert.ok(updatedRoundResponse, 'expected updated round to receive the completed result');
  });

  console.log('kernel-driver subdialog-registered-update-queues-upnext: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver subdialog-registered-update-queues-upnext: FAIL\n${message}`);
  process.exit(1);
});
