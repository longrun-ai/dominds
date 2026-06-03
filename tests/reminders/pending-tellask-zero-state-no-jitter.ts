import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { SideDialogAssignmentFromAsker } from '@longrun-ai/kernel/types/storage';
import YAML from 'yaml';
import { DialogID } from '../../main/dialog';
import {
  createEmptyDialogNextStepState,
  createEmptyDialogTellaskCallState,
  createEmptyDialogTellaskResultState,
} from '../../main/dialog-latest-state';
import { DialogPersistence } from '../../main/persistence';
import {
  pendingTellaskReminderOwner,
  syncPendingTellaskReminderState,
} from '../../main/tools/pending-tellask-reminder';
import { createMainDialog } from '../kernel-driver/helpers';
import { withTempCwd } from './daemon-test-utils';

async function writeYaml(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, YAML.stringify(value), 'utf-8');
}

async function persistActiveCalleeDispatch(args: {
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
    callSiteCourse: 1,
    callSiteGenseq: 1,
    collectiveTargets: ['worker'],
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
  await writeYaml(
    path.join(DialogPersistence.getDialogEventsPath(sideDialogId, 'running'), 'latest.yaml'),
    {
      currentCourse: 1,
      lastModified: args.lastModified,
      status: 'active',
      messageCount: 0,
      functionCallCount: 0,
      sideDialogCount: 0,
      nextStep: createEmptyDialogNextStepState(),
      tellaskCalls: createEmptyDialogTellaskCallState(),
      tellaskResults: createEmptyDialogTellaskResultState(),
      displayState: { kind: 'idle_waiting_user' },
      disableDiligencePush: false,
      diligencePushRemainingBudget: 0,
    },
  );
}

function requirePendingReminder(root: Awaited<ReturnType<typeof createMainDialog>>) {
  return root.reminders.find((reminder) => reminder.owner === pendingTellaskReminderOwner);
}

async function main(): Promise<void> {
  await withTempCwd('dominds-pending-reminder-zero-jitter-', async () => {
    const root = await createMainDialog('tester');

    await persistActiveCalleeDispatch({
      rootId: root.id.rootId,
      selfId: 'sub001',
      createdAt: '2026-04-16 10:01:00',
      lastModified: '2026-04-16 10:03:00',
      callId: 'call-sub001',
    });
    await DialogPersistence.saveActiveCalleeDispatches(
      root.id,
      [
        {
          calleeDialogId: 'sub001',
          createdAt: '2026-04-16 10:01:00',
          batchId: 'call-sub001-batch',
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

    await DialogPersistence.saveActiveCalleeDispatches(root.id, [], undefined, root.status);
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
