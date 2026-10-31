import assert from 'node:assert/strict';

import type { TellaskReplyDirective } from '@longrun-ai/kernel/types/storage';
import {
  toAssignmentCourseNumber,
  toAssignmentGenerationSeqNumber,
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
} from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { Dialog } from '../../main/dialog';
import {
  deliverTellaskBackReplyFromDirective,
  executeTellaskCalls,
  processTellaskFunctionRound,
  type TellaskCallFunctionName,
} from '../../main/llm/kernel-driver/tellask-special';
import { DialogPersistence } from '../../main/persistence';
import { getWorkLanguage, setWorkLanguage } from '../../main/runtime/work-language';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { createMainDialog, withTempRtws, writeStandardMinds } from './helpers';

const evidence = semanticEvidenceCollector('dominds-delivery-transitions-');
function recordFailure(id: string, actualText: string, scenario: string) {
  evidence.record({
    id: `${id}-${getWorkLanguage()}`,
    scenario,
    businessValue:
      'Reject an invalid reply without delivering it, and expose recoverable tool feedback for the next generation.',
    context: {
      language: getWorkLanguage(),
      scope:
        'Component reply-channel invocation; actual persistence and result flags, scheduler callbacks intentionally do not drive dialogs.',
    },
    reviewQuestions: [
      'Does the actual feedback accurately explain what was rejected and how to proceed without claiming that a reply was delivered?',
    ],
    actualText,
  });
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { extraMembers: ['worker'] });
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);

      const root = await createMainDialog('tester');
      const callId = 'root-assignment-call';
      const tellaskContent = 'Please finish once.';
      const sideDialog = await root.createSideDialog('worker', ['@worker'], tellaskContent, {
        callName: 'tellask',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId,
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        sessionSlug: 'reply-delivery-delivered',
        collectiveTargets: ['worker'],
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
        mentionList: ['@worker'],
        sessionSlug: 'reply-delivery-delivered',
        targetAgentId: 'worker',
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
      await sideDialog.notifyGeneratingFinish({ kind: 'unavailable', reason: 'usage_unavailable' });
      const replacement = {
        ...sideDialog.assignmentFromAsker,
        callId: replacementTargetCallId,
        tellaskContent: 'replacement-assignment-data',
        callSiteGenseq: toCallSiteGenseqNo(2),
      };
      sideDialog.assignmentFromAsker = replacement;
      await DialogPersistence.updateSideDialogAssignment(
        sideDialog.id,
        replacement,
        sideDialog.status,
      );
      assert.ok(sideDialog.sessionSlug);
      await DialogPersistence.appendActiveCalleeDispatch(root.id, {
        batchId: 'replacement-batch',
        calleeDialogId: sideDialog.id.selfId,
        callId: replacementTargetCallId,
        callName: 'tellask',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(2),
        callType: 'B',
        createdAt: formatUnifiedTimestamp(new Date()),
        mentionList: ['@worker'],
        targetAgentId: 'worker',
        tellaskContent: replacement.tellaskContent,
        sessionSlug: sideDialog.sessionSlug,
      });
      await sideDialog.notifyGeneratingStart();
      await DialogPersistence.mutateDialogLatest(sideDialog.id, () => ({
        kind: 'patch',
        patch: {
          latestAssignmentAnchor: {
            callId: replacementTargetCallId,
            assignmentCourse: toAssignmentCourseNumber(1),
            assignmentGenseq: toAssignmentGenerationSeqNumber(sideDialog.activeGenSeq),
          },
        },
      }));
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

      const replacementDelivered = await executeTellaskCalls({
        dlg: sideDialog,
        calls: [
          {
            callId: 'replacement-side-reply-tool-call',
            callName: 'replyTellask',
            replyContent: 'Replacement done.',
          },
        ],
        activePromptReplyDirective: {
          expectedReplyCallName: 'replyTellask',
          targetDialogId: root.id.selfId,
          targetCallId: replacementTargetCallId,
          tellaskContent: replacement.tellaskContent,
        },
        callbacks: { scheduleDrive() {}, async driveDialog() {} },
      });
      assert.deepEqual(replacementDelivered.successfulReplyCallIds, [
        'replacement-side-reply-tool-call',
      ]);
      const rootResults = (
        await DialogPersistence.loadCourseEvents(root.id, 1, root.status)
      ).filter((event) => event.type === 'tellask_result_record');
      assert.deepEqual(
        rootResults.map((event) => event.callId).sort(),
        [callId, replacementTargetCallId].sort(),
      );
      assert.ok(
        rootResults
          .find((event) => event.callId === replacementTargetCallId)
          ?.content.includes('Replacement done.'),
      );
      await sideDialog.notifyGeneratingFinish({ kind: 'unavailable', reason: 'usage_unavailable' });

      const sessionlessRoot = await createMainDialog('tester');
      const sessionlessCallId = 'root-sessionless-assignment-call';
      const sessionlessTellaskContent = 'Please finish this sessionless assignment.';
      const sessionlessSideDialog = await sessionlessRoot.createSideDialog(
        'worker',
        ['@worker'],
        sessionlessTellaskContent,
        {
          callName: 'tellaskSessionless',
          originMemberId: 'tester',
          askerDialogId: sessionlessRoot.id.selfId,
          callId: sessionlessCallId,
          callSiteCourse: toCallSiteCourseNo(1),
          callSiteGenseq: toCallSiteGenseqNo(1),
          collectiveTargets: ['worker'],
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
        mentionList: ['@worker'],
        targetAgentId: 'worker',
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

      // A matching old UI correlation id is not an active synchronous Type-A handler.
      // The delivered result must still schedule a wake after that generation has yielded.
      const lateAskBackId = 'late-ask-back-data';
      await sideDialog.notifyGeneratingStart();
      await sideDialog.persistTellaskCall(
        lateAskBackId,
        'tellaskBack',
        JSON.stringify({ tellaskContent: 'late-question-data' }),
        sideDialog.activeGenSeq,
      );
      await sideDialog.notifyGeneratingFinish({ kind: 'unavailable', reason: 'usage_unavailable' });
      assert.equal(
        (await DialogPersistence.loadDialogLatest(sideDialog.id, sideDialog.status))
          ?.generationRunState?.kind,
        'closed',
      );
      sideDialog.setCurrentCallId(lateAskBackId);
      const lateDirective = {
        expectedReplyCallName: 'replyTellaskBack' as const,
        targetDialogId: sideDialog.id.selfId,
        targetCallId: lateAskBackId,
        tellaskContent: 'late-question-data',
      };
      let wakes = 0;
      const lateCallbacks = {
        scheduleDrive(dialog: Dialog) {
          assert.equal(dialog, sideDialog);
          wakes += 1;
        },
        driveDialog: async () => {},
      };
      assert.deepEqual(
        await deliverTellaskBackReplyFromDirective({
          replyingDialog: root,
          directive: lateDirective,
          replyContent: 'late-answer-data',
          callbacks: lateCallbacks,
        }),
        { kind: 'delivered' },
      );
      assert.equal(wakes, 1);
      assert.deepEqual(
        await deliverTellaskBackReplyFromDirective({
          replyingDialog: root,
          directive: lateDirective,
          replyContent: 'duplicate-late-answer-data',
          callbacks: lateCallbacks,
        }),
        { kind: 'already_resolved' },
      );
      assert.equal(wakes, 1);
      const lateResults = (
        await DialogPersistence.loadCourseEvents(sideDialog.id, 1, sideDialog.status)
      )
        .filter((event) => event.type === 'tellask_result_record')
        .filter((event) => event.callId === lateAskBackId);
      assert.equal(lateResults.length, 1);
      assert.ok(lateResults[0].content.includes('late-answer-data'));

      const staleAskBackRoot = await createMainDialog('tester');
      const staleAskBackCallId = 'stale-askback-call';
      await staleAskBackRoot.receiveTellaskResponse(
        'worker',
        'tellaskBack',
        undefined,
        'Please clarify the stale ask-back.',
        'completed',
        undefined,
        {
          response: 'Already resolved.',
          agentId: 'worker',
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
      recordFailure(
        'already-resolved',
        staleReplyResult.content,
        'The provided target call already has a canonical completed result; a late reply is rejected.',
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

      const noActiveResult = noActiveReplyRound.tellaskResults.find(
        (item) => item.id === noActiveReplyCallId,
      );
      assert.ok(noActiveResult);
      recordFailure(
        'no-obligation',
        noActiveResult.content,
        'There is no active requester reply obligation.',
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
      const wrongResult = wrongToolRound.tellaskResults.find(
        (item) => item.id === wrongToolReplyCallId,
      );
      assert.ok(wrongResult);
      recordFailure(
        'wrong-channel',
        wrongResult.content,
        'The supplied active reply directive requires replyTellask, while the call uses replyTellaskBack.',
      );
    }
  });

  await evidence.write();
  console.log(
    'reply delivery transitions, legitimate replacement work and failure follow-up flags: passed',
  );
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver sideDialog-reply-delivery-marked-delivered: FAIL\n${message}`);
  process.exit(1);
});
