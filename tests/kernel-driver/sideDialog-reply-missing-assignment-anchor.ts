import assert from 'node:assert/strict';

import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import type { WebSocketMessage } from '@longrun-ai/kernel/types/wire';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { setDisplayStateBroadcaster } from '../../main/dialog-display-state';
import { supplySideDialogResponseToAssignedAskerIfPendingV2 } from '../../main/llm/kernel-driver/sideDialog';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { createMainDialog, withTempRtws, writeStandardMinds } from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws, { includePangu: true });
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      const root = await createMainDialog();
      const callId = `assignment-without-anchor-${language}`;
      const replyId = `explicit-reply-${language}`;
      const body = `assignment-data-${language}`;
      const answer = `reply-data-${language}`;
      const side = await root.createSideDialog('pangu', ['@pangu'], body, {
        callName: 'tellask',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId,
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        sessionSlug: `anchor-recovery-${language}`,
      });
      await DialogPersistence.appendActiveCalleeDispatch(root.id, {
        batchId: `batch-${language}`,
        calleeDialogId: side.id.selfId,
        callId,
        callName: 'tellask',
        mentionList: ['@pangu'],
        tellaskContent: body,
        targetAgentId: 'pangu',
        createdAt: formatUnifiedTimestamp(new Date()),
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        callType: 'B',
        sessionSlug: `anchor-recovery-${language}`,
      });
      await DialogPersistence.setActiveTellaskReplyObligation(side.id, {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: root.id.selfId,
        targetCallId: callId,
        tellaskContent: body,
      });
      await side.persistTellaskCall(
        replyId,
        'replyTellask',
        JSON.stringify({ replyContent: answer }),
        2,
      );
      const before = await DialogPersistence.loadDialogLatest(side.id, side.status);
      assert.equal(before?.latestAssignmentAnchor, undefined);
      assert.equal(before?.replyDelivery?.status, 'pending');
      assert.equal(
        (await DialogPersistence.loadActiveTellaskReplyObligation(side.id, side.status))
          ?.targetCallId,
        callId,
      );
      const deliveries: WebSocketMessage[] = [];
      const request = {
        sideDialog: side,
        responseText: answer,
        responseGenseq: 2,
        deliveryMode: 'reply_tool' as const,
        replyResolution: { callId: replyId, replyCallName: 'replyTellask' as const },
        scheduleDrive: () => undefined,
      };
      setDisplayStateBroadcaster((message) => deliveries.push(message));
      try {
        assert.equal(
          await supplySideDialogResponseToAssignedAskerIfPendingV2(request),
          false,
          'a missing rendered assignment anchor requires the explicit fallback authorization',
        );
        const pending = await DialogPersistence.loadDialogLatest(side.id, side.status);
        assert.equal(pending?.replyDelivery?.status, 'pending');
        assert.equal(
          (await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status)).length,
          1,
        );
        assert.equal(
          (await DialogPersistence.loadCourseEvents(root.id, 1, root.status)).filter(
            (event) => event.type === 'tellask_result_record',
          ).length,
          0,
        );
        const authorized = { ...request, allowExplicitReplyWithoutAssignmentAnchor: true };
        assert.equal(await supplySideDialogResponseToAssignedAskerIfPendingV2(authorized), true);
        await supplySideDialogResponseToAssignedAskerIfPendingV2(authorized);
      } finally {
        setDisplayStateBroadcaster(null);
      }
      const results = (await DialogPersistence.loadCourseEvents(root.id, 1, root.status))
        .filter((event) => event.type === 'tellask_result_record')
        .filter((event) => event.callId === callId);
      assert.equal(
        results.length,
        1,
        'repeated delivery cannot duplicate the canonical caller result',
      );
      assert.equal(results[0].status, 'completed');
      assert.ok(
        results[0].content.includes(answer),
        'the supplied opaque answer body survives delivery',
      );
      assert.equal(
        (await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status)).length,
        0,
      );
      assert.equal(
        await DialogPersistence.loadActiveTellaskReplyObligation(side.id, side.status),
        undefined,
      );
      const after = await DialogPersistence.loadDialogLatest(side.id, side.status);
      assert.equal(after?.replyDelivery?.status, 'delivered');
      assert.equal(after?.replyDelivery?.toolResultStatus, 'pending');
      assert.equal(after?.sideDialogFinalResponse?.callId, callId);
      const events = deliveries.filter((event) => event.type === 'dlg_display_state_evt');
      assert.equal(events.length, 1);
      assert.equal(events[0].dialog.rootId, root.id.rootId);
      assert.equal(events[0].dialog.selfId, side.id.selfId);
      assert.deepEqual(events[0].displayState, { kind: 'idle_waiting_user' });
    }
  });
  console.log(
    'explicit missing-anchor recovery delivers once and clears the exact obligation: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
