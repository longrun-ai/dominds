import assert from 'node:assert/strict';

import { DialogPersistence } from '../../main/persistence';
import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);

    const dlg = await createMainDialog('tester');
    await dlg.persistFunctionCall('duplicate-func-call', 'env_get', '{}', 1);
    await dlg.persistFunctionCall('duplicate-func-call', 'env_get', '{"second":true}', 1);

    await dlg.persistTellaskCall('duplicate-tellask-call', 'tellaskBack', '{}', 1);
    await assert.rejects(
      dlg.persistTellaskCall('duplicate-tellask-call', 'tellaskBack', '{"second":true}', 1),
      Error,
    );

    const events = await DialogPersistence.loadCourseEvents(dlg.id, 1, 'running');
    assert.deepEqual(
      events
        .filter(
          (event): event is Extract<typeof event, { type: 'func_call_record' }> =>
            event.type === 'func_call_record' && event.id === 'duplicate-func-call',
        )
        .map((event) => event.rawArgumentsText),
      ['{}', '{\"second\":true}'],
    );
    assert.deepEqual(
      events
        .filter(
          (event): event is Extract<typeof event, { type: 'tellask_call_record' }> =>
            event.type === 'tellask_call_record' && event.id === 'duplicate-tellask-call',
        )
        .map((event) => event.rawArgumentsText),
      ['{}'],
    );
    assert.equal(
      events.filter(
        (event): event is Extract<typeof event, { type: 'func_call_record' }> =>
          event.type === 'func_call_record' && event.id === 'duplicate-func-call',
      ).length,
      2,
      'expected raw duplicate ordinary function call writes to both persist',
    );
    assert.equal(
      events.filter(
        (event): event is Extract<typeof event, { type: 'tellask_call_record' }> =>
          event.type === 'tellask_call_record' && event.id === 'duplicate-tellask-call',
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
