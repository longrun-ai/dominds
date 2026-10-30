import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { recordDialogEvents } from '../helpers/dialog-events';
import {
  createMainDialog,
  makeUserPrompt,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws, { memberTools: ['env_get'] });
    for (const variant of ['historical', 'same-round'] as const) {
      const key = `DOMINDS_TEST_RAW_CALL_ID_${variant.replaceAll('-', '_')}`;
      const previous = process.env[key];
      const resultPayload = `env-result-data-${variant}`;
      const finalPayload = `recovered-data-${variant}`;
      process.env[key] = resultPayload;
      try {
        const rawId = `duplicate-raw-id-${variant}`;
        const count = variant === 'same-round' ? 2 : 1;
        const trigger = `trigger-data-${variant}`;
        await writeMockDb(rtws, [
          {
            message: trigger,
            role: 'user',
            response: '',
            funcCalls: Array.from({ length: count }, () => ({
              id: rawId,
              name: 'env_get',
              arguments: { key },
            })),
          },
          { message: resultPayload, role: 'tool', response: finalPayload },
        ]);
        const root = await createMainDialog('tester');
        root.disableDiligencePush = true;
        if (variant === 'historical') await root.persistFunctionCall(rawId, 'env_get', '{}', 1);
        const recorder = recordDialogEvents(root);
        await driveDialogStream(root, makeUserPrompt(trigger, `duplicate-user-${variant}`), true);
        await waitForAllDialogsUnlocked(root, 3_000);
        const calls = root.msgs
          .filter((message) => message.type === 'func_call_msg')
          .filter((message) => message.name === 'env_get');
        assert.equal(calls.length, count);
        const remapped = calls.at(-1);
        assert.ok(remapped);
        assert.equal(remapped.rawId, rawId);
        assert.notEqual(remapped.id, rawId);
        if (variant === 'same-round') assert.equal(calls[0].id, rawId);
        const results = root.msgs
          .filter((message) => message.type === 'func_result_msg')
          .filter((message) => message.name === 'env_get');
        assert.deepEqual(
          results.map((result) => result.id),
          calls.map((call) => call.id),
          'each executed call has one result under its effective identity',
        );
        assert.ok(results.every((result) => result.content === resultPayload));
        const persisted = await DialogPersistence.loadCourseEvents(root.id, 1, root.status);
        const rawRecords = persisted
          .filter((record) => record.type === 'func_call_record')
          .filter((record) => record.name === 'env_get' && record.rawId === rawId);
        assert.equal(rawRecords.length, 2);
        assert.notEqual(rawRecords[1].id, rawId);
        const observed = await recorder.finish();
        assert.equal(
          observed.filter((event) => event.type === 'func_result_evt' && event.name === 'env_get')
            .length,
          count,
          'positive observation of completed results makes the no-error check meaningful',
        );
        assert.equal(observed.filter((event) => event.type === 'stream_error_evt').length, 0);
        const sayings = root.msgs.filter((message) => message.type === 'saying_msg');
        assert.equal(
          sayings.at(-1)?.content,
          finalPayload,
          'the provider actually receives the result and finishes the controlled recovery',
        );
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }
  });
  console.log('duplicate raw call identities preserve execution and result delivery: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
