import assert from 'node:assert/strict';

import { toCallSiteCourseNo } from '@longrun-ai/kernel/types/storage';
import { DialogPersistence } from '../../main/persistence';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);

    const dlg = await createMainDialog('tester');
    await dlg.startNewCourse('continue in course two');

    await assert.rejects(
      dlg.receiveTellaskResponse(
        'human',
        'askHuman',
        undefined,
        'Need one human decision.',
        'completed',
        undefined,
        {
          response: 'Approved.',
          agentId: 'human',
          callId: 'ask-human-cross-course',
          originMemberId: dlg.agentId,
          callSiteCourse: toCallSiteCourseNo(1),
        },
      ),
      /missing carryover content for cross-course response/u,
    );

    const courseTwoEvents = await DialogPersistence.loadCourseEvents(dlg.id, 2, 'running');
    assert.equal(
      courseTwoEvents.some(
        (event) =>
          (event.type === 'tellask_result_record' || event.type === 'tellask_carryover_record') &&
          event.callId === 'ask-human-cross-course',
      ),
      false,
      'expected cross-course tellask response without carryover content to persist nothing',
    );
  });

  console.log('persistence cross-course-tellask-requires-carryover-content: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`persistence cross-course-tellask-requires-carryover-content: FAIL\n${message}`);
  process.exit(1);
});
