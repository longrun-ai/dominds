import assert from 'node:assert/strict';

import {
  getRunControlCountsSnapshot,
  isDialogLatestResumable,
} from '../../main/dialog-display-state';
import { DialogPersistence } from '../../main/persistence';
import { formatNewCourseStartPrompt } from '../../main/runtime/driver-messages';
import { setWorkLanguage } from '../../main/runtime/work-language';

import { createMainDialog, withTempRtws, writeStandardMinds } from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createMainDialog('tester');
    const sideDialog = await root.createSideDialog(
      'pangu',
      ['@pangu'],
      'Resume me after restart.',
      {
        callName: 'tellask',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId: 'call-pending-course-start-resume-all',
        sessionSlug: 'pending-course-start-resume-all',
        collectiveTargets: ['pangu'],
      },
    );

    await DialogPersistence.savePendingSideDialogs(root.id, [
      {
        sideDialogId: sideDialog.id.selfId,
        createdAt: '2026-04-15 00:00:00',
        callName: 'tellask',
        mentionList: ['@pangu'],
        tellaskContent: 'Resume me after restart.',
        targetAgentId: 'pangu',
        callId: 'call-pending-course-start-resume-all',
        callSiteCourse: 1,
        callSiteGenseq: 1,
        callType: 'B',
        sessionSlug: 'pending-course-start-resume-all',
      },
    ]);

    await sideDialog.startNewCourse(
      formatNewCourseStartPrompt('en', {
        nextCourse: 2,
        source: 'clear_mind',
      }),
    );

    const latest = await DialogPersistence.loadDialogLatest(sideDialog.id, sideDialog.status);
    assert.ok(latest?.pendingCourseStartPrompt, 'expected durable pending course-start prompt');
    assert.deepEqual(
      latest?.displayState,
      {
        kind: 'stopped',
        reason: { kind: 'pending_course_start' },
        continueEnabled: true,
      },
      'pending course-start prompts should persist as stopped/resumable display state',
    );
    assert.deepEqual(
      latest?.executionMarker,
      {
        kind: 'interrupted',
        reason: { kind: 'pending_course_start' },
      },
      'pending course-start prompts should persist an interrupted execution marker',
    );
    assert.equal(
      isDialogLatestResumable(latest),
      true,
      'dialogs with a durable pending course-start prompt should be resumable for resume_all',
    );

    const counts = await getRunControlCountsSnapshot();
    assert.equal(
      counts.resumable,
      1,
      'run-control snapshot should count durable pending course-start prompts as resumable',
    );
  });

  console.log('kernel-driver sideDialog-pending-course-start-counts-as-resumable: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `kernel-driver sideDialog-pending-course-start-counts-as-resumable: FAIL\n${message}`,
  );
  process.exit(1);
});
