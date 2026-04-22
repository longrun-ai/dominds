import assert from 'node:assert/strict';

import type { FuncCallMsg } from '../../main/llm/client';
import type { TellaskCallFunctionName } from '../../main/llm/kernel-driver/tellask-special';
import { processTellaskFunctionRound } from '../../main/llm/kernel-driver/tellask-special';
import { DialogPersistence } from '../../main/persistence';

import { createMainDialog, withTempRtws, writeStandardMinds } from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true, extraMembers: ['nuwa'] });

    const root = await createMainDialog('tester');
    await DialogPersistence.mutateDialogLatest(root.id, () => ({
      kind: 'patch',
      patch: { displayState: { kind: 'proceeding' } },
    }));
    await root.notifyGeneratingStart('kernel-driver-multi-pending-registers-before-drive');
    const genseq = root.activeGenSeq;
    const calls: FuncCallMsg[] = [
      {
        type: 'func_call_msg',
        role: 'assistant',
        genseq,
        id: 'call-pangu-same-round',
        name: 'tellaskSessionless',
        arguments: JSON.stringify({
          targetAgentId: 'pangu',
          tellaskContent: 'Pangu: wait for the same-round sibling before driving.',
        }),
      },
      {
        type: 'func_call_msg',
        role: 'assistant',
        genseq,
        id: 'call-nuwa-same-round',
        name: 'tellaskSessionless',
        arguments: JSON.stringify({
          targetAgentId: 'nuwa',
          tellaskContent: 'Nuwa: wait for the same-round sibling before driving.',
        }),
      },
    ];

    const scheduleSnapshots: Array<{
      scheduledSelfId: string;
      dialogCountAtSchedule: number;
    }> = [];
    const result = await processTellaskFunctionRound({
      dlg: root,
      funcCalls: calls,
      allowedSpecials: new Set<TellaskCallFunctionName>(['tellaskSessionless']),
      callbacks: {
        scheduleDrive: (dialog) => {
          scheduleSnapshots.push({
            scheduledSelfId: dialog.id.selfId,
            dialogCountAtSchedule: root.getAllDialogs().length,
          });
        },
        driveDialog: async () => {
          throw new Error('test invariant violation: tellaskSessionless must not call driveDialog');
        },
      },
    });

    assert.deepEqual(result.handledCallIds, ['call-pangu-same-round', 'call-nuwa-same-round']);
    assert.equal(scheduleSnapshots.length, 2, 'expected both sideDialogs to be scheduled');
    assert.deepEqual(
      scheduleSnapshots.map((snapshot) => snapshot.dialogCountAtSchedule),
      [3, 3],
      'sideDialog drive scheduling must start only after all same-round sideDialogs are created',
    );

    const pending = await DialogPersistence.loadPendingSideDialogs(root.id, root.status);
    assert.equal(pending.length, 2, 'expected both same-round pending records to be registered');
    assert.deepEqual(pending.map((record) => record.callId).sort(), [
      'call-nuwa-same-round',
      'call-pangu-same-round',
    ]);
    assert.ok(
      pending.every(
        (record) =>
          record.callSiteCourse === root.currentCourse && record.callSiteGenseq === genseq,
      ),
      'same assistant round pending records must share the same wait-group coordinates',
    );

    await root.notifyGeneratingFinish();
  });

  console.log('kernel-driver sideDialog-multi-pending-registers-before-drive: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver sideDialog-multi-pending-registers-before-drive: FAIL\n${message}`);
  process.exit(1);
});
