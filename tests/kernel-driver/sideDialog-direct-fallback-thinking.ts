import assert from 'node:assert/strict';

import {
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
  toDialogCourseNumber,
} from '@longrun-ai/kernel/types/storage';
import { DialogID, SideDialog, type MainDialog } from '../../main/dialog';
import { setDialogDisplayState } from '../../main/dialog-display-state';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import type { ChatMessage } from '../../main/llm/client';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import {
  createKernelDriverRuntimeState,
  type KernelDriverDriveCallOptions,
} from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

import {
  createMainDialog,
  makeDriveOptions,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

function findTellaskResult(
  msgs: readonly ChatMessage[],
  callId: string,
): Extract<ChatMessage, { type: 'tellask_result_msg' }> | undefined {
  return msgs.find(
    (msg): msg is Extract<ChatMessage, { type: 'tellask_result_msg' }> =>
      msg.type === 'tellask_result_msg' && msg.callId === callId,
  );
}

type ScheduledDrive = Readonly<{
  dialog: SideDialog;
  options: KernelDriverDriveCallOptions;
}>;

const evidence = semanticEvidenceCollector('dominds-direct-fallback-');
function recordReminder(id: string, queued: ReturnType<SideDialog['peekQueuedPrompt']>) {
  assert.ok(queued?.kind === 'new_course_runtime_sideDialog');
  evidence.record({
    id,
    scenario:
      'An executor still owes the original task reply after a round without an explicit reply tool.',
    businessValue:
      'Keep completion responsibility visible and permit necessary work before delivery.',
    context: { targetCallId: queued.tellaskReplyDirective.targetCallId },
    reviewQuestions: [
      'Does the actual reminder explain the pending obligation without assuming a finished answer or skipping necessary work?',
    ],
    actualText: queued.prompt,
  });
}
function recordResult(id: string, actualText: string, source: string) {
  evidence.record({
    id,
    scenario:
      'After a persisted one-time reply reminder, the provider still omits the required reply tool.',
    businessValue:
      'Preserve the existing bounded recovery path while making the source and limitations of the delivered candidate visible.',
    context: {
      source,
      completionBasis:
        'compatibility fallback; no independent proof that the candidate solves the assigned task',
    },
    reviewQuestions: [
      'Does the full result accurately disclose the one-time fallback and whether content came from saying or thinking?',
      'Does it avoid presenting internal thinking as an explicit tool-delivered answer?',
    ],
    actualText,
  });
}

async function assertFallbackClosed(
  root: MainDialog,
  callId: string,
  payload: string,
): Promise<void> {
  const side = root
    .getLoadedDialogTreeSnapshot()
    .find((dialog) => dialog instanceof SideDialog && dialog.assignmentFromAsker.callId === callId);
  assert.ok(side instanceof SideDialog);
  const events = await DialogPersistence.loadCourseEvents(root.id, root.currentCourse, root.status);
  const results = events
    .filter((event) => event.type === 'tellask_result_record')
    .filter((event) => event.callId === callId);
  assert.equal(results.length, 1, 'bounded recovery produces exactly one canonical caller result');
  assert.equal(results[0].status, 'completed');
  assert.ok(results[0].content.includes(payload));
  assert.equal(
    events.filter((event) => event.type === 'func_result_record' && event.id === callId).length,
    1,
    'the original function receipt is not duplicated',
  );
  assert.equal(
    await DialogPersistence.loadActiveTellaskReplyObligation(side.id, side.status),
    undefined,
  );
  assert.equal(
    (await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status)).filter(
      (dispatch) => dispatch.callId === callId,
    ).length,
    0,
  );
  const restored = await DialogPersistence.restoreDialog(root.id, root.status);
  assert.ok(restored);
  const projected = restored.messages
    .filter((message) => message.type === 'tellask_result_msg')
    .filter((message) => message.callId === callId);
  assert.equal(projected.length, 1);
  assert.equal(
    projected[0].content,
    results[0].content,
    'restore preserves the single canonical result bytes',
  );
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    const apiType = 'controlled-fallback';
    await writeStandardMinds(tmpRoot, {
      providerApiType: apiType,
      includePangu: true,
      extraMembers: ['coder'],
      memberTools: ['env_get'],
    });
    let root = await createMainDialog('tester');
    const triggerFirstThinkingOnly = 'first-thinking-input-data';
    const firstThinkingOnlyCallId = 'root-first-thinking';
    const firstThinkingOnlyBody = 'first-thinking-task-data';
    const firstThinkingOnlyPlanning = 'initial-thinking-data-01';
    const firstThinkingOnlyFallbackText = 'fallback-saying-data-02';
    const triggerThinkingOnly = 'thinking-only-input-data';
    const thinkingOnlyCallId = 'root-thinking-only';
    const thinkingOnlyBody = 'thinking-only-task-data';
    const thinkingOnlyText = 'fallback-thinking-data-03';
    const triggerSayingWins = 'saying-wins-input-data';
    const sayingWinsCallId = 'root-saying-wins';
    const sayingWinsBody = 'saying-wins-task-data';
    const sayingWinsThinking = 'private-thinking-data-04';
    const sayingWinsSaying = 'public-saying-data-05';
    const triggerReminderThenTool = 'reminder-tool-input-data';
    const reminderThenToolCallId = 'root-reminder-tool';
    const reminderThenToolBody = 'reminder-tool-task-data';
    const triggerThinkingThenTellask = 'thinking-delegation-input-data';
    const thinkingThenTellaskCallId = 'root-thinking-delegation';
    const thinkingThenTellaskBody = 'thinking-delegation-task-data';
    const nestedThinkingTellaskCallId = 'nested-thinking-delegation';
    const nestedThinkingTellaskBody = 'nested-task-data';
    const triggerToolThenPlainProgress = 'tool-progress-input-data';
    const toolThenPlainProgressCallId = 'root-tool-progress';
    const toolThenPlainProgressBody = 'tool-progress-task-data';
    const triggerDurableToolThenPlainProgress = 'durable-tool-progress-input-data';
    const durableToolThenPlainProgressCallId = 'root-durable-tool-progress';
    const durableToolThenPlainProgressBody = 'durable-tool-progress-task-data';
    const dispatches = new Map<string, { callId: string; agent: string; body: string }>([
      [
        'kernel-driver-sideDialog-first-thinking-only',
        { callId: firstThinkingOnlyCallId, agent: 'coder', body: firstThinkingOnlyBody },
      ],
      [
        'kernel-driver-sideDialog-reminder-then-tool',
        { callId: reminderThenToolCallId, agent: 'coder', body: reminderThenToolBody },
      ],
      [
        'kernel-driver-sideDialog-thinking-only-fallback',
        { callId: thinkingOnlyCallId, agent: 'pangu', body: thinkingOnlyBody },
      ],
      [
        'kernel-driver-sideDialog-saying-wins-fallback',
        { callId: sayingWinsCallId, agent: 'coder', body: sayingWinsBody },
      ],
      [
        'kernel-driver-sideDialog-thinking-then-tellask',
        { callId: thinkingThenTellaskCallId, agent: 'coder', body: thinkingThenTellaskBody },
      ],
      [
        'kernel-driver-sideDialog-tool-then-plain-progress',
        { callId: toolThenPlainProgressCallId, agent: 'coder', body: toolThenPlainProgressBody },
      ],
      [
        'kernel-driver-sideDialog-durable-tool-then-plain-progress',
        {
          callId: durableToolThenPlainProgressCallId,
          agent: 'coder',
          body: durableToolThenPlainProgressBody,
        },
      ],
    ]);
    const rounds = new Map<string, number>();
    const dispatched = new Set<string>();
    const generator: LlmGenerator = {
      apiType,
      async genMoreMessages() {
        throw new Error('streaming fixture only');
      },
      async genToReceiver(_provider, _agent, _system, _tools, request, context, receiver) {
        const say = async (content: string) => {
          await receiver.sayingStart();
          await receiver.sayingChunk(content);
          await receiver.sayingFinish();
        };
        const think = async (content: string) => {
          await receiver.thinkingStart();
          await receiver.thinkingChunk(content);
          await receiver.thinkingFinish();
        };
        if (request.dialogSelfId === root.id.selfId) {
          const input = [...context].reverse().find((message) => message.type === 'prompting_msg');
          const dispatch =
            input?.type === 'prompting_msg' ? dispatches.get(input.msgId) : undefined;
          if (dispatch && !dispatched.has(dispatch.callId)) {
            dispatched.add(dispatch.callId);
            await receiver.funcCall(
              dispatch.callId,
              'tellaskSessionless',
              JSON.stringify({ targetAgentId: dispatch.agent, tellaskContent: dispatch.body }),
            );
          } else await say('root-consumed-result-data-06');
        } else {
          const side = root
            .getLoadedDialogTreeSnapshot()
            .find((dialog) => dialog.id.selfId === request.dialogSelfId);
          assert.ok(side instanceof SideDialog);
          const callId = side.assignmentFromAsker.callId;
          const round = (rounds.get(callId) ?? 0) + 1;
          rounds.set(callId, round);
          if (callId === firstThinkingOnlyCallId) {
            assert.ok(round <= 2);
            if (round === 1) await think(firstThinkingOnlyPlanning);
            else await say(firstThinkingOnlyFallbackText);
          } else if (callId === thinkingOnlyCallId) {
            assert.ok(round <= 2);
            if (round === 1) await say('initial-saying-data-07');
            else await think(thinkingOnlyText);
          } else if (callId === sayingWinsCallId) {
            assert.ok(round <= 2);
            if (round === 1) await say('initial-saying-data-08');
            else {
              await think(sayingWinsThinking);
              await say(sayingWinsSaying);
            }
          } else if (callId === thinkingThenTellaskCallId) {
            assert.equal(round, 1);
            await think('delegation-thinking-data-09');
            await receiver.funcCall(
              nestedThinkingTellaskCallId,
              'tellaskSessionless',
              JSON.stringify({ targetAgentId: 'pangu', tellaskContent: nestedThinkingTellaskBody }),
            );
          } else if (callId === reminderThenToolCallId) {
            assert.ok(round <= 3);
            if (round === 1) await say('pre-tool-progress-data-10');
            else if (round === 2)
              await receiver.funcCall(
                'reminder-tool-probe',
                'env_get',
                JSON.stringify({ key: 'DOMINDS_FALLBACK_CONTROLLED' }),
              );
            else await say('post-tool-progress-data-11');
          } else {
            assert.ok(
              callId === toolThenPlainProgressCallId ||
                callId === durableToolThenPlainProgressCallId,
            );
            assert.ok(round <= (callId === durableToolThenPlainProgressCallId ? 3 : 2));
            if (round === 1)
              await receiver.funcCall(
                'coder-readonly-tool-then-plain-progress',
                'env_get',
                JSON.stringify({ key: 'DOMINDS_FALLBACK_CONTROLLED' }),
              );
            else await say('post-tool-progress-data-12');
          }
        }
        return { usage: { kind: 'unavailable' } };
      },
    };
    registerLlmGenerator(generator);
    try {
      root.disableDiligencePush = true;

      const scheduledFirstThinkingOnlyDrives: ScheduledDrive[] = [];
      await executeDriveRound({
        runtime: createKernelDriverRuntimeState(),
        driveArgs: [
          root,
          makeUserPrompt(triggerFirstThinkingOnly, 'kernel-driver-sideDialog-first-thinking-only'),
          true,
          makeDriveOptions({ suppressDiligencePush: true }),
        ],
        scheduleDrive: (dialog, options) => {
          assert.ok(dialog instanceof SideDialog, 'expected only sideDialog follow-up scheduling');
          scheduledFirstThinkingOnlyDrives.push({ dialog, options });
        },
        driveDialog: async () => {},
      });

      const firstThinkingOnlySideDialog = root
        .getLoadedDialogTreeSnapshot()
        .find(
          (dialog): dialog is SideDialog =>
            dialog instanceof SideDialog &&
            dialog.assignmentFromAsker.callId === firstThinkingOnlyCallId,
        );
      assert.ok(
        firstThinkingOnlySideDialog,
        'expected first-turn thinking-only side dialog to exist',
      );
      assert.equal(
        scheduledFirstThinkingOnlyDrives.length,
        1,
        'expected root drive to schedule the first-turn side dialog exactly once',
      );
      assert.equal(scheduledFirstThinkingOnlyDrives[0].dialog, firstThinkingOnlySideDialog);

      await executeDriveRound({
        runtime: createKernelDriverRuntimeState(),
        driveArgs: [
          firstThinkingOnlySideDialog,
          scheduledFirstThinkingOnlyDrives[0].options.humanPrompt!,
          scheduledFirstThinkingOnlyDrives[0].options.waitInQue,
          scheduledFirstThinkingOnlyDrives[0].options.driveOptions,
        ],
        scheduleDrive: (dialog, options) => {
          assert.equal(dialog, firstThinkingOnlySideDialog);
          scheduledFirstThinkingOnlyDrives.push({ dialog: firstThinkingOnlySideDialog, options });
        },
        driveDialog: async () => {},
      });

      const firstThinkingOnlyQueuedReminder = firstThinkingOnlySideDialog.peekQueuedPrompt();
      assert.equal(
        firstThinkingOnlyQueuedReminder?.kind,
        'new_course_runtime_sideDialog',
        'plain first-turn sideDialog reply must queue a durable reply reminder',
      );
      recordReminder('firstThinkingOnlyQueuedReminder', firstThinkingOnlyQueuedReminder);
      assert.equal(
        (await DialogPersistence.loadCourseEvents(root.id, root.currentCourse, root.status)).filter(
          (event) =>
            event.type === 'tellask_result_record' && event.callId === firstThinkingOnlyCallId,
        ).length,
        0,
        'the first reminder cannot itself deliver a result',
      );
      assert.equal(
        firstThinkingOnlyQueuedReminder.tellaskReplyDirective.targetCallId,
        firstThinkingOnlyCallId,
      );
      assert.equal(
        firstThinkingOnlyQueuedReminder.calleeDialogReplyTarget.callId,
        firstThinkingOnlyCallId,
      );
      const firstThinkingOnlyLatest = await DialogPersistence.loadDialogLatest(
        firstThinkingOnlySideDialog.id,
        firstThinkingOnlySideDialog.status,
      );
      assert.equal(
        firstThinkingOnlyLatest?.pendingRuntimePrompt?.msgId,
        firstThinkingOnlyQueuedReminder.msgId,
        'durable reply reminder should survive restore through latest.yaml',
      );
      assert.equal(
        firstThinkingOnlyLatest?.pendingRuntimePrompt?.content,
        firstThinkingOnlyQueuedReminder.prompt,
      );
      assert.equal(
        firstThinkingOnlyLatest.pendingRuntimePrompt?.calleeDialogReplyTarget?.callId,
        firstThinkingOnlyCallId,
      );
      globalDialogRegistry.unregister(root.id.rootId);
      const restoredRoot = await getOrRestoreMainDialog(root.id.rootId, root.status);
      assert.ok(restoredRoot, 'expected root to restore after durable reply reminder is queued');
      const restoredFirstThinkingOnlySideDialog = await ensureDialogLoaded(
        restoredRoot,
        new DialogID(firstThinkingOnlySideDialog.id.selfId, firstThinkingOnlySideDialog.id.rootId),
        firstThinkingOnlySideDialog.status,
      );
      assert.ok(
        restoredFirstThinkingOnlySideDialog instanceof SideDialog,
        'expected side dialog to restore after durable reply reminder is queued',
      );
      const restoredQueuedReminder = restoredFirstThinkingOnlySideDialog.peekQueuedPrompt();
      assert.ok(restoredQueuedReminder?.kind === 'new_course_runtime_sideDialog');
      assert.equal(
        restoredQueuedReminder?.msgId,
        firstThinkingOnlyQueuedReminder.msgId,
        'restore should rehydrate the durable reply reminder with the same msgId',
      );
      assert.equal(restoredQueuedReminder.prompt, firstThinkingOnlyQueuedReminder.prompt);
      assert.equal(
        restoredQueuedReminder.tellaskReplyDirective?.targetCallId,
        firstThinkingOnlyCallId,
      );
      assert.equal(
        scheduledFirstThinkingOnlyDrives.length,
        2,
        'expected durable reply reminder to schedule one business-continuation follow-up drive',
      );

      await executeDriveRound({
        runtime: createKernelDriverRuntimeState(),
        driveArgs: [
          restoredFirstThinkingOnlySideDialog,
          undefined,
          scheduledFirstThinkingOnlyDrives[1].options.waitInQue,
          scheduledFirstThinkingOnlyDrives[1].options.driveOptions ??
            makeDriveOptions({ source: 'kernel_driver_follow_up', reason: 'follow_up_prompt' }),
        ],
        scheduleDrive: () => {},
        driveDialog: async () => {},
      });
      await waitFor(
        async () => findTellaskResult(restoredRoot.msgs, firstThinkingOnlyCallId) !== undefined,
        3_000,
        'first-turn thinking-only direct fallback result',
      );
      await waitForAllDialogsUnlocked(restoredRoot, 3_000);

      const firstThinkingOnlyResult = findTellaskResult(restoredRoot.msgs, firstThinkingOnlyCallId);
      assert.ok(
        firstThinkingOnlyResult,
        'expected first-turn thinking-only direct fallback result',
      );
      assert.ok(
        firstThinkingOnlyResult.content.includes(firstThinkingOnlyFallbackText),
        'supplied opaque candidate is preserved',
      );
      recordResult('firstThinkingOnlyResult', firstThinkingOnlyResult.content, 'saying');
      await assertFallbackClosed(
        restoredRoot,
        firstThinkingOnlyCallId,
        firstThinkingOnlyFallbackText,
      );
      const firstThinkingOnlyLatestAfterFallback = await DialogPersistence.loadDialogLatest(
        restoredFirstThinkingOnlySideDialog.id,
        restoredFirstThinkingOnlySideDialog.status,
      );
      assert.equal(
        firstThinkingOnlyLatestAfterFallback?.pendingRuntimePrompt,
        undefined,
        'consumed durable reply reminder must be cleared after fallback',
      );
      root = restoredRoot;

      const scheduledReminderThenToolDrives: ScheduledDrive[] = [];
      await executeDriveRound({
        runtime: createKernelDriverRuntimeState(),
        driveArgs: [
          root,
          makeUserPrompt(triggerReminderThenTool, 'kernel-driver-sideDialog-reminder-then-tool'),
          true,
          makeDriveOptions({ suppressDiligencePush: true }),
        ],
        scheduleDrive: (dialog, options) => {
          assert.ok(
            dialog instanceof SideDialog,
            'expected reminder-then-tool sideDialog scheduling',
          );
          scheduledReminderThenToolDrives.push({ dialog, options });
        },
        driveDialog: async () => {},
      });
      const reminderThenToolSideDialog = root
        .getLoadedDialogTreeSnapshot()
        .find(
          (dialog): dialog is SideDialog =>
            dialog instanceof SideDialog &&
            dialog.assignmentFromAsker.callId === reminderThenToolCallId,
        );
      assert.ok(reminderThenToolSideDialog, 'expected reminder-then-tool side dialog to exist');
      assert.equal(
        scheduledReminderThenToolDrives.length,
        1,
        'root drive should schedule the reminder-then-tool side dialog once',
      );

      await executeDriveRound({
        runtime: createKernelDriverRuntimeState(),
        driveArgs: [
          reminderThenToolSideDialog,
          scheduledReminderThenToolDrives[0].options.humanPrompt!,
          scheduledReminderThenToolDrives[0].options.waitInQue,
          scheduledReminderThenToolDrives[0].options.driveOptions,
        ],
        scheduleDrive: (dialog, options) => {
          assert.equal(
            dialog,
            reminderThenToolSideDialog,
            'first plain progress should schedule the reminder-then-tool side dialog again',
          );
          scheduledReminderThenToolDrives.push({ dialog: reminderThenToolSideDialog, options });
        },
        driveDialog: async () => {},
      });
      const initialReminderThenToolReminder = reminderThenToolSideDialog.peekQueuedPrompt();
      assert.equal(
        initialReminderThenToolReminder?.kind,
        'new_course_runtime_sideDialog',
        'first plain progress must queue the reply reminder before fallback is allowed',
      );
      recordReminder('initialReminderThenToolReminder', initialReminderThenToolReminder);
      assert.equal(
        scheduledReminderThenToolDrives.length,
        2,
        'first reminder should schedule one follow-up drive',
      );

      await executeDriveRound({
        runtime: createKernelDriverRuntimeState(),
        driveArgs: [
          reminderThenToolSideDialog,
          undefined,
          scheduledReminderThenToolDrives[1].options.waitInQue,
          scheduledReminderThenToolDrives[1].options.driveOptions ??
            makeDriveOptions({ source: 'kernel_driver_follow_up', reason: 'follow_up_prompt' }),
        ],
        scheduleDrive: (dialog, options) => {
          assert.equal(
            dialog,
            reminderThenToolSideDialog,
            'post-tool progress after reminder should schedule another reminder drive',
          );
          scheduledReminderThenToolDrives.push({ dialog: reminderThenToolSideDialog, options });
        },
        driveDialog: async () => {},
      });
      assert.equal(
        findTellaskResult(root.msgs, reminderThenToolCallId),
        undefined,
        'a tool call after the reply reminder must reset direct-fallback eligibility',
      );
      const reminderThenToolReminderAfterTool = reminderThenToolSideDialog.peekQueuedPrompt();
      assert.equal(
        reminderThenToolReminderAfterTool?.kind,
        'new_course_runtime_sideDialog',
        'post-tool plain progress should remind again instead of direct-fallback delivery',
      );
      recordReminder('reminderThenToolReminderAfterTool', reminderThenToolReminderAfterTool);
      assert.equal(
        scheduledReminderThenToolDrives.length,
        3,
        'post-tool plain progress should schedule a fresh reply reminder follow-up',
      );

      const guardedPendingReplyCallId = 'root-call-coder-guarded-pending-reply';
      const guardedPendingReplyBody =
        'Please keep this active reply obligation explicit until normal business progress resolves it.';
      const guardedPendingReplySideDialog = await root.createSideDialog(
        'coder',
        ['@coder'],
        guardedPendingReplyBody,
        {
          callName: 'tellaskSessionless',
          originMemberId: 'tester',
          askerDialogId: root.id.selfId,
          callId: guardedPendingReplyCallId,
          callSiteCourse: toCallSiteCourseNo(1),
          callSiteGenseq: toCallSiteGenseqNo(1),
          collectiveTargets: ['coder'],
        },
      );
      const initialGuardedPendingReplyLatest = await DialogPersistence.loadDialogLatest(
        guardedPendingReplySideDialog.id,
        guardedPendingReplySideDialog.status,
      );
      assert.deepEqual(
        initialGuardedPendingReplyLatest?.displayState,
        { kind: 'proceeding' },
        'new sideDialogs with active reply obligations must start as driveable work',
      );
      assert.equal(
        initialGuardedPendingReplyLatest?.executionMarker,
        undefined,
        'new sideDialogs with reply obligations must not persist a resumable interruption marker',
      );
      assert.equal(
        (
          await DialogPersistence.loadActiveTellaskReplyObligation(
            guardedPendingReplySideDialog.id,
            guardedPendingReplySideDialog.status,
          )
        )?.targetCallId,
        guardedPendingReplyCallId,
        'new sideDialogs should still persist the active reply obligation as completion state',
      );
      await setDialogDisplayState(guardedPendingReplySideDialog.id, { kind: 'idle_waiting_user' });
      const latestAfterAttemptedIdle = await DialogPersistence.loadDialogLatest(
        guardedPendingReplySideDialog.id,
        guardedPendingReplySideDialog.status,
      );
      assert.deepEqual(
        latestAfterAttemptedIdle?.displayState,
        { kind: 'proceeding' },
        'display-state writer must reject idle while a sideDialog reply obligation is active',
      );
      assert.equal(
        latestAfterAttemptedIdle?.executionMarker,
        undefined,
        'display-state writer must not synthesize a pending-reply interruption marker',
      );
      await DialogPersistence.mutateDialogLatest(
        guardedPendingReplySideDialog.id,
        () => ({
          kind: 'patch',
          patch: {
            displayState: { kind: 'idle_waiting_user' },
            executionMarker: undefined,
          },
        }),
        guardedPendingReplySideDialog.status,
      );
      const latestAfterDirectIdleMutation = await DialogPersistence.loadDialogLatest(
        guardedPendingReplySideDialog.id,
        guardedPendingReplySideDialog.status,
      );
      assert.deepEqual(
        latestAfterDirectIdleMutation?.displayState,
        { kind: 'proceeding' },
        'latest.yaml mutation guard must reject idle while a sideDialog reply obligation is active',
      );
      assert.equal(
        latestAfterDirectIdleMutation?.executionMarker,
        undefined,
        'latest.yaml mutation guard must not synthesize a resumable pending-reply execution marker',
      );

      await driveDialogStream(
        root,
        makeUserPrompt(triggerThinkingOnly, 'kernel-driver-sideDialog-thinking-only-fallback'),
        true,
        makeDriveOptions({ suppressDiligencePush: true }),
      );
      await waitFor(
        async () => findTellaskResult(root.msgs, thinkingOnlyCallId) !== undefined,
        3_000,
        'thinking-only direct fallback result',
      );
      await waitForAllDialogsUnlocked(root, 3_000);

      const thinkingOnlyResult = findTellaskResult(root.msgs, thinkingOnlyCallId);
      assert.ok(thinkingOnlyResult, 'expected thinking-only direct fallback result');
      assert.ok(
        thinkingOnlyResult.content.includes(thinkingOnlyText),
        'supplied opaque candidate is preserved',
      );
      recordResult('thinkingOnlyResult', thinkingOnlyResult.content, 'thinking_only');
      await assertFallbackClosed(root, thinkingOnlyCallId, thinkingOnlyText);

      await driveDialogStream(
        root,
        makeUserPrompt(triggerSayingWins, 'kernel-driver-sideDialog-saying-wins-fallback'),
        true,
        makeDriveOptions({ suppressDiligencePush: true }),
      );
      await waitFor(
        async () => findTellaskResult(root.msgs, sayingWinsCallId) !== undefined,
        3_000,
        'saying direct fallback result',
      );
      await waitForAllDialogsUnlocked(root, 3_000);

      const sayingWinsResult = findTellaskResult(root.msgs, sayingWinsCallId);
      assert.ok(sayingWinsResult, 'expected saying direct fallback result');
      assert.ok(
        sayingWinsResult.content.includes(sayingWinsSaying),
        'supplied opaque candidate is preserved',
      );
      recordResult('sayingWinsResult', sayingWinsResult.content, 'saying');
      await assertFallbackClosed(root, sayingWinsCallId, sayingWinsSaying);
      assert.equal(
        sayingWinsResult.content.includes(sayingWinsThinking),
        false,
        'private controlled thinking is excluded when saying exists',
      );

      const scheduledThinkingThenTellaskDrives: ScheduledDrive[] = [];
      await executeDriveRound({
        runtime: createKernelDriverRuntimeState(),
        driveArgs: [
          root,
          makeUserPrompt(
            triggerThinkingThenTellask,
            'kernel-driver-sideDialog-thinking-then-tellask',
          ),
          true,
          makeDriveOptions({ suppressDiligencePush: true }),
        ],
        scheduleDrive: (dialog, options) => {
          assert.ok(dialog instanceof SideDialog, 'expected sideDialog scheduling');
          scheduledThinkingThenTellaskDrives.push({ dialog, options });
        },
        driveDialog: async () => {},
      });

      const thinkingThenTellaskSideDialog = root
        .getLoadedDialogTreeSnapshot()
        .find(
          (dialog): dialog is SideDialog =>
            dialog instanceof SideDialog &&
            dialog.assignmentFromAsker.callId === thinkingThenTellaskCallId,
        );
      assert.ok(
        thinkingThenTellaskSideDialog,
        'expected thinking-then-tellask side dialog to exist',
      );
      assert.equal(
        scheduledThinkingThenTellaskDrives.length,
        1,
        'root drive should schedule the thinking-then-tellask side dialog once',
      );

      await executeDriveRound({
        runtime: createKernelDriverRuntimeState(),
        driveArgs: [
          thinkingThenTellaskSideDialog,
          scheduledThinkingThenTellaskDrives[0].options.humanPrompt!,
          scheduledThinkingThenTellaskDrives[0].options.waitInQue,
          scheduledThinkingThenTellaskDrives[0].options.driveOptions,
        ],
        scheduleDrive: (dialog, options) => {
          assert.ok(
            dialog instanceof SideDialog,
            'expected nested sideDialog follow-up scheduling',
          );
          scheduledThinkingThenTellaskDrives.push({ dialog, options });
        },
        driveDialog: async () => {},
      });

      assert.equal(
        findTellaskResult(root.msgs, thinkingThenTellaskCallId),
        undefined,
        'thinking plus same-round tellask must not direct-fallback to the upstream tellasker',
      );
      assert.equal(
        thinkingThenTellaskSideDialog.peekQueuedPrompt(),
        undefined,
        'thinking plus same-round tellask must not queue a reply reminder while delegated work is pending',
      );
      const thinkingThenTellaskEvents = await DialogPersistence.loadCourseEvents(
        thinkingThenTellaskSideDialog.id,
        thinkingThenTellaskSideDialog.currentCourse,
        thinkingThenTellaskSideDialog.status,
      );
      assert.equal(
        thinkingThenTellaskEvents.filter((event) => event.type === 'gen_start_record').length,
        1,
        'nested pending tellask ack must not auto-drive the side dialog before the callee replies',
      );
      const pendingNested = await DialogPersistence.loadActiveCalleeDispatches(
        thinkingThenTellaskSideDialog.id,
        thinkingThenTellaskSideDialog.status,
      );
      assert.equal(
        pendingNested.length,
        1,
        'thinking plus same-round tellask should leave the side dialog waiting on delegated work',
      );
      assert.equal(pendingNested[0]?.callId, nestedThinkingTellaskCallId);

      const scheduledToolThenPlainProgressDrives: ScheduledDrive[] = [];
      await executeDriveRound({
        runtime: createKernelDriverRuntimeState(),
        driveArgs: [
          root,
          makeUserPrompt(
            triggerToolThenPlainProgress,
            'kernel-driver-sideDialog-tool-then-plain-progress',
          ),
          true,
          makeDriveOptions({ suppressDiligencePush: true }),
        ],
        scheduleDrive: (dialog, options) => {
          assert.ok(dialog instanceof SideDialog, 'expected sideDialog scheduling');
          scheduledToolThenPlainProgressDrives.push({ dialog, options });
        },
        driveDialog: async () => {},
      });

      const toolThenPlainProgressSideDialog = root
        .getLoadedDialogTreeSnapshot()
        .find(
          (dialog): dialog is SideDialog =>
            dialog instanceof SideDialog &&
            dialog.assignmentFromAsker.callId === toolThenPlainProgressCallId,
        );
      assert.ok(
        toolThenPlainProgressSideDialog,
        'expected tool-then-plain-progress side dialog to exist',
      );
      assert.equal(
        scheduledToolThenPlainProgressDrives.length,
        1,
        'root drive should schedule the tool-then-plain-progress side dialog once',
      );

      await executeDriveRound({
        runtime: createKernelDriverRuntimeState(),
        driveArgs: [
          toolThenPlainProgressSideDialog,
          scheduledToolThenPlainProgressDrives[0].options.humanPrompt!,
          scheduledToolThenPlainProgressDrives[0].options.waitInQue,
          scheduledToolThenPlainProgressDrives[0].options.driveOptions,
        ],
        scheduleDrive: (dialog, options) => {
          assert.equal(
            dialog,
            toolThenPlainProgressSideDialog,
            'plain post-tool sideDialog progress should schedule the same side dialog',
          );
          scheduledToolThenPlainProgressDrives.push({
            dialog: toolThenPlainProgressSideDialog,
            options,
          });
        },
        driveDialog: async () => {},
      });

      const queuedToolThenPlainProgressReminder =
        toolThenPlainProgressSideDialog.peekQueuedPrompt();
      assert.equal(
        queuedToolThenPlainProgressReminder?.kind,
        'new_course_runtime_sideDialog',
        'plain post-tool sideDialog progress must queue a durable reply reminder',
      );
      recordReminder('queuedToolThenPlainProgressReminder', queuedToolThenPlainProgressReminder);
      assert.equal(
        queuedToolThenPlainProgressReminder.tellaskReplyDirective.targetCallId,
        toolThenPlainProgressCallId,
      );
      assert.equal(
        scheduledToolThenPlainProgressDrives.length,
        2,
        'plain post-tool sideDialog progress should schedule one reply reminder follow-up',
      );

      const durableScheduledInitialDrives: ScheduledDrive[] = [];
      await executeDriveRound({
        runtime: createKernelDriverRuntimeState(),
        driveArgs: [
          root,
          makeUserPrompt(
            triggerDurableToolThenPlainProgress,
            'kernel-driver-sideDialog-durable-tool-then-plain-progress',
          ),
          true,
          makeDriveOptions({ suppressDiligencePush: true }),
        ],
        scheduleDrive: (dialog, options) => {
          assert.ok(dialog instanceof SideDialog, 'expected durable sideDialog scheduling');
          durableScheduledInitialDrives.push({ dialog, options });
        },
        driveDialog: async () => {},
      });
      const durableToolThenPlainProgressSideDialog = root
        .getLoadedDialogTreeSnapshot()
        .find(
          (dialog): dialog is SideDialog =>
            dialog instanceof SideDialog &&
            dialog.assignmentFromAsker.callId === durableToolThenPlainProgressCallId,
        );
      assert.ok(
        durableToolThenPlainProgressSideDialog,
        'expected durable tool-then-plain-progress side dialog to exist',
      );
      assert.equal(
        durableScheduledInitialDrives.length,
        1,
        'root drive should schedule the durable tool-then-plain-progress side dialog once',
      );

      await executeDriveRound({
        runtime: createKernelDriverRuntimeState(),
        driveArgs: [
          durableToolThenPlainProgressSideDialog,
          durableScheduledInitialDrives[0].options.humanPrompt!,
          durableScheduledInitialDrives[0].options.waitInQue,
          durableScheduledInitialDrives[0].options.driveOptions,
        ],
        scheduleDrive: () => {},
        driveDialog: async () => {},
      });

      const removedDurableReminder = durableToolThenPlainProgressSideDialog.takeQueuedPrompt();
      assert.equal(
        removedDurableReminder?.kind,
        'new_course_runtime_sideDialog',
        'durable setup should normally queue a reply reminder before simulated restore',
      );
      await DialogPersistence.clearPendingRuntimePrompt(
        durableToolThenPlainProgressSideDialog.id,
        removedDurableReminder.msgId,
        durableToolThenPlainProgressSideDialog.status,
      );
      const durableContinuationCourse = durableToolThenPlainProgressSideDialog.currentCourse;
      const durableContinuationGenseq =
        durableToolThenPlainProgressSideDialog.activeGenSeqOrUndefined;
      assert.equal(
        typeof durableContinuationGenseq,
        'number',
        'expected durable setup generation sequence',
      );
      await DialogPersistence.upsertNextStepTrigger(
        durableToolThenPlainProgressSideDialog.id,
        {
          triggerId: `followup:c${String(durableContinuationCourse)}:g${String(durableContinuationGenseq)}`,
          kind: 'followup',
          sourceGeneration: {
            course: toDialogCourseNumber(durableContinuationCourse),
            genseq: toCallSiteGenseqNo(durableContinuationGenseq!),
          },
          reasons: [
            { kind: 'ordinary_tool_result', callIds: ['coder-readonly-tool-then-plain-progress'] },
          ],
          continuation: {
            kind: 'inter_dialog_reply',
            tellaskReplyDirective: removedDurableReminder.tellaskReplyDirective,
            calleeDialogReplyTarget: removedDurableReminder.calleeDialogReplyTarget,
          },
        },
        durableToolThenPlainProgressSideDialog.status,
      );

      const previousDurableSideDialog = durableToolThenPlainProgressSideDialog;
      globalDialogRegistry.unregister(root.id.rootId);
      const durableRestoredRoot = await getOrRestoreMainDialog(root.id.rootId, root.status);
      assert.ok(durableRestoredRoot);
      assert.notEqual(durableRestoredRoot, root);
      root = durableRestoredRoot;
      const durableContinuationSideDialog = await ensureDialogLoaded(
        root,
        durableToolThenPlainProgressSideDialog.id,
        durableToolThenPlainProgressSideDialog.status,
      );
      assert.ok(
        durableContinuationSideDialog instanceof SideDialog,
        'expected restored tool-then-plain-progress side dialog',
      );
      assert.notEqual(durableContinuationSideDialog, previousDurableSideDialog);
      const durableScheduledDrives: ScheduledDrive[] = [];
      await executeDriveRound({
        runtime: createKernelDriverRuntimeState(),
        driveArgs: [
          durableContinuationSideDialog,
          undefined,
          true,
          makeDriveOptions({
            suppressDiligencePush: true,
            source: 'kernel_driver_backend_loop',
            reason: 'durable_followup_next_action',
          }),
        ],
        scheduleDrive: (dialog, options) => {
          assert.equal(
            dialog,
            durableContinuationSideDialog,
            'durable post-tool continuation should schedule the same side dialog',
          );
          durableScheduledDrives.push({ dialog: durableContinuationSideDialog, options });
        },
        driveDialog: async () => {},
      });

      const durableQueuedReminder = durableContinuationSideDialog.peekQueuedPrompt();
      assert.equal(
        durableQueuedReminder?.kind,
        'new_course_runtime_sideDialog',
        'post-tool business continuation must recover reply obligation from durable trigger continuation',
      );
      recordReminder('durableQueuedReminder', durableQueuedReminder);
      assert.equal(
        durableQueuedReminder.tellaskReplyDirective.targetCallId,
        durableToolThenPlainProgressCallId,
      );
      assert.equal(
        durableScheduledDrives.length,
        1,
        'durable post-tool continuation should schedule one reply reminder follow-up',
      );
    } finally {
      unregisterLlmGenerator(apiType);
    }
  });
  await evidence.write();
  console.log('kernel-driver sideDialog-direct-fallback-thinking: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver sideDialog-direct-fallback-thinking: FAIL\n${message}`);
  process.exit(1);
});
