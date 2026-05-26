import type {
  ActiveCalleeDispatchRecord,
  MainDialogMetadataFile,
} from '@longrun-ai/kernel/types/storage';
import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearInstalledGlobalDialogEventBroadcaster,
  installRecordingGlobalDialogEventBroadcaster,
} from '../../main/bootstrap/global-dialog-event-broadcaster';
import { DialogID, MainDialog } from '../../main/dialog';
import {
  createEmptyDialogNextStepState,
  createEmptyDialogTellaskCallState,
  createEmptyDialogTellaskResultState,
} from '../../main/dialog-latest-state';
import { supplySideDialogResponseToAssignedAskerIfPendingV2 } from '../../main/llm/kernel-driver/sideDialog';
import { DialogPersistence, DiskFileDialogStore } from '../../main/persistence';

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-reply-anchor-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  installRecordingGlobalDialogEventBroadcaster({
    label: 'tests/side-dialog/reply-missing-assignment-anchor',
  });
  try {
    return await fn();
  } finally {
    clearInstalledGlobalDialogEventBroadcaster();
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await withTempCwd(async () => {
    const rootId = new DialogID('11/22/replyanchor');
    const now = formatUnifiedTimestamp(new Date('2026-04-12T00:00:00.000Z'));
    const main = new MainDialog(
      new DiskFileDialogStore(rootId),
      'plans/reply-anchor.tsk',
      rootId,
      'mentor',
    );
    const metadata: MainDialogMetadataFile = {
      id: rootId.selfId,
      agentId: 'mentor',
      taskDocPath: 'plans/reply-anchor.tsk',
      createdAt: now,
    };
    await DialogPersistence.saveMainDialogMetadata(rootId, metadata, 'running');
    await DialogPersistence.mutateDialogLatest(rootId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 1,
        lastModified: now,
        status: 'active',
        generating: false,
        nextStep: createEmptyDialogNextStepState(),
        tellaskCalls: createEmptyDialogTellaskCallState(),
        tellaskResults: createEmptyDialogTellaskResultState(),
      },
    }));

    const side = await main.createSideDialog('fullstack', ['@fullstack'], 'please finish', {
      callName: 'tellask',
      originMemberId: 'mentor',
      askerDialogId: rootId.selfId,
      callId: 'call-root-asks-side',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      sessionSlug: 'reply-anchor',
    });
    const activeDispatch: ActiveCalleeDispatchRecord = {
      batchId: 'dispatch:reply-anchor',
      calleeDialogId: side.id.selfId,
      callId: 'call-root-asks-side',
      callName: 'tellask',
      mentionList: ['@fullstack'],
      tellaskContent: 'please finish',
      targetAgentId: 'fullstack',
      createdAt: now,
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      callType: 'B',
      sessionSlug: 'reply-anchor',
    };
    await DialogPersistence.appendActiveCalleeDispatch(rootId, activeDispatch);
    await DialogPersistence.setActiveTellaskReplyObligation(side.id, {
      expectedReplyCallName: 'replyTellask',
      targetDialogId: rootId.selfId,
      targetCallId: 'call-root-asks-side',
      tellaskContent: 'please finish',
    });
    await side.persistTellaskCall(
      'call-side-replies-root',
      'replyTellask',
      JSON.stringify({ replyContent: 'done' }),
      2,
    );

    const latestBefore = await DialogPersistence.loadDialogLatest(side.id, side.status);
    assert.ok(latestBefore, 'Expected side latest before reply delivery');
    assert.equal(latestBefore.latestAssignmentAnchor, undefined);
    assert.equal(latestBefore.replyDelivery?.status, 'pending');
    const activeObligationBefore = await DialogPersistence.loadActiveTellaskReplyObligation(
      side.id,
      side.status,
    );
    assert.equal(activeObligationBefore?.targetCallId, 'call-root-asks-side');

    const supplied = await supplySideDialogResponseToAssignedAskerIfPendingV2({
      sideDialog: side,
      responseText: 'done',
      responseGenseq: 2,
      deliveryMode: 'reply_tool',
      replyResolution: {
        callId: 'call-side-replies-root',
        replyCallName: 'replyTellask',
      },
      allowExplicitReplyWithoutAssignmentAnchor: true,
      scheduleDrive: () => undefined,
    });

    assert.equal(supplied, true);
    const activeAfter = await DialogPersistence.loadActiveCalleeDispatches(rootId, 'running');
    assert.equal(activeAfter.length, 0);
    const activeObligationAfter = await DialogPersistence.loadActiveTellaskReplyObligation(
      side.id,
      side.status,
    );
    assert.equal(activeObligationAfter, undefined);
    const sideLatestAfter = await DialogPersistence.loadDialogLatest(side.id, side.status);
    assert.equal(sideLatestAfter?.replyDelivery?.status, 'delivered');
    assert.equal(sideLatestAfter?.replyDelivery?.toolResultStatus, 'pending');
    assert.equal(sideLatestAfter?.sideDialogFinalResponse?.callId, 'call-root-asks-side');
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
