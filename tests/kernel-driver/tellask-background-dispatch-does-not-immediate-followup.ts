import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  makeDriveOptions,
  makeUserPrompt,
  waitFor,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const prompt = 'Ask @pangu to investigate in the background.';
    const tellaskContent = 'Please investigate in the background and reply later.';

    await writeMockDb(tmpRoot, [
      {
        message: prompt,
        role: 'user',
        response: 'I will dispatch the background tellask now.',
        funcCalls: [
          {
            id: 'background-dispatch-only',
            name: 'tellask',
            arguments: {
              targetAgentId: 'pangu',
              sessionSlug: 'background-dispatch-only',
              tellaskContent,
            },
          },
        ],
      },
    ]);

    const root = await createMainDialog('tester');
    root.disableDiligencePush = false;
    root.diligencePushRemainingBudget = 1;

    await driveDialogStream(
      root,
      makeUserPrompt(prompt, 'kernel-driver-tellask-background-dispatch'),
      true,
      makeDriveOptions(),
    );

    await waitFor(
      async () => {
        const pending = await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status);
        return pending.length === 1;
      },
      3_000,
      'background tellask pending record to be persisted',
    );
    const activeCallees = await DialogPersistence.loadActiveCallees(root.id, root.status);
    assert.equal(
      activeCallees.batches.length,
      1,
      'background tellask should create one active batch',
    );
    assert.equal(
      activeCallees.batches[0]?.callees.length,
      1,
      'single tellask dispatch batch should contain one callee',
    );
    assert.equal(
      activeCallees.batches[0]?.callees[0]?.callId,
      'background-dispatch-only',
      'active callee batch should preserve the dispatched call id',
    );

    const events = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const genStartCount = events.filter((event) => event.type === 'gen_start_record').length;
    assert.equal(
      genStartCount,
      1,
      'single pending tellask dispatch ack must not start an immediate follow-up or Diligence Push generation',
    );
    assert.equal(
      root.diligencePushRemainingBudget,
      1,
      'pending active callee dispatch must not consume Diligence Push budget',
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === 'func_result_record' &&
          event.name === 'tellask' &&
          event.id === 'background-dispatch-only',
      ),
      'pending tellask dispatch ack should still be persisted as a function result',
    );
    assert.equal(
      events.some(
        (event) => event.type === 'prompting_msg_record' && event.origin === 'diligence_push',
      ),
      false,
      'pending active callee dispatch must not insert a Diligence Push prompt',
    );

    const latest = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.notEqual(
      latest?.displayState?.kind === 'blocked' ? latest.displayState.reason.kind : 'not_blocked',
      'waiting_for_sideDialogs',
      'pending tellask must not project caller dialog into waiting_for_sideDialogs',
    );
  });

  console.log('kernel-driver tellask-background-dispatch-does-not-immediate-followup: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `kernel-driver tellask-background-dispatch-does-not-immediate-followup: FAIL\n${message}`,
  );
  process.exit(1);
});
