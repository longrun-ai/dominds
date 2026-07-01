import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';

import {
  createMainDialog,
  makeUserPrompt,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);

    const trigger = 'Record reasoning tokens when model context limit is unavailable.';
    const response = 'Usage captured even without a configured model context window.';

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response,
        usage: {
          promptTokens: 42_000,
          completionTokens: 7,
          reasoningTokens: 516,
          totalTokens: 42_007,
        },
      },
    ]);

    const dlg = await createMainDialog('tester');
    await driveDialogStream(
      dlg,
      makeUserPrompt(trigger, 'kernel-driver-context-health-model-limit-usage'),
      true,
    );

    const snapshot = dlg.getLastContextHealth();
    assert.equal(snapshot?.kind, 'unavailable');
    assert.equal(snapshot.reason, 'model_limit_unavailable');
    assert.equal(snapshot.promptTokens, 42_000);
    assert.equal(snapshot.completionTokens, 7);
    assert.equal(snapshot.reasoningTokens, 516);
    assert.equal(snapshot.totalTokens, 42_007);

    const events = await DialogPersistence.loadCourseEvents(dlg.id, 1, dlg.status);
    const finishRecord = events.find((event) => event.type === 'gen_finish_record');
    assert.ok(finishRecord, 'expected persisted gen_finish_record');
    assert.equal(finishRecord.contextHealth?.kind, 'unavailable');
    assert.equal(finishRecord.contextHealth.reason, 'model_limit_unavailable');
    assert.equal(finishRecord.contextHealth.promptTokens, 42_000);
    assert.equal(finishRecord.contextHealth.completionTokens, 7);
    assert.equal(finishRecord.contextHealth.reasoningTokens, 516);
    assert.equal(finishRecord.contextHealth.totalTokens, 42_007);
  });

  console.log('kernel-driver context-health-model-limit-usage: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver context-health-model-limit-usage: FAIL\n${message}`);
  process.exit(1);
});
