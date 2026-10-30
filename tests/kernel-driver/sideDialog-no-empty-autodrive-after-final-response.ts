import {
  toAskerCourseNumber,
  toAssignmentCourseNumber,
  toAssignmentGenerationSeqNumber,
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
  toCalleeGenerationSeqNumber,
  toDialogCourseNumber,
} from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';

import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { refreshRunControlProjectionFromPersistenceFacts } from '../../main/dialog-display-state';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import type { KernelDriverRuntimeSideDialogPrompt } from '../../main/llm/kernel-driver/types';
import { createKernelDriverRuntimeState } from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import { formatAssignmentFromAskerDialog } from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage } from '../../main/runtime/work-language';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

import {
  createMainDialog,
  hasPendingNextStepTriggers,
  lastAssistantSaying,
  makeDriveOptions,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  wrapPromptWithExpectedReplyTool,
  writeStandardMinds,
} from './helpers';

type CapturedScheduledDrive = Readonly<{
  dialogSelfId: string;
  hasHumanPrompt: boolean;
  reason: string;
}>;

function findLastMeaningfulTailEvent(
  events: Awaited<ReturnType<typeof DialogPersistence.loadCourseEvents>>,
): (typeof events)[number] | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event.type === 'tellask_reply_resolution_record' ||
      event.type === 'gen_finish_record' ||
      event.type === 'func_result_record'
    ) {
      continue;
    }
    return event;
  }
  return events[events.length - 1];
}

const evidence = semanticEvidenceCollector('dominds-finalized-work-');
const apiType = 'test-finalized-work';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, {
      includePangu: true,
      memberTools: ['env_get'],
      providerApiType: apiType,
    });

    const trigger = 'Trigger a registered side dialog and let it finish cleanly.';
    const tellaskBody = 'Please answer 1+1 with exactly `2`.';
    const sessionSlug = 'sticky-session';
    const language = getWorkLanguage();

    const sideDialogFinalResponse = 'reply-data-finalized-637d';
    const rootFinalResponse = 'root-data-finalized-748e';
    const dlg = await createMainDialog('tester');
    dlg.disableDiligencePush = true;

    let sessionlessId: string | undefined;
    const thinkingPayload = 'thinking-data-post-tool-859f';
    const generations = new Map<string, number>();
    const generator: LlmGenerator = {
      apiType,
      async genToReceiver(_provider, _agent, _system, _tools, request, _context, receiver) {
        const round = (generations.get(request.dialogSelfId) ?? 0) + 1;
        generations.set(request.dialogSelfId, round);
        if (request.dialogSelfId === sessionlessId) {
          if (round === 1)
            await receiver.funcCall(
              'sessionless-invalid-env-get',
              'env_get',
              JSON.stringify({ key: 'not-valid-key' }),
            );
          else {
            assert.equal(round, 2);
            await receiver.thinkingStart();
            await receiver.thinkingChunk(thinkingPayload);
            await receiver.thinkingFinish();
          }
        } else if (request.dialogSelfId === dlg.id.selfId) {
          if (round === 1)
            await receiver.funcCall(
              'root-call-pangu-sticky',
              'tellask',
              JSON.stringify({
                targetAgentId: 'pangu',
                sessionSlug,
                tellaskContent: tellaskBody,
              }),
            );
          else {
            assert.equal(round, 2);
            await receiver.sayingStart();
            await receiver.sayingChunk(rootFinalResponse);
            await receiver.sayingFinish();
          }
        } else if (round === 1) {
          await receiver.sayingStart();
          await receiver.sayingChunk(sideDialogFinalResponse);
          await receiver.sayingFinish();
        } else {
          assert.equal(round, 2);
          await receiver.funcCall(
            'finalized-reply-tool',
            'replyTellask',
            JSON.stringify({ replyContent: sideDialogFinalResponse }),
          );
        }
        return {
          usage: { kind: 'available', promptTokens: 100, completionTokens: 10, totalTokens: 110 },
          llmGenModel: 'default',
        };
      },
      async genMoreMessages() {
        throw new Error('streaming fixture only');
      },
    };
    registerLlmGenerator(generator);

    await driveDialogStream(
      dlg,
      makeUserPrompt(trigger, 'kernel-driver-sideDialog-no-empty-autodrive-after-final-response'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );
    await waitFor(
      async () => generations.get(dlg.id.selfId) === 2,
      3_000,
      'root to receive the formal finalized reply',
    );
    await waitForAllDialogsUnlocked(dlg, 3_000);
    assert.equal(lastAssistantSaying(dlg), rootFinalResponse);

    const rootResults = (
      await DialogPersistence.loadCourseEvents(dlg.id, dlg.currentCourse, dlg.status)
    )
      .filter((event) => event.type === 'tellask_result_record')
      .filter((event) => event.callId === 'root-call-pangu-sticky');
    assert.equal(rootResults.length, 1);
    assert.equal(rootResults[0].status, 'completed');
    assert.ok(rootResults[0].content.includes(sideDialogFinalResponse));
    const sideDialog = dlg.lookupSideDialog('pangu', sessionSlug);
    assert.ok(sideDialog, 'expected registered sideDialog to exist after tellask completion');

    const eventsBefore = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    const genStartCountBefore = eventsBefore.filter(
      (event) => event.type === 'gen_start_record',
    ).length;
    const lastEventBefore = findLastMeaningfulTailEvent(eventsBefore);
    assert.ok(
      lastEventBefore?.type === 'tellask_anchor_record' &&
        lastEventBefore.anchorRole === 'response',
      'expected sideDialog to end its finalized round at a response anchor',
    );
    await DialogPersistence.mutateDialogLatest(sideDialog.id, () => ({
      kind: 'patch',
      patch: {
        generating: true,
        nextStep: {
          nextSeq: 2,
          triggers: [
            {
              triggerId: 'stale-final-response-followup',
              kind: 'followup',
              sourceGeneration: {
                course: toDialogCourseNumber(sideDialog.currentCourse),
                genseq: toCallSiteGenseqNo(1),
              },
              reasons: [{ kind: 'runtime_guidance', msgId: 'stale-final-response-guidance' }],
              createdAt: new Date().toISOString(),
              seq: 1,
            },
          ],
        },
        displayState: { kind: 'proceeding' },
        executionMarker: undefined,
      },
    }));
    await DialogPersistence.setActiveTellaskReplyObligation(
      sideDialog.id,
      {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: dlg.id.selfId,
        targetCallId: 'root-call-pangu-sticky',
        tellaskContent: tellaskBody,
      },
      sideDialog.status,
    );

    await driveDialogStream(
      sideDialog,
      undefined,
      true,
      makeDriveOptions({
        suppressDiligencePush: true,
        source: 'unspecified',
        reason: 'stale_auto_drive_probe',
      }),
    );
    await waitForAllDialogsUnlocked(dlg, 3_000);

    const eventsAfter = await DialogPersistence.loadCourseEvents(
      sideDialog.id,
      sideDialog.currentCourse,
      sideDialog.status,
    );
    const genStartCountAfter = eventsAfter.filter(
      (event) => event.type === 'gen_start_record',
    ).length;
    const lastEventAfter = findLastMeaningfulTailEvent(eventsAfter);

    assert.equal(
      genStartCountAfter,
      genStartCountBefore,
      'stale queued auto-drive must not open a new generation after final response anchor',
    );
    assert.deepEqual(
      lastEventAfter,
      lastEventBefore,
      'stale queued auto-drive must leave the finalized sideDialog tail untouched',
    );
    const latestAfter = await DialogPersistence.loadDialogLatest(sideDialog.id, sideDialog.status);
    assert.equal(
      latestAfter?.generating,
      false,
      'stale queued auto-drive should clear stale sideDialog generating after final response anchor',
    );
    assert.equal(
      hasPendingNextStepTriggers(latestAfter),
      false,
      'stale queued auto-drive should clear stale sideDialog pending next-step triggers after final response anchor',
    );
    assert.deepEqual(
      latestAfter?.displayState,
      { kind: 'idle_waiting_user' },
      'stale queued auto-drive should clear stale final-response interruption projection',
    );
    assert.equal(latestAfter?.executionMarker, undefined);
    assert.equal(
      await DialogPersistence.loadActiveTellaskReplyObligation(sideDialog.id, sideDialog.status),
      undefined,
      'stale queued auto-drive final-response cleanup should clear matching active reply obligation',
    );

    await DialogPersistence.setActiveTellaskReplyObligation(
      sideDialog.id,
      {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: dlg.id.selfId,
        targetCallId: 'root-call-pangu-sticky',
        tellaskContent: tellaskBody,
      },
      sideDialog.status,
    );
    await DialogPersistence.mutateDialogLatest(sideDialog.id, () => ({
      kind: 'patch',
      patch: {
        displayState: {
          kind: 'stopped',
          reason: { kind: 'pending_reply_obligation' },
          continueEnabled: true,
        },
        executionMarker: {
          kind: 'interrupted',
          reason: { kind: 'pending_reply_obligation' },
        },
      },
    }));

    const healedAfterRestart = await refreshRunControlProjectionFromPersistenceFacts(
      sideDialog.id,
      'run_control_snapshot',
    );
    assert.equal(
      await DialogPersistence.loadActiveTellaskReplyObligation(sideDialog.id, sideDialog.status),
      undefined,
      'final-response heal should clear stale active reply obligation matching the response anchor callId',
    );
    assert.deepEqual(
      healedAfterRestart?.displayState,
      { kind: 'idle_waiting_user' },
      'final-response heal should not leave a stale Continue button after clearing reply obligation',
    );
    assert.equal(
      healedAfterRestart?.executionMarker,
      undefined,
      'final-response heal should clear stale pending-reply execution marker',
    );

    await DialogPersistence.setActiveTellaskReplyObligation(
      sideDialog.id,
      {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: dlg.id.selfId,
        targetCallId: 'different-active-reply-call',
        tellaskContent: 'A distinct active reply must not be cleared by final-response healing.',
      },
      sideDialog.status,
    );
    await DialogPersistence.mutateDialogLatest(sideDialog.id, () => ({
      kind: 'patch',
      patch: {
        displayState: {
          kind: 'stopped',
          reason: { kind: 'pending_reply_obligation' },
          continueEnabled: true,
        },
        executionMarker: {
          kind: 'interrupted',
          reason: { kind: 'pending_reply_obligation' },
        },
      },
    }));

    const preservedAfterMismatchedHeal = await refreshRunControlProjectionFromPersistenceFacts(
      sideDialog.id,
      'run_control_snapshot',
    );
    const preservedObligation = await DialogPersistence.loadActiveTellaskReplyObligation(
      sideDialog.id,
      sideDialog.status,
    );
    assert.equal(
      preservedObligation?.targetCallId,
      'different-active-reply-call',
      'final-response heal must not clear an active reply obligation for another callId',
    );
    assert.deepEqual(
      preservedAfterMismatchedHeal?.displayState,
      { kind: 'proceeding' },
      'mismatched active reply obligation should keep the sideDialog driveable for the pending reply',
    );
    assert.equal(
      preservedAfterMismatchedHeal?.executionMarker,
      undefined,
      'mismatched active reply obligation should not keep a stale pending-reply interruption marker',
    );

    await DialogPersistence.updateSideDialogAssignment(sideDialog.id, {
      ...sideDialog.assignmentFromAsker,
      tellaskContent: 'Please answer the follow-up with exactly `4`.',
      callId: 'root-call-pangu-sticky-follow-up',
      callSiteGenseq: toCallSiteGenseqNo(2),
    });
    const latestAfterRegisteredUpdate = await DialogPersistence.loadDialogLatest(
      sideDialog.id,
      sideDialog.status,
    );
    assert.equal(
      latestAfterRegisteredUpdate?.sideDialogFinalResponse,
      undefined,
      'registered assignment update should clear the old final-response projection',
    );
    assert.equal(
      latestAfterRegisteredUpdate?.latestAssignmentAnchor,
      undefined,
      'registered assignment update should clear the old assignment anchor projection until the new prompt is consumed',
    );

    const recoveryOpenedAt = formatUnifiedTimestamp(new Date());
    await DialogPersistence.mutateDialogLatest(sideDialog.id, () => ({
      kind: 'patch',
      patch: {
        generating: true,
        displayState: { kind: 'proceeding' },
        executionMarker: undefined,
        generationRunState: {
          kind: 'open',
          course: toDialogCourseNumber(sideDialog.currentCourse),
          genseq: toCallSiteGenseqNo(27),
          phase: 'streaming',
          acceptedTriggerIds: [],
          openedAt: recoveryOpenedAt,
        },
        nextStep: {
          nextSeq: 28,
          triggers: [
            {
              triggerId: `open-generation-recovery:${sideDialog.id.selfId}:${sideDialog.currentCourse}:27`,
              kind: 'open_generation_recovery',
              course: toDialogCourseNumber(sideDialog.currentCourse),
              genseq: toCallSiteGenseqNo(27),
              createdAt: recoveryOpenedAt,
              seq: 27,
            },
          ],
        },
        latestAssignmentAnchor: {
          callId: 'root-call-pangu-sticky-follow-up',
          assignmentCourse: toAssignmentCourseNumber(sideDialog.currentCourse),
          assignmentGenseq: toAssignmentGenerationSeqNumber(20),
        },
        sideDialogFinalResponse: {
          callId: 'root-call-pangu-sticky',
          responseCourse: toDialogCourseNumber(sideDialog.currentCourse),
          responseGenseq: toCalleeGenerationSeqNumber(1),
          askerDialogId: dlg.id.selfId,
          askerCourse: toAskerCourseNumber(dlg.currentCourse),
        },
      },
    }));
    const wakeQueueTargetsDuringLegacyRecovery =
      await DialogPersistence.loadWakeQueueTargetDialogIds(dlg.id, dlg.status);
    assert.ok(
      wakeQueueTargetsDuringLegacyRecovery.some(
        (dialogId) => dialogId.selfId === sideDialog.id.selfId,
      ),
      'open generation recovery must keep a reused registered sideDialog in Wake Queue even with an old final-response projection',
    );
    await DialogPersistence.mutateDialogLatest(sideDialog.id, () => ({
      kind: 'patch',
      patch: {
        generating: false,
        generationRunState: undefined,
        nextStep: { nextSeq: 1, triggers: [] },
        sideDialogFinalResponse: undefined,
        displayState: { kind: 'idle_waiting_user' },
        executionMarker: undefined,
      },
    }));
    await DialogPersistence.removeWakeQueueEntriesForDialog(sideDialog.id, sideDialog.status);

    await DialogPersistence.mutateDialogLatest(sideDialog.id, () => ({
      kind: 'patch',
      patch: {
        generating: true,
        displayState: { kind: 'proceeding' },
        executionMarker: undefined,
        generationRunState: {
          kind: 'open',
          course: toDialogCourseNumber(sideDialog.currentCourse),
          genseq: toCallSiteGenseqNo(28),
          phase: 'streaming',
          acceptedTriggerIds: [],
          openedAt: recoveryOpenedAt,
        },
        nextStep: {
          nextSeq: 29,
          triggers: [
            {
              triggerId: `open-generation-recovery:${sideDialog.id.selfId}:${sideDialog.currentCourse}:28`,
              kind: 'open_generation_recovery',
              course: toDialogCourseNumber(sideDialog.currentCourse),
              genseq: toCallSiteGenseqNo(28),
              createdAt: recoveryOpenedAt,
              seq: 28,
            },
          ],
        },
        latestAssignmentAnchor: {
          callId: 'root-call-pangu-sticky',
          assignmentCourse: toAssignmentCourseNumber(sideDialog.currentCourse),
          assignmentGenseq: toAssignmentGenerationSeqNumber(1),
        },
        sideDialogFinalResponse: {
          callId: 'root-call-pangu-sticky',
          responseCourse: toDialogCourseNumber(sideDialog.currentCourse),
          responseGenseq: toCalleeGenerationSeqNumber(1),
          askerDialogId: dlg.id.selfId,
          askerCourse: toAskerCourseNumber(dlg.currentCourse),
        },
      },
    }));
    const wakeQueueTargetsDuringSameCallStaleRecovery =
      await DialogPersistence.loadWakeQueueTargetDialogIds(dlg.id, dlg.status);
    assert.equal(
      wakeQueueTargetsDuringSameCallStaleRecovery.some(
        (dialogId) => dialogId.selfId === sideDialog.id.selfId,
      ),
      false,
      'open generation recovery must not revive a same-call finalized sideDialog projection',
    );
    await DialogPersistence.mutateDialogLatest(sideDialog.id, () => ({
      kind: 'patch',
      patch: {
        generating: false,
        generationRunState: undefined,
        nextStep: { nextSeq: 1, triggers: [] },
        latestAssignmentAnchor: undefined,
        sideDialogFinalResponse: undefined,
        displayState: { kind: 'idle_waiting_user' },
        executionMarker: undefined,
      },
    }));

    const sessionlessRoot = await createMainDialog('tester');
    sessionlessRoot.disableDiligencePush = true;
    const sessionlessRequest = 'Clean up duplicate source files and continue validation.';
    const sessionlessSideDialog = await sessionlessRoot.createSideDialog(
      'pangu',
      ['@pangu'],
      sessionlessRequest,
      {
        callName: 'tellaskSessionless',
        originMemberId: 'tester',
        askerDialogId: sessionlessRoot.id.selfId,
        callId: 'sessionless-cleanup-call',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        collectiveTargets: ['pangu'],
      },
    );
    await DialogPersistence.saveActiveCalleeDispatches(sessionlessRoot.id, [
      {
        calleeDialogId: sessionlessSideDialog.id.selfId,
        createdAt: formatUnifiedTimestamp(new Date()),
        batchId: 'sessionless-cleanup-call-batch',
        callName: 'tellaskSessionless',
        mentionList: ['@pangu'],
        tellaskContent: sessionlessRequest,
        targetAgentId: 'pangu',
        callId: 'sessionless-cleanup-call',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        callType: 'C',
      },
    ]);
    const sessionlessPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellaskSessionless',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: ['@pangu'],
        tellaskContent: sessionlessRequest,
        language,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellaskSessionless',
      language,
    });
    sessionlessId = sessionlessSideDialog.id.selfId;
    const capturedScheduledDrives: CapturedScheduledDrive[] = [];
    await executeDriveRound({
      runtime: createKernelDriverRuntimeState(),
      driveArgs: [
        sessionlessSideDialog,
        {
          content: sessionlessPrompt,
          msgId: 'side-dialog-sessionless-reply-assignment',
          grammar: 'markdown',
          origin: 'runtime',
          tellaskReplyDirective: {
            expectedReplyCallName: 'replyTellaskSessionless',
            targetDialogId: sessionlessRoot.id.selfId,
            targetCallId: 'sessionless-cleanup-call',
            tellaskContent: sessionlessRequest,
          },
          calleeDialogReplyTarget: {
            callerDialogId: sessionlessRoot.id.selfId,
            callType: 'C',
            callId: 'sessionless-cleanup-call',
            callSiteCourse: toCallSiteCourseNo(1),
            callSiteGenseq: toCallSiteGenseqNo(1),
          },
        } satisfies KernelDriverRuntimeSideDialogPrompt,
        true,
        makeDriveOptions({
          suppressDiligencePush: true,
          source: 'kernel_driver_sideDialog_init',
          reason: 'sessionless_reply_tail_probe',
        }),
      ],
      scheduleDrive: (scheduledDialog, options) => {
        capturedScheduledDrives.push({
          dialogSelfId: scheduledDialog.id.selfId,
          hasHumanPrompt: options.humanPrompt !== undefined,
          reason: options.driveOptions?.reason ?? '',
        });
      },
      driveDialog: async () => {
        throw new Error('test does not use nested driveDialog invocations');
      },
    });

    assert.equal(capturedScheduledDrives.length, 1);
    const scheduled = capturedScheduledDrives[0];
    assert.ok(scheduled);
    const controlledEvents = await DialogPersistence.loadCourseEvents(
      sessionlessSideDialog.id,
      sessionlessSideDialog.currentCourse,
      sessionlessSideDialog.status,
    );
    const controlledThoughts = controlledEvents.filter(
      (event) => event.type === 'agent_thought_record',
    );
    assert.equal(controlledThoughts.at(-1)?.content, thinkingPayload);
    const actualInvalidToolResult = controlledEvents
      .filter((event) => event.type === 'func_result_record')
      .find((event) => event.id === 'sessionless-invalid-env-get');
    assert.ok(actualInvalidToolResult);
    assert.equal(actualInvalidToolResult.name, 'env_get');
    assert.equal(
      scheduled.dialogSelfId,
      sessionlessSideDialog.id.selfId,
      'sideDialog reply obligation should schedule the same dialog',
    );
    assert.equal(
      scheduled.hasHumanPrompt,
      false,
      'reply-obligation follow-up should be queued onto the dialog instead of passed as a fresh user prompt',
    );
    assert.equal(scheduled.reason, 'follow_up_prompt');
    const queuedReplyReminder = sessionlessSideDialog.peekQueuedPrompt();
    if (queuedReplyReminder?.kind !== 'new_course_runtime_sideDialog') {
      throw new Error('expected queued sideDialog runtime reply reminder');
    }
    assert.equal(
      queuedReplyReminder?.kind,
      'new_course_runtime_sideDialog',
      'reply-obligation tail resolution should persist a sideDialog runtime prompt',
    );
    assert.equal(
      queuedReplyReminder?.tellaskReplyDirective.targetCallId,
      'sessionless-cleanup-call',
      'queued reply reminder should carry the active reply obligation',
    );
    assert.equal(
      queuedReplyReminder?.calleeDialogReplyTarget.callId,
      'sessionless-cleanup-call',
      'queued reply reminder should target the pending tellask call',
    );
    evidence.record({
      id: 'thinking-after-failed-tool-keeps-reply',
      scenario:
        'A real env_get call with an invalid key returned; the executor then produced only controlled thinking. The runtime queued the still-pending requester reply on this side dialog.',
      businessValue:
        'A post-tool thought must not silently complete requester work or become an unnecessary manual Continue.',
      context: {
        language,
        targetCallId: 'sessionless-cleanup-call',
        expectedReplyTool: 'replyTellaskSessionless',
        thinkingPayload,
      },
      reviewQuestions: [
        'Does the actual tool diagnostic and queued reminder accurately distinguish a failed tool, local thinking and the formal reply still owed to the requester?',
        'Does it give the executor a coherent next action without treating the old thought as successful delivery?',
      ],
      actualText: JSON.stringify(
        { failedToolResult: actualInvalidToolResult, queuedReminder: queuedReplyReminder.prompt },
        null,
        2,
      ),
    });
    assert.equal(
      sessionlessSideDialog.hasQueuedPrompt(),
      true,
      'reply-obligation follow-up should continue the normal business state machine without manual Continue',
    );

    const queuedReminderPrompt = queuedReplyReminder.prompt;
    const eventsBeforeStaleContinuation = await DialogPersistence.loadCourseEvents(
      sessionlessSideDialog.id,
      sessionlessSideDialog.currentCourse,
      sessionlessSideDialog.status,
    );
    const genStartCountBeforeStaleContinuation = eventsBeforeStaleContinuation.filter(
      (event) => event.type === 'gen_start_record',
    ).length;

    sessionlessSideDialog.assignmentFromAsker = {
      ...sessionlessSideDialog.assignmentFromAsker,
      callId: 'sessionless-cleanup-call-next',
      tellaskContent: 'A newer assignment replaced the previous cleanup request.',
    };
    await DialogPersistence.setActiveTellaskReplyObligation(
      sessionlessSideDialog.id,
      {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: sessionlessRoot.id.selfId,
        targetCallId: 'sessionless-cleanup-call-next',
        tellaskContent: 'A newer assignment replaced the previous cleanup request.',
      },
      sessionlessSideDialog.status,
    );

    await executeDriveRound({
      runtime: createKernelDriverRuntimeState(),
      driveArgs: [
        sessionlessSideDialog,
        undefined,
        true,
        makeDriveOptions({
          suppressDiligencePush: true,
          source: 'kernel_driver_follow_up',
          reason: 'follow_up_prompt',
        }),
      ],
      scheduleDrive: () => {
        throw new Error('stale reply-obligation continuation must not schedule another drive');
      },
      driveDialog: async () => {
        throw new Error('stale reply-obligation continuation must not invoke nested driveDialog');
      },
    });

    const latestAfterReplacedObligation = await DialogPersistence.loadDialogLatest(
      sessionlessSideDialog.id,
      sessionlessSideDialog.status,
    );
    const eventsAfterReplacedObligation = await DialogPersistence.loadCourseEvents(
      sessionlessSideDialog.id,
      sessionlessSideDialog.currentCourse,
      sessionlessSideDialog.status,
    );
    assert.equal(
      sessionlessSideDialog.hasQueuedPrompt(),
      false,
      'stale reply reminder should be removed from the in-memory queue after assignment callId changes',
    );
    assert.equal(
      latestAfterReplacedObligation?.pendingRuntimePrompt,
      undefined,
      'stale reply reminder should clear the persisted pending runtime prompt after assignment callId changes',
    );
    assert.equal(
      hasPendingNextStepTriggers(latestAfterReplacedObligation),
      false,
      'stale reply reminder should clear queued_prompt trigger after assignment callId changes',
    );
    assert.equal(
      eventsAfterReplacedObligation.filter((event) => event.type === 'gen_start_record').length,
      genStartCountBeforeStaleContinuation,
      'stale reply reminder must not open a generation after assignment callId changes',
    );

    const finalResponseStaleMsgId = 'sessionless-final-response-stale-reminder';
    await sessionlessSideDialog.queueRuntimeSideDialogPrompt({
      prompt: queuedReminderPrompt,
      msgId: finalResponseStaleMsgId,
      grammar: 'markdown',
      userLanguageCode: language,
      tellaskReplyDirective: {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: sessionlessRoot.id.selfId,
        targetCallId: 'sessionless-cleanup-call-next',
        tellaskContent: 'A newer assignment replaced the previous cleanup request.',
      },
      calleeDialogReplyTarget: {
        callerDialogId: sessionlessRoot.id.selfId,
        callType: 'C',
        callId: 'sessionless-cleanup-call-next',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(2),
      },
    });
    await DialogPersistence.mutateDialogLatest(sessionlessSideDialog.id, () => ({
      kind: 'patch',
      patch: {
        sideDialogFinalResponse: {
          callId: 'sessionless-cleanup-call-next',
          responseCourse: toDialogCourseNumber(sessionlessSideDialog.currentCourse),
          responseGenseq: toCalleeGenerationSeqNumber(1),
          askerDialogId: sessionlessRoot.id.selfId,
          askerCourse: toAskerCourseNumber(sessionlessRoot.currentCourse),
        },
      },
    }));

    await executeDriveRound({
      runtime: createKernelDriverRuntimeState(),
      driveArgs: [
        sessionlessSideDialog,
        undefined,
        true,
        makeDriveOptions({
          suppressDiligencePush: true,
          source: 'kernel_driver_follow_up',
          reason: 'follow_up_prompt',
        }),
      ],
      scheduleDrive: () => {
        throw new Error('finalized stale reply-obligation continuation must not schedule a drive');
      },
      driveDialog: async () => {
        throw new Error(
          'finalized stale reply-obligation continuation must not invoke nested driveDialog',
        );
      },
    });
    const latestAfterFinalizedContinuation = await DialogPersistence.loadDialogLatest(
      sessionlessSideDialog.id,
      sessionlessSideDialog.status,
    );
    const eventsAfterFinalizedContinuation = await DialogPersistence.loadCourseEvents(
      sessionlessSideDialog.id,
      sessionlessSideDialog.currentCourse,
      sessionlessSideDialog.status,
    );
    assert.equal(
      sessionlessSideDialog.hasQueuedPrompt(),
      false,
      'finalized stale reply reminder should be removed from the in-memory queue',
    );
    assert.equal(
      latestAfterFinalizedContinuation?.pendingRuntimePrompt,
      undefined,
      'finalized stale reply reminder should clear the persisted pending runtime prompt',
    );
    assert.equal(
      hasPendingNextStepTriggers(latestAfterFinalizedContinuation),
      false,
      'finalized stale reply reminder should clear queued_prompt trigger',
    );
    assert.equal(
      eventsAfterFinalizedContinuation.filter((event) => event.type === 'gen_start_record').length,
      genStartCountBeforeStaleContinuation,
      'finalized stale reply reminder must not open a generation',
    );
  }).finally(() => unregisterLlmGenerator(apiType));
  await evidence.write();

  console.log('kernel-driver sideDialog-no-empty-autodrive-after-final-response: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver sideDialog-no-empty-autodrive-after-final-response: FAIL\n${message}`,
  );
  process.exit(1);
});
