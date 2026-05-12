import assert from 'node:assert/strict';

import { toRootGenerationAnchor } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
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

    const strandedCallId = 'root-call-coder-stranded-idle';
    const strandedBody =
      'Please recover this stranded idle side dialog and remind it to use replyTellaskSessionless.';
    const strandedReplyReminder = buildReplyToolReminderText({
      language,
      directive: {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: '',
        targetCallId: strandedCallId,
        tellaskContent: strandedBody,
      },
      replyTargetAgentId: 'tester',
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
      firstThinkingOnlyQueuedReminder.sideDialogReplyTarget.callId,
      firstThinkingOnlyCallId,
    );
    const firstThinkingOnlyLatest = await DialogPersistence.loadDialogLatest(
      firstThinkingOnlySideDialog.id,
      firstThinkingOnlySideDialog.status,
    );
    assert.equal(
      firstThinkingOnlyLatest?.pendingCourseStartPrompt?.msgId,
      firstThinkingOnlyQueuedReminder.msgId,
      'durable reply reminder should survive restore through latest.yaml',
    );
    assert.equal(
      firstThinkingOnlyLatest.pendingCourseStartPrompt?.content,
      firstThinkingOnlyReplyReminder,
    );
    assert.equal(
      firstThinkingOnlyLatest.pendingCourseStartPrompt?.sideDialogReplyTarget?.callId,
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
      firstThinkingOnlyLatestAfterFallback?.pendingCourseStartPrompt,
      undefined,
      'consumed durable reply reminder must be cleared after fallback',
    );
    root = restoredRoot;

    const strandedSideDialog = await root.createSideDialog('coder', ['@coder'], strandedBody, {
      callName: 'tellaskSessionless',
      originMemberId: 'tester',
      askerDialogId: root.id.selfId,
      callId: strandedCallId,
      callSiteCourse: 1,
      callSiteGenseq: 1,
      collectiveTargets: ['coder'],
    });
    const initialStrandedLatest = await DialogPersistence.loadDialogLatest(
      strandedSideDialog.id,
      strandedSideDialog.status,
    );
    assert.deepEqual(
      initialStrandedLatest?.displayState,
      {
        kind: 'stopped',
        reason: { kind: 'pending_reply_obligation' },
        continueEnabled: true,
      },
      'new sideDialogs with active reply obligations must not be born idle',
    );
    assert.deepEqual(
      initialStrandedLatest?.executionMarker,
      {
        kind: 'interrupted',
        reason: { kind: 'pending_reply_obligation' },
      },
      'new sideDialogs with active reply obligations should persist a non-idle execution marker',
    );
    await setDialogDisplayState(strandedSideDialog.id, { kind: 'idle_waiting_user' });
    const latestAfterAttemptedIdle = await DialogPersistence.loadDialogLatest(
      strandedSideDialog.id,
      strandedSideDialog.status,
    );
    assert.deepEqual(
      latestAfterAttemptedIdle?.displayState,
      {
        kind: 'stopped',
        reason: { kind: 'pending_reply_obligation' },
        continueEnabled: true,
      },
      'display-state writer must reject idle while a sideDialog reply obligation is active',
    );
    await DialogPersistence.mutateDialogLatest(
      strandedSideDialog.id,
      () => ({
        kind: 'patch',
        patch: {
          displayState: { kind: 'idle_waiting_user' },
          executionMarker: undefined,
        },
      }),
      strandedSideDialog.status,
    );
    const latestAfterDirectIdleMutation = await DialogPersistence.loadDialogLatest(
      strandedSideDialog.id,
      strandedSideDialog.status,
    );
    assert.deepEqual(
      latestAfterDirectIdleMutation?.displayState,
      {
        kind: 'stopped',
        reason: { kind: 'pending_reply_obligation' },
        continueEnabled: true,
      },
      'latest.yaml mutation guard must reject direct idle writes while reply obligation is active',
    );
    assert.deepEqual(
      latestAfterDirectIdleMutation?.executionMarker,
      {
        kind: 'interrupted',
        reason: { kind: 'pending_reply_obligation' },
      },
      'latest.yaml mutation guard must preserve a resumable pending-reply execution marker',
    );
    await DialogPersistence.appendPendingSideDialog(root.id, {
      sideDialogId: strandedSideDialog.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      callName: 'tellaskSessionless',
      mentionList: ['@coder'],
      tellaskContent: strandedBody,
      targetAgentId: 'coder',
      callId: strandedCallId,
      callSiteCourse: 1,
      callSiteGenseq: 1,
      callType: 'C',
    });
    await strandedSideDialog.persistUserMessage(
      'Original stranded assignment prompt.',
      'stranded-assignment-prompt',
      'markdown',
      'runtime',
      language,
      undefined,
      {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: root.id.selfId,
        targetCallId: strandedCallId,
        tellaskContent: strandedBody,
      },
    );
    await DialogPersistence.appendEvent(
      strandedSideDialog.id,
      strandedSideDialog.currentCourse,
      {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'tellask_anchor_record',
        anchorRole: 'assignment',
        callId: strandedCallId,
        genseq: strandedSideDialog.activeGenSeqOrUndefined ?? 1,
        ...toRootGenerationAnchor({
          rootCourse: root.currentCourse,
          rootGenseq: root.activeGenSeqOrUndefined ?? 1,
        }),
      },
      strandedSideDialog.status,
    );
    await strandedSideDialog.persistAgentMessage(
      'I produced local output but forgot the reply tool.',
      strandedSideDialog.activeGenSeqOrUndefined ?? 1,
      'thinking_msg',
    );
    assert.equal(
      strandedSideDialog.peekUpNext(),
      undefined,
      'test setup should model an idle sideDialog with no queued reminder',
    );

    const scheduledStrandedDrives: ScheduledDrive[] = [];
    await executeDriveRound({
      runtime: createKernelDriverRuntimeState(),
      driveArgs: [
        strandedSideDialog,
        undefined,
        true,
        makeDriveOptions({
          source: 'kernel_driver_follow_up',
          reason: 'follow_up_prompt',
          suppressDiligencePush: true,
        }),
      ],
      scheduleDrive: (dialog, options) => {
        assert.equal(dialog, strandedSideDialog);
        scheduledStrandedDrives.push({ dialog: strandedSideDialog, options });
      },
      driveDialog: async () => {},
    });

    assert.equal(
      scheduledStrandedDrives.length,
      1,
      'stranded idle sideDialog should be revived by scheduling a reply reminder drive',
    );
    const strandedQueuedReminder = strandedSideDialog.peekUpNext();
    assert.equal(
      strandedQueuedReminder?.kind,
      'new_course_runtime_sideDialog',
      'stranded idle sideDialog should persist a sideDialog reply reminder',
    );
    assert.equal(strandedQueuedReminder.prompt, strandedReplyReminder);
    assert.equal(strandedQueuedReminder.sideDialogReplyTarget.callId, strandedCallId);
    const strandedLatest = await DialogPersistence.loadDialogLatest(
      strandedSideDialog.id,
      strandedSideDialog.status,
    );
    assert.equal(
      strandedLatest?.pendingCourseStartPrompt?.msgId,
      strandedQueuedReminder.msgId,
      'recovered stranded reply reminder should be durable',
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
    assert.doesNotMatch(sayingWinsResult.content, /Hidden calculation says 999/u);

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
        assert.ok(dialog instanceof SideDialog, 'expected only sideDialog follow-up scheduling');
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
    const pendingNested = await DialogPersistence.loadPendingSideDialogs(
      thinkingThenTellaskSideDialog.id,
      thinkingThenTellaskSideDialog.status,
    );
    assert.equal(
      pendingNested.length,
      1,
      'thinking plus same-round tellask should leave the side dialog waiting on delegated work',
    );
    assert.equal(pendingNested[0]?.callId, nestedThinkingTellaskCallId);
  });

  console.log('kernel-driver sideDialog-direct-fallback-thinking: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver sideDialog-direct-fallback-thinking: FAIL\n${message}`);
  process.exit(1);
});
