import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SideDialogAssignmentFromAsker } from '@longrun-ai/kernel/types/storage';
import { DialogID } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';
import { materializeReminder } from '../../main/tool';
import {
  pendingTellaskReminderOwner,
  syncPendingTellaskReminderState,
} from '../../main/tools/pending-tellask-reminder';
import { createMainDialog } from '../kernel-driver/helpers';

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-pending-reminder-order-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function persistPendingSideDialog(args: {
  rootId: string;
  selfId: string;
  createdAt: string;
  lastModified: string;
  callId: string;
}): Promise<void> {
  const sideDialogId = new DialogID(args.selfId, args.rootId);
  const assignmentFromAsker: SideDialogAssignmentFromAsker = {
    callName: 'tellask',
    mentionList: ['@worker'],
    tellaskContent: 'Follow the current assignment',
    originMemberId: 'tester',
    askerDialogId: args.rootId,
    callId: args.callId,
  };
  await DialogPersistence.ensureSideDialogDirectory(sideDialogId, 'running');
  await DialogPersistence.saveSideDialogAskerStackState(
    sideDialogId,
    {
      askerStack: [
        {
          kind: 'asker_dialog_stack_frame',
          askerDialogId: args.rootId,
          assignmentFromAsker,
          tellaskReplyObligation: {
            expectedReplyCallName: 'replyTellask',
            targetDialogId: args.rootId,
            targetCallId: args.callId,
            tellaskContent: assignmentFromAsker.tellaskContent,
          },
        },
      ],
    },
    'running',
  );
  await DialogPersistence.saveSideDialogMetadata(
    sideDialogId,
    {
      id: args.selfId,
      agentId: 'worker',
      taskDocPath: 'task.md',
      createdAt: args.createdAt,
    },
    'running',
  );
  await DialogPersistence.mutateDialogLatest(sideDialogId, () => ({
    kind: 'patch',
    patch: {
      currentCourse: 1,
      lastModified: args.lastModified,
      status: 'active',
      messageCount: 0,
      functionCallCount: 0,
      sideDialogCount: 0,
      displayState: { kind: 'idle_waiting_user' },
      disableDiligencePush: false,
      diligencePushRemainingBudget: 0,
    },
  }));
}

async function main(): Promise<void> {
  await withTempCwd(async () => {
    const root = await createMainDialog('tester');
    const pendingReminderCreatedAt = '2026-04-16 10:00:00';
    const firstPendingActivityAt = '2026-04-16 10:05:00';
    const daemonCreatedAt = '2026-04-16 10:06:00';
    const secondPendingActivityAt = '2026-04-16 10:07:00';

    root.reminders.push(
      materializeReminder({
        id: 'pending001',
        content: 'stale pending tellask reminder',
        owner: pendingTellaskReminderOwner,
        createdAt: pendingReminderCreatedAt,
        meta: {
          kind: 'pending_tellask',
          pendingCount: 2,
          pendingSignature: 'stale',
          updatedAt: pendingReminderCreatedAt,
          update: { altInstruction: 'wait for system refresh' },
          delete: { altInstruction: 'do not delete while pending' },
        },
      }),
    );
    root.reminders.push(
      materializeReminder({
        id: 'daemon001',
        content: 'daemon reminder',
        createdAt: daemonCreatedAt,
      }),
    );

    await persistPendingSideDialog({
      rootId: root.id.rootId,
      selfId: 'sub001',
      createdAt: '2026-04-16 10:01:00',
      lastModified: '2026-04-16 10:03:00',
      callId: 'call-sub001',
    });
    await persistPendingSideDialog({
      rootId: root.id.rootId,
      selfId: 'sub002',
      createdAt: '2026-04-16 10:02:00',
      lastModified: firstPendingActivityAt,
      callId: 'call-sub002',
    });

    await DialogPersistence.savePendingSideDialogs(
      root.id,
      [
        {
          sideDialogId: 'sub001',
          createdAt: '2026-04-16 10:01:00',
          callName: 'tellask',
          mentionList: ['@worker'],
          tellaskContent: 'Follow the current assignment',
          targetAgentId: 'worker',
          callId: 'call-sub001',
          callSiteCourse: 1,
          callSiteGenseq: 1,
          callType: 'B',
        },
        {
          sideDialogId: 'sub002',
          createdAt: '2026-04-16 10:02:00',
          callName: 'tellask',
          mentionList: ['@worker'],
          tellaskContent: 'Follow the current assignment',
          targetAgentId: 'worker',
          callId: 'call-sub002',
          callSiteCourse: 1,
          callSiteGenseq: 1,
          callType: 'B',
        },
      ],
      undefined,
      root.status,
    );

    await syncPendingTellaskReminderState(root);
    let visible = await root.listVisibleReminders();
    assert.equal(
      visible[0]?.id,
      'daemon001',
      'Expected newer daemon reminder to sort first initially',
    );

    await persistPendingSideDialog({
      rootId: root.id.rootId,
      selfId: 'sub002',
      createdAt: '2026-04-16 10:02:00',
      lastModified: secondPendingActivityAt,
      callId: 'call-sub002',
    });

    await syncPendingTellaskReminderState(root);
    visible = await root.listVisibleReminders();
    assert.equal(
      visible[0]?.id,
      'pending001',
      'Expected pending-tellask reminder to sort ahead after a pending sideDialog becomes newer',
    );

    const pendingReminder = visible[0];
    assert.equal(
      (
        pendingReminder?.meta as
          | {
              updatedAt?: string;
            }
          | undefined
      )?.updatedAt,
      secondPendingActivityAt,
      'Expected pending-tellask reminder updatedAt to reflect the newest in-flight sideDialog',
    );
  });

  await withTempCwd(async () => {
    const root = await createMainDialog('tester');
    await assert.rejects(
      DialogPersistence.savePendingSideDialogs(
        root.id,
        [
          {
            sideDialogId: 'sub-old',
            createdAt: '2026-04-16 11:01:00',
            callName: 'tellask',
            mentionList: ['@worker'],
            tellaskContent: 'Old assignment',
            targetAgentId: 'worker',
            callId: 'call-old',
            callSiteCourse: 1,
            callSiteGenseq: 1,
            callType: 'B',
            sessionSlug: 'same-session',
          },
          {
            sideDialogId: 'sub-new',
            createdAt: '2026-04-16 11:02:00',
            callName: 'tellask',
            mentionList: ['@worker'],
            tellaskContent: 'New assignment',
            targetAgentId: 'worker',
            callId: 'call-new',
            callSiteCourse: 1,
            callSiteGenseq: 2,
            callType: 'B',
            sessionSlug: 'same-session',
          },
        ],
        undefined,
        root.status,
      ),
      /duplicate sessioned tellask pending record/,
      'Expected duplicate sessioned pending tellasks to fail loudly instead of being repaired',
    );
  });

  console.log('OK');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
