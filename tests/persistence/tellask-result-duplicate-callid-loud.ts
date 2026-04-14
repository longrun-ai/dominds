import assert from 'node:assert/strict';

import { DialogPersistence } from '../../main/persistence';
import { createRootDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);

    const dlg = await createRootDialog('tester');
    await dlg.receiveTellaskResult({
      type: 'tellask_result_msg',
      role: 'tool',
      genseq: 1,
      callId: 'duplicate-tellask-call',
      callName: 'tellaskBack',
      status: 'completed',
      content: 'First canonical reply.',
      responder: {
        responderId: 'mentor',
        agentId: 'mentor',
        originMemberId: 'mentor',
      },
      call: {
        tellaskContent: 'Need one clarified answer.',
      },
    });

    await assert.rejects(
      dlg.receiveTellaskResult({
        type: 'tellask_result_msg',
        role: 'tool',
        genseq: 1,
        callId: 'duplicate-tellask-call',
        callName: 'tellaskBack',
        status: 'completed',
        content: 'Second write must fail loudly.',
        responder: {
          responderId: 'mentor',
          agentId: 'mentor',
          originMemberId: 'mentor',
        },
        call: {
          tellaskContent: 'Need one clarified answer.',
        },
      }),
      /tellask_result duplicate callId invariant violation/u,
    );

    const events = await DialogPersistence.loadCourseEvents(dlg.id, 1, 'running');
    const tellaskResults = events.filter(
      (event) =>
        event.type === 'tellask_result_record' && event.callId === 'duplicate-tellask-call',
    );
    assert.equal(
      tellaskResults.length,
      1,
      'expected duplicate tellask result write to persist exactly one canonical record',
    );
    assert.equal(
      tellaskResults[0]?.content,
      'First canonical reply.',
      'expected first tellask result to remain canonical after duplicate rejection',
    );
  });

  console.log('persistence tellask-result-duplicate-callid-loud: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`persistence tellask-result-duplicate-callid-loud: FAIL\n${message}`);
  process.exit(1);
});
