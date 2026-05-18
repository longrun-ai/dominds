import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
  toDialogCourseNumber,
} from '@longrun-ai/kernel/types/storage';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { driveQueuedDialogsOnce } from '../../main/llm/kernel-driver/loop';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  makeUserPrompt,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function readStallJsonl(tmpRoot: string, rootId: string): Promise<unknown[]> {
  const filePath = path.join(tmpRoot, '.dialogs', 'run', rootId, 'backend-drive-stalls.jsonl');
  const content = await fs.readFile(filePath, 'utf-8');
  return content
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);

    const userPrompt = makeUserPrompt(
      'Trigger a backend driver invariant failure.',
      'stall-prompt',
    );
    await writeMockDb(tmpRoot, [
      {
        message: userPrompt.content,
        role: 'user',
        response: 'This response must not be reached while the pre-drive hook rejects.',
      },
    ]);

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    globalDialogRegistry.register(root);

    await root.startNewCourse(userPrompt.content);
    root.canDrive = async () => {
      throw new Error('synthetic backend canDrive failure');
    };

    globalDialogRegistry.wakeDrive(root.id.rootId, {
      source: 'kernel_driver_test',
      reason: 'backend_drive_error_stall_first_attempt',
    });

    await driveQueuedDialogsOnce();

    const latestAfterFirst = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.equal(
      latestAfterFirst?.backendDriveStall?.kind,
      'backend_drive_error',
      'backend drive error should be persisted as a stall marker',
    );
    assert.match(
      latestAfterFirst?.backendDriveStall?.errorMessage ?? '',
      /synthetic backend canDrive failure/u,
      'stall marker should retain the failed drive reason',
    );

    const recordsAfterFirst = await readStallJsonl(tmpRoot, root.id.rootId);
    assert.equal(
      recordsAfterFirst.length,
      1,
      'first backend failure should append one stall record',
    );

    globalDialogRegistry.wakeDrive(root.id.rootId, {
      source: 'kernel_driver_test',
      reason: 'backend_drive_error_stall_same_facts',
    });

    await driveQueuedDialogsOnce();

    const recordsAfterSecond = await readStallJsonl(tmpRoot, root.id.rootId);
    assert.equal(
      recordsAfterSecond.length,
      1,
      'same durable work fingerprint must not be blindly retried after a persisted drive stall',
    );
    const latestAfterSecond = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.equal(
      latestAfterSecond?.nextStep.triggers.some((trigger) => trigger.kind === 'queued_prompt'),
      true,
      'stalled durable work must remain persisted for later diagnosis or state-changing recovery',
    );

    const baseLatest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.ok(baseLatest, 'expected latest after backend stall');
    const triggerBase = {
      triggerId: 'followup-continuation-fingerprint-probe',
      kind: 'followup' as const,
      sourceGeneration: {
        course: toDialogCourseNumber(root.currentCourse),
        genseq: toCallSiteGenseqNo(1),
      },
      reasons: [{ kind: 'ordinary_tool_result' as const, callIds: ['tool-call-a'] }],
      createdAt: '2026-01-01T00:00:00.000Z',
      seq: 9_001,
    };
    const fingerprintWithoutContinuation =
      DialogPersistence.buildBackendDriveDurableWorkFingerprint({
        ...baseLatest,
        nextStep: {
          nextSeq: 9_002,
          triggers: [triggerBase],
        },
      });
    const fingerprintWithContinuation = DialogPersistence.buildBackendDriveDurableWorkFingerprint({
      ...baseLatest,
      nextStep: {
        nextSeq: 9_002,
        triggers: [
          {
            ...triggerBase,
            continuation: {
              kind: 'inter_dialog_reply',
              tellaskReplyDirective: {
                expectedReplyCallName: 'replyTellaskSessionless',
                targetDialogId: root.id.selfId,
                targetCallId: 'reply-target-a',
                tellaskContent: 'Reply target is part of the durable continuation identity.',
              },
              calleeDialogReplyTarget: {
                callerDialogId: root.id.selfId,
                callType: 'C',
                callId: 'caller-call-a',
                callSiteCourse: toCallSiteCourseNo(1),
                callSiteGenseq: toCallSiteGenseqNo(1),
              },
            },
          },
        ],
      },
    });
    assert.notEqual(
      fingerprintWithContinuation,
      fingerprintWithoutContinuation,
      'backend stall fingerprint must change when durable followup continuation metadata changes',
    );
    assert.notEqual(
      DialogPersistence.buildBackendDriveDurableWorkFingerprint({
        ...baseLatest,
        executionMarker: {
          kind: 'interrupted',
          reason: 'user_paused',
          interruptedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
      DialogPersistence.buildBackendDriveDurableWorkFingerprint({
        ...baseLatest,
        executionMarker: undefined,
      }),
      'backend stall fingerprint must change when durable drive-blocking execution facts change',
    );
  });

  console.log('kernel-driver backend-loop-persists-drive-error-stall: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver backend-loop-persists-drive-error-stall: FAIL\n${message}`);
  process.exit(1);
});
