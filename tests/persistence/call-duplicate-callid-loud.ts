import assert from 'node:assert/strict';

import { DialogPersistence } from '../../main/persistence';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);

    const dlg = await createMainDialog('tester');
    await dlg.persistFunctionCall('duplicate-func-call', 'env_get', '{}', 1);

    await assert.rejects(
      dlg.persistFunctionCall('duplicate-func-call', 'env_get', '{"second":true}', 1),
      /func_call duplicate callId invariant violation/u,
    );

    await dlg.persistTellaskCall('duplicate-tellask-call', 'tellaskBack', '{}', 1);
    await assert.rejects(
      dlg.persistTellaskCall('duplicate-tellask-call', 'tellaskBack', '{"second":true}', 1),
      /tellask_call duplicate callId invariant violation/u,
    );

    const events = await DialogPersistence.loadCourseEvents(dlg.id, 1, 'running');
    assert.equal(
      events.filter(
        (event) => event.type === 'func_call_record' && event.id === 'duplicate-func-call',
      ).length,
      1,
      'expected duplicate func call write to persist exactly one canonical call record',
    );
    assert.equal(
      events.filter(
        (event) => event.type === 'tellask_call_record' && event.id === 'duplicate-tellask-call',
      ).length,
      1,
      'expected duplicate tellask call write to persist exactly one canonical call record',
    );
  });

  console.log('persistence call-duplicate-callid-loud: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`persistence call-duplicate-callid-loud: FAIL\n${message}`);
  process.exit(1);
});
