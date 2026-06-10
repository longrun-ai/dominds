import assert from 'node:assert/strict';

import type { TellaskReplyDirective } from '@longrun-ai/kernel/types/storage';
import {
  toAssignmentCourseNumber,
  toAssignmentGenerationSeqNumber,
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
} from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import {
  executeTellaskCalls,
  processTellaskFunctionRound,
  type TellaskCallFunctionName,
} from '../../main/llm/kernel-driver/tellask-special';
import { DialogPersistence } from '../../main/persistence';
import { createMainDialog, withTempRtws, writeMockDb, writeStandardMinds } from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });
    await writeMockDb(tmpRoot, []);

    const root = await createMainDialog('tester');
    const callId = 'root-assignment-call';
    const tellaskContent = 'Please finish once.';
    const sideDialog = await root.createSideDialog('pangu', ['@pangu'], tellaskContent, {
      callName: 'tellask',
      originMemberId: 'tester',
      askerDialogId: root.id.selfId,
      callId,
      callSiteCourse: 1,
      callSiteGenseq: 1,
      sessionSlug: 'reply-delivery-delivered',
      collectiveTargets: ['pangu'],
    });
    await DialogPersistence.appendActiveCalleeDispatch(root.id, {
      batchId: 'reply-delivery-delivered-batch',
      calleeDialogId: sideDialog.id.selfId,
      callId,
      callName: 'tellask',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      callType: 'B',
      createdAt: formatUnifiedTimestamp(new Date()),
      mentionList: ['@pangu'],
      sessionSlug: 'reply-delivery-delivered',
      targetAgentId: 'pangu',
      tellaskContent,
    });
    await DialogPersistence.mutateDialogLatest(sideDialog.id, () => ({
      kind: 'patch',
      patch: {
        latestAssignmentAnchor: {
          callId,
          assignmentCourse: toAssignmentCourseNumber(1),
          assignmentGenseq: toAssignmentGenerationSeqNumber(1),
        },
      },
    }));
    const directive: TellaskReplyDirective = {
      expectedReplyCallName: 'replyTellask',
      targetDialogId: root.id.selfId,
      targetCallId: callId,
      tellaskContent,
    };
    await DialogPersistence.setActiveTellaskReplyObligation(sideDialog.id, directive);

    await sideDialog.notifyGeneratingStart();
    const replyCallId = 'side-reply-tool-call';
    await sideDialog.persistTellaskCall(
      replyCallId,
      'replyTellask',
      JSON.stringify({ replyContent: 'Done.' }),
      sideDialog.activeGenSeq,
      { deliveryMode: 'func_call_requested' },
    );
    const pending = (await DialogPersistence.loadDialogLatest(sideDialog.id, sideDialog.status))
      ?.replyDelivery;
    assert.equal(pending?.status, 'pending', 'reply delivery starts pending after reply call');

    const result = await executeTellaskCalls({
      dlg: sideDialog,
      calls: [
        {
          callId: replyCallId,
          callName: 'replyTellask',
          replyContent: 'Done.',
        },
      ],
      activePromptReplyDirective: directive,
      callbacks: {
        scheduleDrive: () => {},
        driveDialog: async () => {},
      },
    });
    assert.deepEqual(result.successfulReplyCallIds, [replyCallId]);
    assert.deepEqual(result.failedReplyCallIds, []);

    const latest = await DialogPersistence.loadDialogLatest(sideDialog.id, sideDialog.status);
    assert.equal(
      latest?.replyDelivery?.status,
      'delivered',
      'sideDialog reply-tool response must mark replyDelivery delivered',
    );
    assert.equal(
      latest?.replyDelivery?.toolResultStatus,
      'pending',
      'tool result recording remains a separate state transition',
    );

    const replacementTargetCallId = 'replacement-root-assignment-call';
    await DialogPersistence.setActiveTellaskReplyObligation(sideDialog.id, {
      expectedReplyCallName: 'replyTellask',
      targetDialogId: root.id.selfId,
      targetCallId: replacementTargetCallId,
      tellaskContent: 'Please finish the replacement assignment.',
    });
    await sideDialog.persistTellaskCall(
      'replacement-side-reply-tool-call',
      'replyTellask',
      JSON.stringify({ replyContent: 'Replacement done.' }),
      sideDialog.activeGenSeq,
      { deliveryMode: 'func_call_requested' },
    );
    const replacedLatest = await DialogPersistence.loadDialogLatest(
      sideDialog.id,
      sideDialog.status,
    );
    assert.equal(
      replacedLatest?.replyDelivery?.replyCallId,
      'replacement-side-reply-tool-call',
      'stale pending reply delivery should not stop a newer valid reply call',
    );
    assert.equal(replacedLatest?.replyDelivery?.targetCallId, replacementTargetCallId);

    const sessionlessRoot = await createMainDialog('tester');
    const sessionlessCallId = 'root-sessionless-assignment-call';
    const sessionlessTellaskContent = 'Please finish this sessionless assignment.';
    const sessionlessSideDialog = await sessionlessRoot.createSideDialog(
      'pangu',
      ['@pangu'],
      sessionlessTellaskContent,
      {
        callName: 'tellaskSessionless',
        originMemberId: 'tester',
        askerDialogId: sessionlessRoot.id.selfId,
        callId: sessionlessCallId,
        callSiteCourse: 1,
        callSiteGenseq: 1,
        collectiveTargets: ['pangu'],
      },
    );
    await DialogPersistence.appendActiveCalleeDispatch(sessionlessRoot.id, {
      batchId: 'reply-delivery-sessionless-batch',
      calleeDialogId: sessionlessSideDialog.id.selfId,
      callId: sessionlessCallId,
      callName: 'tellaskSessionless',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      callType: 'C',
      createdAt: formatUnifiedTimestamp(new Date()),
      mentionList: ['@pangu'],
      targetAgentId: 'pangu',
      tellaskContent: sessionlessTellaskContent,
    });
    const sessionlessRound = await processTellaskFunctionRound({
      dlg: sessionlessSideDialog,
      funcCalls: [
        {
          type: 'func_call_msg',
          role: 'assistant',
          genseq: 1,
          id: 'sessionless-reply-call',
          name: 'replyTellaskSessionless',
          arguments: JSON.stringify({ replyContent: 'Sessionless done.' }),
        },
      ],
      allowedSpecials: new Set<TellaskCallFunctionName>(['replyTellaskSessionless']),
      callbacks: {
        scheduleDrive: () => {},
        driveDialog: async () => {},
      },
      activePromptReplyDirective: {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: sessionlessRoot.id.selfId,
        targetCallId: sessionlessCallId,
        tellaskContent: sessionlessTellaskContent,
      },
    });
    assert.equal(
      sessionlessRound.shouldStopAfterReplyTool,
      true,
      'successful replyTellaskSessionless delivery should stop the side dialog drive',
    );
    assert.equal(
      sessionlessRound.hasImmediateTellaskOutputs,
      false,
      'successful replyTellaskSessionless delivery must not request same-drive follow-up',
    );
    assert.deepEqual(
      sessionlessRound.immediateTellaskOutputCallIds,
      [],
      'successful replyTellaskSessionless delivery must not record immediate output call ids',
    );

    const staleAskBackRoot = await createMainDialog('tester');
    const staleAskBackCallId = 'stale-askback-call';
    await staleAskBackRoot.receiveTellaskResponse(
      'pangu',
      'tellaskBack',
      undefined,
      'Please clarify the stale ask-back.',
      'completed',
      undefined,
      {
        response: 'Already resolved.',
        agentId: 'pangu',
        callId: staleAskBackCallId,
        originMemberId: 'tester',
      },
    );
    const staleReplyCallId = 'stale-askback-reply-call';
    const staleReplyRound = await processTellaskFunctionRound({
      dlg: staleAskBackRoot,
      funcCalls: [
        {
          type: 'func_call_msg',
          role: 'assistant',
          genseq: 1,
          id: staleReplyCallId,
          name: 'replyTellaskBack',
          arguments: JSON.stringify({ replyContent: 'Late reply.' }),
        },
      ],
      allowedSpecials: new Set<TellaskCallFunctionName>(['replyTellaskBack']),
      callbacks: {
        scheduleDrive: () => {},
        driveDialog: async () => {},
      },
      activePromptReplyDirective: {
        expectedReplyCallName: 'replyTellaskBack',
        targetDialogId: staleAskBackRoot.id.selfId,
        targetCallId: staleAskBackCallId,
        tellaskContent: 'Please clarify the stale ask-back.',
      },
    });
    assert.equal(
      staleReplyRound.shouldStopAfterReplyTool,
      false,
      'failed replyTellaskBack delivery must not stop the dialog drive',
    );
    assert.equal(
      staleReplyRound.hasImmediateTellaskOutputs,
      true,
      'failed replyTellaskBack delivery should request same-drive follow-up',
    );
    assert.deepEqual(
      staleReplyRound.immediateTellaskOutputCallIds,
      [staleReplyCallId],
      'failed replyTellaskBack delivery should expose its result to immediate follow-up',
    );
    const staleReplyResult = staleReplyRound.tellaskResults.find(
      (result) => result.id === staleReplyCallId,
    );
    assert.ok(staleReplyResult, 'expected stale replyTellaskBack to produce a tool result');
    assert.ok(
      staleReplyResult.content.includes('不会送达') ||
        staleReplyResult.content.includes('will not deliver'),
      'expected stale replyTellaskBack result to explain that no delivery happened',
    );

    const noActiveReplyRoot = await createMainDialog('tester');
    const noActiveReplyCallId = 'no-active-reply-call';
    const noActiveReplyRound = await processTellaskFunctionRound({
      dlg: noActiveReplyRoot,
      funcCalls: [
        {
          type: 'func_call_msg',
          role: 'assistant',
          genseq: 1,
          id: noActiveReplyCallId,
          name: 'replyTellaskBack',
          arguments: JSON.stringify({ replyContent: 'No one is waiting.' }),
        },
      ],
      allowedSpecials: new Set<TellaskCallFunctionName>(['replyTellaskBack']),
      callbacks: {
        scheduleDrive: () => {},
        driveDialog: async () => {},
      },
    });
    assert.equal(
      noActiveReplyRound.shouldStopAfterReplyTool,
      false,
      'replyTellask* without an active obligation must not stop the dialog drive',
    );
    assert.equal(
      noActiveReplyRound.hasImmediateTellaskOutputs,
      true,
      'replyTellask* without an active obligation should request same-drive follow-up',
    );
    assert.deepEqual(
      noActiveReplyRound.immediateTellaskOutputCallIds,
      [noActiveReplyCallId],
      'replyTellask* without an active obligation should expose its result to immediate follow-up',
    );

    const wrongToolRoot = await createMainDialog('tester');
    const wrongToolReplyCallId = 'wrong-tool-reply-call';
    const wrongToolRound = await processTellaskFunctionRound({
      dlg: wrongToolRoot,
      funcCalls: [
        {
          type: 'func_call_msg',
          role: 'assistant',
          genseq: 1,
          id: wrongToolReplyCallId,
          name: 'replyTellaskBack',
          arguments: JSON.stringify({ replyContent: 'Wrong channel.' }),
        },
      ],
      allowedSpecials: new Set<TellaskCallFunctionName>(['replyTellaskBack']),
      callbacks: {
        scheduleDrive: () => {},
        driveDialog: async () => {},
      },
      activePromptReplyDirective: {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: wrongToolRoot.id.selfId,
        targetCallId: 'wrong-tool-target-call',
        tellaskContent: 'Please finish through replyTellask.',
      },
    });
    assert.equal(
      wrongToolRound.shouldStopAfterReplyTool,
      false,
      'wrong replyTellask* tool must not stop the dialog drive',
    );
    assert.equal(
      wrongToolRound.hasImmediateTellaskOutputs,
      true,
      'wrong replyTellask* tool should request same-drive follow-up',
    );
    assert.deepEqual(
      wrongToolRound.immediateTellaskOutputCallIds,
      [wrongToolReplyCallId],
      'wrong replyTellask* tool should expose its result to immediate follow-up',
    );
  });

  console.log('kernel-driver sideDialog-reply-delivery-marked-delivered: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver sideDialog-reply-delivery-marked-delivered: FAIL\n${message}`);
  process.exit(1);
});
