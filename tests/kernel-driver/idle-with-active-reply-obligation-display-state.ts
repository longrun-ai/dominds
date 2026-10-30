import assert from 'node:assert/strict';

import {
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
  type ActiveCalleeDispatchRecord,
} from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { setDialogDisplayState } from '../../main/dialog-display-state';
import { DialogPersistence } from '../../main/persistence';
import { createMainDialog, withTempRtws, writeStandardMinds } from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws, { extraMembers: ['helper', 'reviewer'] });
    const root = await createMainDialog('tester');
    const helper = await root.createSideDialog('helper', ['@helper'], 'request-data', {
      callName: 'tellaskSessionless',
      originMemberId: root.agentId,
      askerDialogId: root.id.selfId,
      callId: 'root-helper-call',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      collectiveTargets: ['helper'],
    });
    const obligation = {
      expectedReplyCallName: 'replyTellaskBack' as const,
      targetDialogId: helper.id.selfId,
      targetCallId: 'askback-call',
      tellaskContent: 'askback-data',
    };
    await DialogPersistence.setActiveTellaskReplyObligation(root.id, obligation);
    await setDialogDisplayState(root.id, { kind: 'idle_waiting_user' }, root.status);
    const mainLatest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.deepEqual(
      mainLatest?.displayState,
      { kind: 'proceeding' },
      'a reply obligation prevents an idle-user projection',
    );
    assert.equal(
      mainLatest?.executionMarker,
      undefined,
      'projection must not invent an interruption',
    );
    assert.deepEqual(
      await DialogPersistence.loadActiveTellaskReplyObligation(root.id, root.status),
      obligation,
    );

    const nested = await helper.createSideDialog('reviewer', ['@reviewer'], 'nested-request-data', {
      callName: 'tellaskSessionless',
      originMemberId: helper.agentId,
      askerDialogId: helper.id.selfId,
      callId: 'nested-review-call',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      collectiveTargets: ['reviewer'],
    });
    const pending: ActiveCalleeDispatchRecord = {
      calleeDialogId: nested.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      batchId: 'nested-batch',
      callName: 'tellaskSessionless',
      mentionList: ['@reviewer'],
      tellaskContent: 'nested-request-data',
      targetAgentId: 'reviewer',
      callId: 'nested-review-call',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      callType: 'C',
    };
    await DialogPersistence.appendActiveCalleeDispatch(helper.id, pending);
    await setDialogDisplayState(helper.id, { kind: 'idle_waiting_user' }, helper.status);
    const sideLatest = await DialogPersistence.loadDialogLatest(helper.id, helper.status);
    assert.deepEqual(
      sideLatest?.displayState,
      { kind: 'waiting_side_dialog' },
      'waiting for nested execution takes precedence over the reply owed to the parent',
    );
    assert.equal(sideLatest?.executionMarker, undefined);
    assert.equal(
      (await DialogPersistence.loadActiveCalleeDispatches(helper.id, helper.status))[0]?.callId,
      pending.callId,
    );
  });
  console.log('active reply and nested-wait run-control projection: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
