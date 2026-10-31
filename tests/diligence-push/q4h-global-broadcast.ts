import type { DialogEvent } from '@longrun-ai/kernel/types/dialog';
import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';
import { requireRecordingGlobalDialogEventRecorder } from '../../main/bootstrap/global-dialog-event-broadcaster';
import { postDialogEvent, postDialogEventById } from '../../main/evt-registry';
import { recordDialogEvents } from '../helpers/dialog-events';
import { createMainDialog, withTempRtws } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async () => {
    const dialog = await createMainDialog();
    const identity = { selfId: dialog.id.selfId, rootId: dialog.id.rootId };
    const createdAt = '2026-01-29 00:00:01';
    const inputs: DialogEvent[] = [
      { type: 'dlg_display_state_evt', displayState: { kind: 'idle_waiting_user' } },
      {
        type: 'new_q4h_asked',
        question: {
          id: 'question-id-data',
          selfId: dialog.id.selfId,
          rootId: dialog.id.rootId,
          agentId: dialog.agentId,
          taskDocPath: dialog.taskDocPath,
          tellaskContent: 'question-body-data',
          askedAt: '2026-01-29 00:00:00',
          callId: 'question-call-data',
          callSiteRef: { course: 1, messageIndex: 1 },
        },
      },
      { type: 'q4h_answered', questionId: 'question-id-data', selfId: dialog.id.selfId },
      {
        type: 'sideDialog_created_evt',
        dialog: identity,
        timestamp: createdAt,
        course: 1,
        callerDialog: identity,
        sideDialog: { selfId: 'side-id-data', rootId: dialog.id.rootId },
        targetAgentId: 'worker',
        callName: 'tellaskSessionless',
        mentionList: ['@worker'],
        tellaskContent: 'assignment-body-data',
        rootSideDialogCount: 1,
        callerBackgroundCalleeDialogCount: 0,
        callerBackgroundFreshBootsReasoningCalleeCount: 0,
        sideDialogNode: {
          selfId: 'side-id-data',
          rootId: dialog.id.rootId,
          askerDialogId: dialog.id.selfId,
          agentId: 'worker',
          taskDocPath: dialog.taskDocPath,
          status: 'running',
          currentCourse: 1,
          createdAt,
          lastModified: createdAt,
          displayState: { kind: 'idle_waiting_user' },
          sessionSlug: 'session-data',
          assignmentFromAsker: {
            callName: 'tellaskSessionless',
            mentionList: ['@worker'],
            tellaskContent: 'assignment-body-data',
            originMemberId: dialog.agentId,
            askerDialogId: dialog.id.selfId,
            callId: 'assignment-call-data',
            callSiteCourse: toCallSiteCourseNo(1),
            callSiteGenseq: toCallSiteGenseqNo(1),
          },
        },
      },
      {
        type: 'dlg_background_callee_summary_evt',
        backgroundCalleeDialogCount: 0,
        backgroundFreshBootsReasoningCalleeCount: 0,
      },
    ];
    const expected = structuredClone(inputs);
    const recorder = requireRecordingGlobalDialogEventRecorder('global-forwarding-component');
    recorder.clear();
    const local = recordDialogEvents(dialog);
    for (const input of inputs) {
      if (input.type === 'q4h_answered') postDialogEventById(dialog.id, input);
      else postDialogEvent(dialog, input);
    }
    const global = recorder.snapshot();
    const localEvents = await local.finish();
    assert.deepEqual(
      localEvents.map((event) => event.type),
      ['dlg_display_state_evt'],
      'global-only events are not duplicated onto the local stream',
    );
    const forwarded = global.filter((event) => event.type !== 'dlg_touched_evt');
    assert.deepEqual(
      forwarded.map((event) => event.type),
      expected.slice(1).map((event) => event.type),
    );
    const all = [...localEvents, ...forwarded];
    const payload = (event: object) => ({ ...event, dialog: undefined, timestamp: undefined });
    for (const [index, wanted] of expected.entries()) {
      const actual = all[index];
      assert.ok(actual);
      assert.deepEqual(actual.dialog, identity);
      assert.ok(actual.timestamp.length > 0);
      if ('timestamp' in wanted) assert.equal(actual.timestamp, wanted.timestamp);
      assert.deepEqual(
        payload(actual),
        payload(wanted),
        'provided event data reaches the public destination intact',
      );
    }
    const touched = global.filter((event) => event.type === 'dlg_touched_evt');
    assert.deepEqual(
      touched.map((event) => event.sourceType),
      expected.map((event) => event.type),
    );
    assert.ok(
      touched.every(
        (event) =>
          event.dialog.selfId === identity.selfId && event.dialog.rootId === identity.rootId,
      ),
    );
  });
  console.log('public global event forwarding, payload fidelity and local de-duplication: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
