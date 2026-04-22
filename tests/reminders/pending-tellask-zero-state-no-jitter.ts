import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DialogID } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';
import {
  pendingTellaskReminderOwner,
  syncPendingTellaskReminderState,
} from '../../main/tools/pending-tellask-reminder';
import { createMainDialog } from '../kernel-driver/helpers';

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'dominds-pending-reminder-zero-jitter-'),
  );
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
  await DialogPersistence.ensureSideDialogDirectory(sideDialogId, 'running');
  await DialogPersistence.saveSideDialogMetadata(
    sideDialogId,
    {
      id: args.selfId,
      agentId: 'worker',
      taskDocPath: 'task.md',
      createdAt: args.createdAt,
      askerDialogId: args.rootId,
      assignmentFromAsker: {
        callName: 'tellask',
        mentionList: ['@worker'],
        tellaskContent: 'Follow the current assignment',
        originMemberId: 'tester',
        askerDialogId: args.rootId,
        callId: args.callId,
      },
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

function requirePendingReminder(root: Awaited<ReturnType<typeof createMainDialog>>) {
  return root.reminders.find((reminder) => reminder.owner === pendingTellaskReminderOwner);
}

async function main(): Promise<void> {
  await withTempCwd(async () => {
    const root = await createMainDialog('tester');

    await persistPendingSideDialog({
      rootId: root.id.rootId,
      selfId: 'sub001',
      createdAt: '2026-04-16 10:01:00',
      lastModified: '2026-04-16 10:03:00',
      callId: 'call-sub001',
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
      ],
      undefined,
      root.status,
    );

    await syncPendingTellaskReminderState(root);

    await DialogPersistence.savePendingSideDialogs(root.id, [], undefined, root.status);
    await syncPendingTellaskReminderState(root);

    const zeroStateReminder = requirePendingReminder(root);
    assert.notEqual(zeroStateReminder, undefined, 'Expected zero-state pending tellask reminder');
    if (zeroStateReminder === undefined) {
      throw new Error('Expected zero-state pending tellask reminder');
    }
    const zeroStateUpdatedAt =
      zeroStateReminder.meta &&
      typeof zeroStateReminder.meta === 'object' &&
      !Array.isArray(zeroStateReminder.meta) &&
      typeof zeroStateReminder.meta['updatedAt'] === 'string'
        ? zeroStateReminder.meta['updatedAt']
        : undefined;
    assert.equal(
      typeof zeroStateUpdatedAt,
      'string',
      'Expected zero-state pending tellask reminder to carry updatedAt',
    );
    const beforeDialogUpdatedAt = root.updatedAt;

    await syncPendingTellaskReminderState(root);

    const stableReminder = requirePendingReminder(root);
    assert.notEqual(stableReminder, undefined, 'Expected zero-state pending tellask reminder');
    if (stableReminder === undefined) {
      throw new Error('Expected zero-state pending tellask reminder');
    }
    const stableUpdatedAt =
      stableReminder.meta &&
      typeof stableReminder.meta === 'object' &&
      !Array.isArray(stableReminder.meta) &&
      typeof stableReminder.meta['updatedAt'] === 'string'
        ? stableReminder.meta['updatedAt']
        : undefined;
    assert.equal(
      stableUpdatedAt,
      zeroStateUpdatedAt,
      'Expected zero-state pending tellask reminder updatedAt to stay stable across no-op syncs',
    );
    assert.equal(
      root.updatedAt,
      beforeDialogUpdatedAt,
      'Expected zero-state pending tellask reminder not to touch dialog updatedAt on no-op sync',
    );
  });

  console.log('OK');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
