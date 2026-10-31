import assert from 'node:assert/strict';

import { DialogPersistence } from '../../main/persistence';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);

    const missingResponderDlg = await createMainDialog('tester');
    await assert.rejects(
      missingResponderDlg.receiveTellaskResult({
        type: 'tellask_result_msg',
        role: 'tool',
        callId: 'missing-responder',
        callName: 'askHuman',
        status: 'completed',
        content: 'Approved.',
        call: {
          tellaskContent: 'Need one human decision.',
        },
      }),
      Error,
    );
    const missingResponderEvents = await DialogPersistence.loadCourseEvents(
      missingResponderDlg.id,
      1,
      'running',
    );
    assert.equal(
      missingResponderEvents.some(
        (event) => event.type === 'tellask_result_record' && event.callId === 'missing-responder',
      ),
      false,
      'expected missing responderId to persist no tellask_result_record',
    );

    const missingContentDlg = await createMainDialog('tester');
    await assert.rejects(
      missingContentDlg.receiveTellaskResult({
        type: 'tellask_result_msg',
        role: 'tool',
        callId: 'missing-content',
        callName: 'askHuman',
        status: 'completed',
        content: 'Approved.',
        responder: {
          responderId: 'human',
        },
        call: {
          tellaskContent: '   ',
        },
      }),
      Error,
    );
    const missingContentEvents = await DialogPersistence.loadCourseEvents(
      missingContentDlg.id,
      1,
      'running',
    );
    assert.equal(
      missingContentEvents.some(
        (event) => event.type === 'tellask_result_record' && event.callId === 'missing-content',
      ),
      false,
      'expected empty tellaskContent to persist no tellask_result_record',
    );

    const missingSessionSlugDlg = await createMainDialog('tester');
    await assert.rejects(
      missingSessionSlugDlg.receiveTellaskResult({
        type: 'tellask_result_msg',
        role: 'tool',
        callId: 'missing-session-slug',
        callName: 'tellask',
        status: 'completed',
        content: 'Done.',
        responder: {
          responderId: 'mentor',
        },
        call: {
          tellaskContent: 'Review this plan.',
          mentionList: [],
        },
      }),
      Error,
    );
    const missingSessionSlugEvents = await DialogPersistence.loadCourseEvents(
      missingSessionSlugDlg.id,
      1,
      'running',
    );
    assert.equal(
      missingSessionSlugEvents.some(
        (event) =>
          event.type === 'tellask_result_record' && event.callId === 'missing-session-slug',
      ),
      false,
      'expected missing sessionSlug to persist no tellask_result_record',
    );
    // Valid adjacent inputs prove these APIs can persist a result after the invalid variants.
    for (const [callName, call] of [
      ['askHuman', { tellaskContent: 'Need one human decision.' }],
      [
        'tellask',
        {
          tellaskContent: 'Review this plan.',
          mentionList: ['@mentor'],
          sessionSlug: 'review-session',
        },
      ],
    ] as const) {
      const valid = await createMainDialog('tester');
      await valid.receiveTellaskResult({
        type: 'tellask_result_msg',
        role: 'tool',
        callId: `valid-${callName}`,
        callName,
        status: 'completed',
        content: 'supplied-reply-data',
        responder: {
          responderId: callName === 'askHuman' ? 'human' : 'mentor',
          agentId: callName === 'askHuman' ? 'human' : 'mentor',
          originMemberId: 'tester',
        },
        call: {
          tellaskContent: call.tellaskContent,
          ...('sessionSlug' in call
            ? { sessionSlug: call.sessionSlug, mentionList: ['@mentor'] }
            : {}),
        },
      });
      const records = (await DialogPersistence.loadCourseEvents(valid.id, 1, 'running')).filter(
        (event) => event.type === 'tellask_result_record',
      );
      assert.equal(records.length, 1);
      assert.equal(records[0]?.content, 'supplied-reply-data');
    }
  });

  console.log('persistence tellask-result-requires-canonical-fields: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`persistence tellask-result-requires-canonical-fields: FAIL\n${message}`);
  process.exit(1);
});
