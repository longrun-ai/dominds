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
        genseq: 1,
        callId: 'missing-responder',
        callName: 'askHuman',
        status: 'completed',
        content: 'Approved.',
        call: {
          tellaskContent: 'Need one human decision.',
        },
      }),
      /missing responderId/u,
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
        genseq: 1,
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
      /empty tellaskContent/u,
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
        genseq: 1,
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
      /missing sessionSlug/u,
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
  });

  console.log('persistence tellask-result-requires-canonical-fields: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`persistence tellask-result-requires-canonical-fields: FAIL\n${message}`);
  process.exit(1);
});
