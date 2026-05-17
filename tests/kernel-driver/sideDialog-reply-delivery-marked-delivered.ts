import assert from 'node:assert/strict';

import type { TellaskReplyDirective } from '@longrun-ai/kernel/types/storage';
import {
  toAssignmentCourseNumber,
  toAssignmentGenerationSeqNumber,
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
} from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { executeTellaskCalls } from '../../main/llm/kernel-driver/tellask-special';
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
  });

  console.log('kernel-driver sideDialog-reply-delivery-marked-delivered: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver sideDialog-reply-delivery-marked-delivered: FAIL\n${message}`);
  process.exit(1);
});
