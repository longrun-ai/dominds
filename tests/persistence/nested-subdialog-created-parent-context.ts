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
import { createRootDialog } from '../kernel-driver/helpers';

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-nested-subdialog-'));
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
      label: 'tests/nested-subdialog-created-parent-context',
    });
    const recorder = requireRecordingGlobalDialogEventRecorder(
      'nested-subdialog-created-parent-context',
    );

    try {
      const root = await createRootDialog();
      const parentSubdialog = await root.createSubDialog(
        'mentor',
        ['@mentor'],
        'Open the parent sideline.',
        {
          callName: 'tellaskSessionless',
          originMemberId: 'tester',
          callerDialogId: root.id.selfId,
          callId: 'root-to-mentor',
        },
      );

      recorder.clear();

      const nestedSubdialog = await parentSubdialog.createSubDialog(
        'ux-tester',
        undefined,
        'Run a nested FBR follow-up.',
        {
          callName: 'freshBootsReasoning',
          originMemberId: 'mentor',
          callerDialogId: parentSubdialog.id.selfId,
          callId: 'mentor-fbr-1',
          effectiveFbrEffort: 1,
        },
      );

      const nestedMeta = await DialogPersistence.loadDialogMetadata(nestedSubdialog.id, 'running');
      assert.ok(nestedMeta, 'nested subdialog metadata should be persisted');
      assert.equal(
        nestedMeta?.supdialogId,
        parentSubdialog.id.selfId,
        'nested subdialog metadata must point supdialogId at the actual caller subdialog',
      );
      assert.equal(
        nestedMeta?.assignmentFromSup?.callerDialogId,
        parentSubdialog.id.selfId,
        'nested subdialog assignment must keep callerDialogId on the actual caller subdialog',
      );

      const parentCourseEvents = await DialogPersistence.readCourseEvents(
        parentSubdialog.id,
        parentSubdialog.currentCourse,
        parentSubdialog.status,
      );
      const createdRecord = parentCourseEvents.find(
        (
          event,
        ): event is Extract<
          (typeof parentCourseEvents)[number],
          { type: 'subdialog_created_record' }
        > =>
          event.type === 'subdialog_created_record' &&
          event.subdialogId === nestedSubdialog.id.selfId,
      );
      assert.ok(createdRecord, 'caller subdialog course should record nested subdialog creation');
      assert.equal(
        createdRecord?.supdialogId,
        parentSubdialog.id.selfId,
        'nested subdialog created record must target the actual caller subdialog',
      );
      assert.equal(
        createdRecord?.assignmentFromSup.callerDialogId,
        parentSubdialog.id.selfId,
        'nested subdialog created record must keep callerDialogId on the actual caller subdialog',
      );

      const received: readonly TypedDialogEvent[] = recorder.snapshot();
      const nestedCreatedEvent = received.find(
        (evt): evt is Extract<TypedDialogEvent, { type: 'subdialog_created_evt' }> =>
          evt.type === 'subdialog_created_evt' &&
          evt.subDialog.selfId === nestedSubdialog.id.selfId,
      );
      assert.ok(nestedCreatedEvent, 'global broadcast should include nested subdialog_created_evt');
      assert.equal(
        nestedCreatedEvent?.parentDialog.selfId,
        parentSubdialog.id.selfId,
        'nested subdialog live event must point parentDialog at the actual caller subdialog',
      );
      assert.equal(
        nestedCreatedEvent?.subDialogNode.supdialogId,
        parentSubdialog.id.selfId,
        'nested subdialog live node must point supdialogId at the actual caller subdialog',
      );
      assert.equal(
        nestedCreatedEvent?.subDialogNode.assignmentFromSup?.callerDialogId,
        parentSubdialog.id.selfId,
        'nested subdialog live node must keep callerDialogId on the actual caller subdialog',
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
