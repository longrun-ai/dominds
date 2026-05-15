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
    root.disableDiligencePush = true;

    await driveDialogStream(
      root,
      makeUserPrompt(prompt, 'kernel-driver-tellask-background-dispatch'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );

    await waitFor(
      async () => {
        const pending = await DialogPersistence.loadPendingSideDialogs(root.id, root.status);
        return pending.length === 1;
      },
      3_000,
      'background tellask pending record to be persisted',
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
      'single pending tellask dispatch ack must not start an immediate follow-up generation',
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
