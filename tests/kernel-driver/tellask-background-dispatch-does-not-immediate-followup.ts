import assert from 'node:assert/strict';

import { type SetDiligencePushRequest } from '@longrun-ai/kernel/types/wire';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { handleWebSocketMessage } from '../../main/server/websocket-handler';
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
    const registeredUpdatePrompt = 'Update the existing @pangu background investigation.';
    const tellaskContent = 'Please investigate in the background and reply later.';
    const registeredUpdateContent = 'Please continue the same background investigation.';

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
      {
        message: registeredUpdatePrompt,
        role: 'user',
        response: 'I will update the existing background tellask now.',
        funcCalls: [
          {
            id: 'registered-background-update-only',
            name: 'tellask',
            arguments: {
              targetAgentId: 'pangu',
              sessionSlug: 'background-dispatch-only',
              tellaskContent: registeredUpdateContent,
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

    const firstCalleeId = activeCallees.batches[0]?.callees[0]?.calleeDialogId;
    assert.ok(firstCalleeId, 'expected the initial tellask to register a callee dialog id');
    await DialogPersistence.removeActiveCalleeDispatch(
      root.id,
      firstCalleeId,
      undefined,
      root.status,
    );
    root.diligencePushRemainingBudget = 1;
    await DialogPersistence.mutateDialogLatest(root.id, () => ({
      kind: 'patch',
      patch: {
        diligencePushRemainingBudget: 1,
      },
    }));

    await driveDialogStream(
      root,
      makeUserPrompt(
        registeredUpdatePrompt,
        'kernel-driver-tellask-background-dispatch-registered-update',
      ),
      true,
      makeDriveOptions(),
    );

    const activeAfterRegisteredUpdate = await DialogPersistence.loadActiveCallees(
      root.id,
      root.status,
    );
    assert.equal(
      activeAfterRegisteredUpdate.batches.length,
      1,
      'registered tellask update should create one active batch',
    );
    assert.equal(
      activeAfterRegisteredUpdate.batches[0]?.callees[0]?.callId,
      'registered-background-update-only',
      'registered tellask update should preserve the new call id',
    );

    const eventsAfterRegisteredUpdate = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    assert.equal(
      eventsAfterRegisteredUpdate.filter((event) => event.type === 'gen_start_record').length,
      2,
      'registered pending tellask update must not start an immediate follow-up or Diligence Push generation',
    );
    assert.equal(
      root.diligencePushRemainingBudget,
      1,
      'registered pending active callee update must not consume Diligence Push budget',
    );
    assert.equal(
      eventsAfterRegisteredUpdate.filter(
        (event) => event.type === 'prompting_msg_record' && event.origin === 'diligence_push',
      ).length,
      0,
      'registered pending active callee update must not insert a Diligence Push prompt',
    );

    await DialogPersistence.mutateDialogLatest(root.id, () => ({
      kind: 'patch',
      patch: {
        disableDiligencePush: true,
        diligencePushRemainingBudget: 1,
      },
    }));
    root.disableDiligencePush = true;
    root.diligencePushRemainingBudget = 1;

    const wsMessages: string[] = [];
    const ws = {
      send(data: string) {
        wsMessages.push(data);
      },
    } as unknown as import('ws').WebSocket;
    const enableDiligencePacket: SetDiligencePushRequest = {
      type: 'set_diligence_push',
      dialog: { selfId: root.id.selfId, rootId: root.id.rootId, status: root.status },
      disableDiligencePush: false,
    };
    await handleWebSocketMessage(ws, enableDiligencePacket);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(
      wsMessages.some((raw) => raw.includes('"type":"diligence_push_updated"')),
      true,
      'UI enable toggle should still acknowledge the setting update',
    );
    assert.equal(
      root.diligencePushRemainingBudget,
      1,
      'UI enable toggle must not consume Diligence Push budget while active callee dispatch remains pending',
    );
    const latestAfterToggle = await DialogPersistence.loadDialogLatest(root.id, root.status);
    assert.equal(
      latestAfterToggle?.disableDiligencePush,
      false,
      'UI enable toggle should persist Diligence Push as enabled',
    );
    assert.equal(
      latestAfterToggle?.diligencePushRemainingBudget,
      1,
      'UI enable toggle must not persist budget consumption while active callee dispatch remains pending',
    );
    const eventsAfterToggle = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    assert.equal(
      eventsAfterToggle.filter(
        (event) => event.type === 'prompting_msg_record' && event.origin === 'diligence_push',
      ).length,
      0,
      'UI enable toggle must not insert a Diligence Push prompt while active callee dispatch remains pending',
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
