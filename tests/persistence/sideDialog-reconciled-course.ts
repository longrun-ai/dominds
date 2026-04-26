import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearInstalledGlobalDialogEventBroadcaster,
  installRecordingGlobalDialogEventBroadcaster,
} from '../../main/bootstrap/global-dialog-event-broadcaster';
import { DialogPersistence } from '../../main/persistence';
import { createMainDialog } from '../kernel-driver/helpers';

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-sideDialog-course-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn(sandboxDir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await withTempCwd(async () => {
    installRecordingGlobalDialogEventBroadcaster({
      label: 'tests/sideDialog-reconciled-course',
    });
    try {
      const root = await createMainDialog();
      const sideDialog = await root.createSideDialog(
        'tester',
        ['@tester'],
        'debug current course',
        {
          callName: 'tellaskSessionless',
          originMemberId: 'tester',
          askerDialogId: root.id.selfId,
          callId: 'call-sideDialog-course-regression',
          callSiteCourse: 1,
          callSiteGenseq: 1,
        },
      );

      assert.equal(
        root.currentCourse,
        1,
        'main dialog should stay on course #1 for this regression',
      );
      await sideDialog.startNewCourse('continue in course two');
      assert.equal(sideDialog.currentCourse, 2, 'sideDialog should advance to course #2');

      const course1Before = await DialogPersistence.readCourseEvents(sideDialog.id, 1, 'running');
      const course2Before = await DialogPersistence.readCourseEvents(sideDialog.id, 2, 'running');
      const course1ReminderCountBefore = course1Before.filter(
        (event) => event.type === 'reminders_reconciled_record',
      ).length;
      const course2ReminderCountBefore = course2Before.filter(
        (event) => event.type === 'reminders_reconciled_record',
      ).length;

      sideDialog.addReminder('persist on sideDialog course two');
      await sideDialog.processReminderUpdates();

      const latest = await DialogPersistence.loadDialogLatest(sideDialog.id, 'running');
      assert.ok(latest, 'sideDialog latest.yaml should exist');
      assert.equal(
        latest.currentCourse,
        2,
        'reconciled sideDialog records must not downgrade latest.currentCourse back to root course',
      );

      const course1 = await DialogPersistence.readCourseEvents(sideDialog.id, 1, 'running');
      const course2 = await DialogPersistence.readCourseEvents(sideDialog.id, 2, 'running');
      const course1ReminderCountAfter = course1.filter(
        (event) => event.type === 'reminders_reconciled_record',
      ).length;
      const course2ReminderCountAfter = course2.filter(
        (event) => event.type === 'reminders_reconciled_record',
      ).length;

      assert.equal(
        course1ReminderCountAfter,
        course1ReminderCountBefore,
        'reconciled reminder state must not append new records to sideDialog course #1 after clear_mind',
      );
      assert.equal(
        course2ReminderCountAfter,
        course2ReminderCountBefore + 1,
        'reconciled reminder state must append exactly one new record to the active sideDialog course',
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
