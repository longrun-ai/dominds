import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import {
  clearInstalledGlobalDialogEventBroadcaster,
  installRecordingGlobalDialogEventBroadcaster,
  requireRecordingGlobalDialogEventRecorder,
} from '../../main/bootstrap/global-dialog-event-broadcaster';
import { DialogPersistence } from '../../main/persistence';
import { createMainDialog } from '../kernel-driver/helpers';

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-nested-sideDialog-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await withTempCwd(async () => {
    installRecordingGlobalDialogEventBroadcaster({
      label: 'tests/nested-sideDialog-created-parent-context',
    });
    const recorder = requireRecordingGlobalDialogEventRecorder(
      'nested-sideDialog-created-parent-context',
    );

    try {
      const root = await createMainDialog();
      const parentSideDialog = await root.createSideDialog(
        'mentor',
        ['@mentor'],
        'Open the parent side dialog.',
        {
          callName: 'tellaskSessionless',
          originMemberId: 'tester',
          askerDialogId: root.id.selfId,
          callId: 'root-to-mentor',
          callSiteCourse: 1,
          callSiteGenseq: 1,
        },
      );

      recorder.clear();

      const nestedSideDialog = await parentSideDialog.createSideDialog(
        'ux-tester',
        undefined,
        'Run a nested FBR follow-up.',
        {
          callName: 'freshBootsReasoning',
          originMemberId: 'mentor',
          askerDialogId: parentSideDialog.id.selfId,
          callId: 'mentor-fbr-1',
          callSiteCourse: 1,
          callSiteGenseq: 1,
          effectiveFbrEffort: 1,
        },
      );

      const nestedMeta = await DialogPersistence.loadDialogMetadata(nestedSideDialog.id, 'running');
      assert.ok(nestedMeta, 'nested sideDialog metadata should be persisted');
      assert.equal(
        'askerDialogId' in nestedMeta,
        false,
        'sideDialog metadata must not store askerDialogId',
      );
      assert.equal(
        'assignmentFromAsker' in nestedMeta,
        false,
        'sideDialog metadata must not store assignmentFromAsker',
      );
      const nestedAskerStack = await DialogPersistence.loadSideDialogAskerStackState(
        nestedSideDialog.id,
        'running',
      );
      assert.ok(nestedAskerStack, 'nested sideDialog asker stack should be persisted');
      assert.equal(
        nestedAskerStack.askerStack.at(-1)?.askerDialogId,
        parentSideDialog.id.selfId,
        'nested sideDialog asker stack must point at the actual asker sideDialog',
      );
      assert.equal(
        nestedAskerStack.askerStack.at(-1)?.assignmentFromAsker?.askerDialogId,
        parentSideDialog.id.selfId,
        'nested sideDialog assignment stack frame must keep askerDialogId on the actual asker sideDialog',
      );

      const parentCourseEvents = await DialogPersistence.readCourseEvents(
        parentSideDialog.id,
        parentSideDialog.currentCourse,
        parentSideDialog.status,
      );
      const createdRecord = parentCourseEvents.find(
        (
          event,
        ): event is Extract<
          (typeof parentCourseEvents)[number],
          { type: 'sideDialog_created_record' }
        > =>
          event.type === 'sideDialog_created_record' &&
          event.sideDialogId === nestedSideDialog.id.selfId,
      );
      assert.ok(createdRecord, 'asker sideDialog course should record nested sideDialog creation');
      assert.equal(
        createdRecord?.askerDialogId,
        parentSideDialog.id.selfId,
        'nested sideDialog created record must target the actual asker sideDialog',
      );
      assert.equal(
        createdRecord?.assignmentFromAsker.askerDialogId,
        parentSideDialog.id.selfId,
        'nested sideDialog created record must keep askerDialogId on the actual asker sideDialog',
      );

      const received: readonly TypedDialogEvent[] = recorder.snapshot();
      const nestedCreatedEvent = received.find(
        (evt): evt is Extract<TypedDialogEvent, { type: 'sideDialog_created_evt' }> =>
          evt.type === 'sideDialog_created_evt' &&
          evt.sideDialog.selfId === nestedSideDialog.id.selfId,
      );
      assert.ok(
        nestedCreatedEvent,
        'global broadcast should include nested sideDialog_created_evt',
      );
      assert.equal(
        nestedCreatedEvent?.parentDialog.selfId,
        parentSideDialog.id.selfId,
        'nested sideDialog live event must point parentDialog at the actual asker sideDialog',
      );
      assert.equal(
        nestedCreatedEvent?.sideDialogNode.askerDialogId,
        parentSideDialog.id.selfId,
        'nested sideDialog live node must point askerDialogId at the actual asker sideDialog',
      );
      assert.equal(
        nestedCreatedEvent?.sideDialogNode.assignmentFromAsker?.askerDialogId,
        parentSideDialog.id.selfId,
        'nested sideDialog live node must keep askerDialogId on the actual asker sideDialog',
      );
    } finally {
      clearInstalledGlobalDialogEventBroadcaster();
    }
  });
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
