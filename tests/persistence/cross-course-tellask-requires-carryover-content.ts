import { toCallSiteCourseNo } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';
import { DialogPersistence } from '../../main/persistence';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-cross-course-result-');
async function main(): Promise<void> {
  await withTempRtws(async (root) => {
    await writeStandardMinds(root);
    const dlg = await createMainDialog('tester');
    await dlg.startNewCourse('continue in course two');
    const options = {
      response: 'provided-human-reply-data',
      agentId: 'human',
      callId: 'ask-human-cross-course',
      originMemberId: dlg.agentId,
      callSiteCourse: toCallSiteCourseNo(1),
    };
    const errors: Record<string, string> = {};
    for (const [name, extra] of [
      ['missing', {}],
      ['empty', { carryoverContent: '   ' }],
    ] as const) {
      await assert.rejects(
        dlg.receiveTellaskResponse(
          'human',
          'askHuman',
          undefined,
          'provided-old-question-data',
          'completed',
          undefined,
          { ...options, ...extra },
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          errors[name] = error.message;
          return true;
        },
      );
    }
    const before = await DialogPersistence.loadCourseEvents(dlg.id, 2, 'running');
    assert.deepEqual(
      before.filter(
        (event) =>
          (event.type === 'tellask_result_record' || event.type === 'tellask_carryover_record') &&
          event.callId === options.callId,
      ),
      [],
    );
    const carryover = 'provided-complete-carryover-data';
    const result = await dlg.receiveTellaskResponse(
      'human',
      'askHuman',
      undefined,
      'provided-old-question-data',
      'completed',
      undefined,
      { ...options, carryoverContent: carryover },
    );
    assert.equal(result.type, 'tellask_carryover_msg');
    const after = await DialogPersistence.loadCourseEvents(dlg.id, 2, 'running');
    const records = after.filter(
      (event): event is Extract<typeof event, { type: 'tellask_carryover_record' }> =>
        event.type === 'tellask_carryover_record' && event.callId === options.callId,
    );
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record);
    assert.equal(record.content, carryover);
    assert.equal(record.response, options.response);
    assert.equal(record.tellaskContent, 'provided-old-question-data');
    assert.equal(record.callSiteCourse, 1);
    assert.equal(record.carryoverCourse, 2);
    assert.equal(
      after.some(
        (event) => event.type === 'tellask_result_record' && event.callId === options.callId,
      ),
      false,
    );
    evidence.record({
      id: 'missing-and-empty',
      scenario:
        'An older-course human reply arrives in course two. Missing and empty carryover bodies are refused without storing a reply; the same call succeeds with supplied carryover data as exactly one current-course carryover, without a fabricated tool-result pair.',
      businessValue:
        'Keep an older reply understandable in the current course while refusing incomplete restoration data without losing its call identity.',
      context: {
        callSiteCourse: 1,
        currentCourse: 2,
        rejectedVariantsStoredNothing: true,
        validCarryoverAccepted: true,
        scope:
          'Direct dialog/persistence calls with supplied body data, not live human communication or model comprehension.',
      },
      reviewQuestions: [
        'Do the actual refusal diagnostics accurately distinguish missing/empty carryover content and identify the affected cross-course reply without claiming it was stored?',
      ],
      actualText: JSON.stringify(errors, null, 2),
    });
  });
  await evidence.write();
  console.log(
    'cross-course refusal preserves state; valid carryover stores exact original data once: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
