import assert from 'node:assert/strict';

import { DialogID, SideDialog } from '../../main/dialog';
import { setDialogDisplayState } from '../../main/dialog-display-state';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import type { ChatMessage } from '../../main/llm/client';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import {
  createKernelDriverRuntimeState,
  type KernelDriverDriveCallOptions,
} from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import {
  formatAssignmentFromAskerDialog,
  formatTellaskResponseContent,
} from '../../main/runtime/inter-dialog-format';
import { buildReplyToolReminderText } from '../../main/runtime/reply-prompt-copy';
import { getWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
  makeDriveOptions,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  wrapPromptWithExpectedReplyTool,
  writeMockDb,
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

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, {
      includePangu: true,
      extraMembers: ['coder'],
    });

    const language = getWorkLanguage();
    const triggerThinkingOnly = 'Start thinking-only direct fallback side dialog.';
    const thinkingOnlyCallId = 'root-call-pangu-thinking-only';
    const thinkingOnlyBody = 'Please answer 1+1. Do not call replyTellaskSessionless.';
    const thinkingOnlyMentionList = ['@pangu'];
    const thinkingOnlyPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellaskSessionless',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: thinkingOnlyMentionList,
        tellaskContent: thinkingOnlyBody,
        language,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellaskSessionless',
      language,
    });
    const thinkingOnlyReplyReminder = buildReplyToolReminderText({
      language,
      directive: {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: '',
        targetCallId: thinkingOnlyCallId,
        tellaskContent: thinkingOnlyBody,
      },
      replyTargetAgentId: 'tester',
    });
    const thinkingOnlyText = 'Reasoned answer: 2.';
    const expectedThinkingOnlyMirror = formatTellaskResponseContent({
      callName: 'tellaskSessionless',
      callId: thinkingOnlyCallId,
      responderId: 'pangu',
      tellaskerId: 'tester',
      mentionList: thinkingOnlyMentionList,
      tellaskContent: thinkingOnlyBody,
      responseBody: thinkingOnlyText,
      status: 'completed',
      deliveryMode: 'direct_fallback',
      directFallbackSource: 'thinking_only',
      language,
    });

    const triggerSayingWins = 'Start saying-wins direct fallback side dialog.';
    const sayingWinsCallId = 'root-call-coder-saying-wins';
    const sayingWinsBody = 'Please answer 2+2. Do not call replyTellaskSessionless.';
    const sayingWinsMentionList = ['@coder'];
    const sayingWinsPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellaskSessionless',
        fromAgentId: 'tester',
        toAgentId: 'coder',
        mentionList: sayingWinsMentionList,
        tellaskContent: sayingWinsBody,
        language,
        collectiveTargets: ['coder'],
      }),
      expectedReplyToolName: 'replyTellaskSessionless',
      language,
    });
    const sayingWinsReplyReminder = buildReplyToolReminderText({
      language,
      directive: {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: '',
        targetCallId: sayingWinsCallId,
        tellaskContent: sayingWinsBody,
      },
      replyTargetAgentId: 'tester',
    });
    const sayingWinsThinking = 'Hidden calculation says 999.';
    const sayingWinsSaying = 'Public answer: 4.';
    const expectedSayingWinsMirror = formatTellaskResponseContent({
      callName: 'tellaskSessionless',
      callId: sayingWinsCallId,
      responderId: 'coder',
      tellaskerId: 'tester',
      mentionList: sayingWinsMentionList,
      tellaskContent: sayingWinsBody,
      responseBody: sayingWinsSaying,
      status: 'completed',
      deliveryMode: 'direct_fallback',
      directFallbackSource: 'saying',
      language,
    });

    const triggerThinkingThenTellask =
      'Start side dialog that thinks and delegates in the same round.';
    const thinkingThenTellaskCallId = 'root-call-coder-thinking-then-tellask';
    const thinkingThenTellaskBody =
      'Please investigate, delegate one subtask, and do not reply yet.';
    const thinkingThenTellaskMentionList = ['@coder'];
    const thinkingThenTellaskPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellaskSessionless',
        fromAgentId: 'tester',
        toAgentId: 'coder',
        mentionList: thinkingThenTellaskMentionList,
        tellaskContent: thinkingThenTellaskBody,
        language,
        collectiveTargets: ['coder'],
      }),
      expectedReplyToolName: 'replyTellaskSessionless',
      language,
    });
    const nestedThinkingTellaskCallId = 'coder-call-pangu-thinking-then-tellask';
    const nestedThinkingTellaskBody =
      'Please inspect the delegated subtask before I produce the final tellasker reply.';
    const thinkingThenTellaskText =
      'I need a downstream inspection before I can produce the final reply.';

    const triggerToolThenPlainProgress =
      'Start side dialog that uses a tool and then emits plain progress.';
    const toolThenPlainProgressCallId = 'root-call-coder-tool-then-plain-progress';
    const triggerDurableToolThenPlainProgress =
      'Start durable side dialog that uses a tool and then emits plain progress.';
    const durableToolThenPlainProgressCallId = 'root-call-coder-durable-tool-then-plain-progress';
    const toolThenPlainProgressBody =
      'Use one local inspection tool, then continue to the next item without calling the reply tool.';
    const durableToolThenPlainProgressBody =
      'Use one local inspection tool, then continue durably without calling the reply tool.';
    const toolThenPlainProgressMentionList = ['@coder'];
    const toolThenPlainProgressPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellaskSessionless',
        fromAgentId: 'tester',
        toAgentId: 'coder',
        mentionList: toolThenPlainProgressMentionList,
        tellaskContent: toolThenPlainProgressBody,
        language,
        collectiveTargets: ['coder'],
      }),
      expectedReplyToolName: 'replyTellaskSessionless',
      language,
    });
    const toolThenPlainProgressReplyReminder = buildReplyToolReminderText({
      language,
      directive: {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: '',
        targetCallId: toolThenPlainProgressCallId,
        tellaskContent: toolThenPlainProgressBody,
      },
      replyTargetAgentId: 'tester',
    });
    const durableToolThenPlainProgressReplyReminder = buildReplyToolReminderText({
      language,
      directive: {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: '',
        targetCallId: durableToolThenPlainProgressCallId,
        tellaskContent: durableToolThenPlainProgressBody,
      },
      replyTargetAgentId: 'tester',
    });
    const toolThenPlainProgressProbeResult = '✅ Command completed (exit code: 0)';
    const toolThenPlainProgressText =
      'The local probe finished; continuing to the next validation item.';
    const durableToolThenPlainProgressText =
      'The restored local probe finished; continuing to the next validation item.';

    const triggerFirstThinkingOnly = 'Start first-turn thinking-only reply reminder side dialog.';
    const firstThinkingOnlyCallId = 'root-call-coder-first-thinking-only';
    const firstThinkingOnlyBody =
      'Please plan the UI change. First answer must be a thinking-only direct reply.';
    const firstThinkingOnlyMentionList = ['@coder'];
    const firstThinkingOnlyPrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellaskSessionless',
        fromAgentId: 'tester',
        toAgentId: 'coder',
        mentionList: firstThinkingOnlyMentionList,
        tellaskContent: firstThinkingOnlyBody,
        language,
        collectiveTargets: ['coder'],
      }),
      expectedReplyToolName: 'replyTellaskSessionless',
      language,
    });
    const firstThinkingOnlyReplyReminder = buildReplyToolReminderText({
      language,
      directive: {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: '',
        targetCallId: firstThinkingOnlyCallId,
        tellaskContent: firstThinkingOnlyBody,
      },
      replyTargetAgentId: 'tester',
    });
    const firstThinkingOnlyPlanning = 'I am planning instead of calling the required reply tool.';
    const firstThinkingOnlyFallbackText =
      'I still skipped the reply tool after the runtime reminder.';
    const expectedFirstThinkingOnlyMirror = formatTellaskResponseContent({
      callName: 'tellaskSessionless',
      callId: firstThinkingOnlyCallId,
      responderId: 'coder',
      tellaskerId: 'tester',
      mentionList: firstThinkingOnlyMentionList,
      tellaskContent: firstThinkingOnlyBody,
      responseBody: firstThinkingOnlyFallbackText,
      status: 'completed',
      deliveryMode: 'direct_fallback',
      directFallbackSource: 'saying',
      language,
    });

    await writeMockDb(tmpRoot, [
      {
        message: triggerFirstThinkingOnly,
        role: 'user',
        response: 'Starting first-turn thinking-only side dialog.',
        funcCalls: [
          {
            id: firstThinkingOnlyCallId,
            name: 'tellaskSessionless',
            arguments: {
              targetAgentId: 'coder',
              tellaskContent: firstThinkingOnlyBody,
            },
          },
        ],
      },
      {
        message: firstThinkingOnlyPrompt,
        role: 'user',
        response: '',
        thinkingResponse: firstThinkingOnlyPlanning,
        omitDefaultThinking: true,
      },
      {
        message: firstThinkingOnlyReplyReminder,
        role: 'user',
        response: firstThinkingOnlyFallbackText,
        contextContains: [firstThinkingOnlyBody],
      },
      {
        message: expectedFirstThinkingOnlyMirror,
        role: 'tool',
        response: 'Root received first-turn thinking-only fallback.',
      },
      {
        message: triggerThinkingOnly,
        role: 'user',
        response: 'Starting thinking-only side dialog.',
        funcCalls: [
          {
            id: thinkingOnlyCallId,
            name: 'tellaskSessionless',
            arguments: {
              targetAgentId: 'pangu',
              tellaskContent: thinkingOnlyBody,
            },
          },
        ],
      },
      {
        message: thinkingOnlyPrompt,
        role: 'user',
        response: 'I have the answer but forgot the reply tool.',
      },
      {
        message: thinkingOnlyReplyReminder,
        role: 'user',
        response: '',
        thinkingResponse: thinkingOnlyText,
        omitDefaultThinking: true,
        contextContains: [thinkingOnlyBody],
      },
      {
        message: expectedThinkingOnlyMirror,
        role: 'tool',
        response: 'Root received thinking-only fallback.',
      },
      {
        message: triggerSayingWins,
        role: 'user',
        response: 'Starting saying-wins side dialog.',
        funcCalls: [
          {
            id: sayingWinsCallId,
            name: 'tellaskSessionless',
            arguments: {
              targetAgentId: 'coder',
              tellaskContent: sayingWinsBody,
            },
          },
        ],
      },
      {
        message: sayingWinsPrompt,
        role: 'user',
        response: 'I have the answer but forgot the reply tool.',
      },
      {
        message: sayingWinsReplyReminder,
        role: 'user',
        response: sayingWinsSaying,
        thinkingResponse: sayingWinsThinking,
        omitDefaultThinking: true,
        contextContains: [sayingWinsBody],
      },
      {
        message: expectedSayingWinsMirror,
        role: 'tool',
        response: 'Root received saying fallback.',
      },
      {
        message: triggerThinkingThenTellask,
        role: 'user',
        response: 'Starting thinking-then-tellask side dialog.',
        funcCalls: [
          {
            id: thinkingThenTellaskCallId,
            name: 'tellaskSessionless',
            arguments: {
              targetAgentId: 'coder',
              tellaskContent: thinkingThenTellaskBody,
            },
          },
        ],
      },
      {
        message: triggerToolThenPlainProgress,
        role: 'user',
        response: 'Starting tool-then-plain-progress side dialog.',
        funcCalls: [
          {
            id: toolThenPlainProgressCallId,
            name: 'tellaskSessionless',
            arguments: {
              targetAgentId: 'coder',
              tellaskContent: toolThenPlainProgressBody,
            },
          },
        ],
      },
      {
        message: triggerDurableToolThenPlainProgress,
        role: 'user',
        response: 'Starting durable tool-then-plain-progress side dialog.',
        funcCalls: [
          {
            id: durableToolThenPlainProgressCallId,
            name: 'tellaskSessionless',
            arguments: {
              targetAgentId: 'coder',
              tellaskContent: durableToolThenPlainProgressBody,
            },
          },
        ],
      },
      {
        message: toolThenPlainProgressPrompt,
        role: 'user',
        response: 'I will inspect locally before final delivery.',
        funcCalls: [
          {
            id: 'coder-readonly-tool-then-plain-progress',
            name: 'readonly_shell',
            arguments: {
              command: 'printf probe',
            },
          },
        ],
      },
      {
        message: toolThenPlainProgressProbeResult,
        role: 'tool',
        response: toolThenPlainProgressText,
        contextContains: [toolThenPlainProgressBody],
      },
      {
        message: toolThenPlainProgressProbeResult,
        role: 'tool',
        response: durableToolThenPlainProgressText,
        contextContains: [durableToolThenPlainProgressBody],
      },
      {
        message: thinkingThenTellaskPrompt,
        role: 'user',
        response: '',
        thinkingResponse: thinkingThenTellaskText,
        omitDefaultThinking: true,
        funcCalls: [
          {
            id: nestedThinkingTellaskCallId,
            name: 'tellaskSessionless',
            arguments: {
              targetAgentId: 'pangu',
              tellaskContent: nestedThinkingTellaskBody,
            },
          },
        ],
      },
    ]);

    let root = await createMainDialog('tester');
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
      .getAllDialogs()
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
        scheduledFirstThinkingOnlyDrives[0].options.humanPrompt,
        scheduledFirstThinkingOnlyDrives[0].options.waitInQue,
        scheduledFirstThinkingOnlyDrives[0].options.driveOptions,
      ],
      scheduleDrive: (dialog, options) => {
        assert.equal(dialog, firstThinkingOnlySideDialog);
        scheduledFirstThinkingOnlyDrives.push({ dialog: firstThinkingOnlySideDialog, options });
      },
      driveDialog: async () => {},
    });

    const firstThinkingOnlyQueuedReminder = firstThinkingOnlySideDialog.peekUpNext();
    assert.equal(
      firstThinkingOnlyQueuedReminder?.kind,
      'new_course_runtime_sideDialog',
      'plain first-turn sideDialog reply must queue a durable reply reminder',
    );
    assert.equal(firstThinkingOnlyQueuedReminder.prompt, firstThinkingOnlyReplyReminder);
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
      firstThinkingOnlyLatest.pendingRuntimePrompt?.content,
      firstThinkingOnlyReplyReminder,
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
    const restoredQueuedReminder = restoredFirstThinkingOnlySideDialog.peekUpNext();
    assert.equal(
      restoredQueuedReminder?.msgId,
      firstThinkingOnlyQueuedReminder.msgId,
      'restore should rehydrate the durable reply reminder with the same msgId',
    );
    assert.equal(restoredQueuedReminder.prompt, firstThinkingOnlyReplyReminder);
    assert.equal(
      restoredQueuedReminder.tellaskReplyDirective?.targetCallId,
      firstThinkingOnlyCallId,
    );
    assert.equal(
      scheduledFirstThinkingOnlyDrives.length,
      2,
      'expected durable reply reminder to schedule one no-prompt follow-up drive',
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
    assert.ok(firstThinkingOnlyResult, 'expected first-turn thinking-only direct fallback result');
    assert.equal(firstThinkingOnlyResult.content, expectedFirstThinkingOnlyMirror);
    assert.match(firstThinkingOnlyResult.content, /direct-reply fallback/u);
    assert.match(firstThinkingOnlyResult.content, /I still skipped the reply tool/u);
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
        callSiteCourse: 1,
        callSiteGenseq: 1,
        collectiveTargets: ['coder'],
      },
    );
    const initialGuardedPendingReplyLatest = await DialogPersistence.loadDialogLatest(
      guardedPendingReplySideDialog.id,
      guardedPendingReplySideDialog.status,
    );
    assert.deepEqual(
      initialGuardedPendingReplyLatest?.displayState,
      { kind: 'idle_waiting_user' },
      'new sideDialogs with active reply obligations should be born idle until a real suspension fact appears',
    );
    assert.deepEqual(
      initialGuardedPendingReplyLatest?.executionMarker,
      undefined,
      'new sideDialogs with active reply obligations should not persist a resumable execution marker',
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
      { kind: 'idle_waiting_user' },
      'display-state writer should allow idle while only a sideDialog reply obligation is active',
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
      { kind: 'idle_waiting_user' },
      'latest.yaml mutation guard should allow idle while only a sideDialog reply obligation is active',
    );
    assert.deepEqual(
      latestAfterDirectIdleMutation?.executionMarker,
      undefined,
      'latest.yaml mutation guard should not synthesize a resumable pending-reply execution marker',
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
    assert.equal(thinkingOnlyResult.content, expectedThinkingOnlyMirror);
    assert.match(thinkingOnlyResult.content, /only produced thinking/u);
    assert.match(thinkingOnlyResult.content, /Reasoned answer: 2/u);

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
    assert.equal(sayingWinsResult.content, expectedSayingWinsMirror);
    assert.match(sayingWinsResult.content, /Public answer: 4/u);
    assert.doesNotMatch(sayingWinsResult.content, /999/u);

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
      .getAllDialogs()
      .find(
        (dialog): dialog is SideDialog =>
          dialog instanceof SideDialog &&
          dialog.assignmentFromAsker.callId === thinkingThenTellaskCallId,
      );
    assert.ok(thinkingThenTellaskSideDialog, 'expected thinking-then-tellask side dialog to exist');
    assert.equal(
      scheduledThinkingThenTellaskDrives.length,
      1,
      'root drive should schedule the thinking-then-tellask side dialog once',
    );

    await executeDriveRound({
      runtime: createKernelDriverRuntimeState(),
      driveArgs: [
        thinkingThenTellaskSideDialog,
        scheduledThinkingThenTellaskDrives[0].options.humanPrompt,
        scheduledThinkingThenTellaskDrives[0].options.waitInQue,
        scheduledThinkingThenTellaskDrives[0].options.driveOptions,
      ],
      scheduleDrive: (dialog, options) => {
        assert.ok(dialog instanceof SideDialog, 'expected nested sideDialog follow-up scheduling');
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
      thinkingThenTellaskSideDialog.peekUpNext(),
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
      .getAllDialogs()
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
        scheduledToolThenPlainProgressDrives[0].options.humanPrompt,
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

    const queuedToolThenPlainProgressReminder = toolThenPlainProgressSideDialog.peekUpNext();
    assert.equal(
      queuedToolThenPlainProgressReminder?.kind,
      'new_course_runtime_sideDialog',
      'plain post-tool sideDialog progress must queue a durable reply reminder',
    );
    assert.equal(queuedToolThenPlainProgressReminder.prompt, toolThenPlainProgressReplyReminder);
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
      .getAllDialogs()
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
        durableScheduledInitialDrives[0].options.humanPrompt,
        durableScheduledInitialDrives[0].options.waitInQue,
        durableScheduledInitialDrives[0].options.driveOptions,
      ],
      scheduleDrive: () => {},
      driveDialog: async () => {},
    });

    const removedDurableReminder = durableToolThenPlainProgressSideDialog.takeUpNext();
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
          course: durableContinuationCourse,
          genseq: durableContinuationGenseq,
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

    const durableContinuationSideDialog = await ensureDialogLoaded(
      root,
      durableToolThenPlainProgressSideDialog.id,
      durableToolThenPlainProgressSideDialog.status,
    );
    assert.ok(
      durableContinuationSideDialog instanceof SideDialog,
      'expected restored tool-then-plain-progress side dialog',
    );
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

    const durableQueuedReminder = durableContinuationSideDialog.peekUpNext();
    assert.equal(
      durableQueuedReminder?.kind,
      'new_course_runtime_sideDialog',
      'no-prompt post-tool continuation must recover reply obligation from durable trigger continuation',
    );
    assert.equal(durableQueuedReminder.prompt, durableToolThenPlainProgressReplyReminder);
    assert.equal(
      durableQueuedReminder.tellaskReplyDirective.targetCallId,
      durableToolThenPlainProgressCallId,
    );
    assert.equal(
      durableScheduledDrives.length,
      1,
      'durable post-tool continuation should schedule one reply reminder follow-up',
    );
  });

  console.log('kernel-driver sideDialog-direct-fallback-thinking: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver sideDialog-direct-fallback-thinking: FAIL\n${message}`);
  process.exit(1);
});
