import assert from 'node:assert/strict';

import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { SideDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { driveQueuedDialogsOnce } from '../../main/llm/kernel-driver/loop';
import { supplyResponseToAskerDialog } from '../../main/llm/kernel-driver/sideDialog';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  hasPendingNextStepTriggers,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

function lastSideDialogAssistantSaying(dlg: SideDialog): string | null {
  for (let i = dlg.msgs.length - 1; i >= 0; i -= 1) {
    const msg = dlg.msgs[i];
    if (msg && msg.type === 'saying_msg' && msg.role === 'assistant') {
      return typeof msg.content === 'string' ? msg.content : null;
    }
  }
  return null;
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, {
      extraMembers: ['fullstack', 'mentor'],
    });
    await writeMockDb(tmpRoot, [
      {
        role: 'tool',
        message:
          'Error: there is no longer a pending inter-dialog reply obligation for this dialog (it may already be resolved or no longer valid).\n\nDo not call `replyTellask` again; continue the current local conversation instead.',
        contextContains: ['mentor finished the nested task'],
        response: 'Caller resumed from watched side-dialog result arrival.',
      },
    ]);

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    globalDialogRegistry.register(root);

    const caller = await root.createSideDialog(
      'fullstack',
      ['@fullstack'],
      'Please coordinate the nested work.',
      {
        callName: 'tellask',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId: 'root-to-caller',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        sessionSlug: 'watched-caller',
        collectiveTargets: ['fullstack'],
      },
    );
    const callee = await caller.createSideDialog(
      'mentor',
      ['@mentor'],
      'Please finish the nested task.',
      {
        callName: 'tellaskSessionless',
        originMemberId: 'fullstack',
        askerDialogId: caller.id.selfId,
        callId: 'caller-to-callee',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(2),
        collectiveTargets: ['mentor'],
      },
    );

    await DialogPersistence.appendActiveCalleeDispatch(caller.id, {
      batchId: 'dispatch:test:caller:c1:g2',
      calleeDialogId: callee.id.selfId,
      callId: 'caller-to-callee',
      callName: 'tellaskSessionless',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(2),
      callType: 'C',
      createdAt: formatUnifiedTimestamp(new Date()),
      mentionList: ['@mentor'],
      targetAgentId: 'mentor',
      tellaskContent: 'Please finish the nested task.',
    });

    await supplyResponseToAskerDialog({
      callerDialog: caller,
      sideDialogId: callee.id,
      responseText: 'mentor finished the nested task',
      callType: 'C',
      callId: 'caller-to-callee',
      calleeResponseRef: { course: 1, genseq: 1 },
      scheduleDrive: () => {},
    });

    const callerLatestAfterReply = await DialogPersistence.loadDialogLatest(
      caller.id,
      caller.status,
    );
    assert.equal(
      hasPendingNextStepTriggers(callerLatestAfterReply),
      true,
      'side-dialog caller should retain durable result_arrival trigger when direct schedule is lost',
    );

    const watched = await DialogPersistence.loadDriveWatchedDialogIds(root.id, root.status);
    assert.ok(
      watched.some((dialogId) => dialogId.selfId === caller.id.selfId),
      'side-dialog caller with durable result_arrival must be in root drive watch index',
    );

    await driveQueuedDialogsOnce();
    await waitForAllDialogsUnlocked(root, 3_000);

    assert.equal(
      lastSideDialogAssistantSaying(caller),
      'Caller resumed from watched side-dialog result arrival.',
    );
    const callerLatestAfterDrive = await DialogPersistence.loadDialogLatest(
      caller.id,
      caller.status,
    );
    assert.equal(
      hasPendingNextStepTriggers(callerLatestAfterDrive),
      false,
      'backend watch revive should consume side-dialog caller result_arrival trigger',
    );
  });

  console.log('kernel-driver sideDialog-caller-result-arrival-backend-watch: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver sideDialog-caller-result-arrival-backend-watch: FAIL\n${message}`);
  process.exit(1);
});
