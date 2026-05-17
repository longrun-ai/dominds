import assert from 'node:assert/strict';

import { EndOfStream } from '@longrun-ai/kernel/evt';
import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import type { DeclareSideDialogDeadRequest } from '@longrun-ai/kernel/types/wire';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { setDialogDisplayState, setDialogExecutionMarker } from '../../main/dialog-display-state';
import { dialogEventRegistry } from '../../main/evt-registry';
import { supplyResponseToAskerDialog } from '../../main/llm/kernel-driver';
import { processTellaskFunctionRound } from '../../main/llm/kernel-driver/tellask-special';
import { DialogPersistence } from '../../main/persistence';
import { handleWebSocketMessage } from '../../main/server/websocket-handler';
import { createMainDialog, withTempRtws, writeStandardMinds } from './helpers';

async function readNextEventWithTimeout(
  ch: ReturnType<typeof dialogEventRegistry.createSubChan>,
  timeoutMs: number,
): Promise<TypedDialogEvent | null> {
  const ev = await Promise.race([
    ch.read(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (ev === null || ev === EndOfStream) {
    return null;
  }
  return ev;
}

async function waitForBackgroundSummary(
  ch: ReturnType<typeof dialogEventRegistry.createSubChan>,
  predicate: (
    event: Extract<TypedDialogEvent, { type: 'dlg_background_callee_summary_evt' }>,
  ) => boolean,
  label: string,
): Promise<Extract<TypedDialogEvent, { type: 'dlg_background_callee_summary_evt' }>> {
  const deadline = Date.now() + 2_000;
  const seenTypes: string[] = [];
  while (Date.now() < deadline) {
    const ev = await readNextEventWithTimeout(ch, 50);
    if (!ev) continue;
    seenTypes.push(ev.type);
    if (ev.type === 'dlg_background_callee_summary_evt' && predicate(ev)) {
      return ev;
    }
  }
  throw new Error(`${label}; seen event types: ${seenTypes.join(', ')}`);
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createMainDialog('tester');
    const ch = dialogEventRegistry.createSubChan(root.id);

    await root.notifyGeneratingStart();
    await processTellaskFunctionRound({
      dlg: root,
      funcCalls: [
        {
          type: 'func_call_msg',
          role: 'assistant',
          genseq: root.activeGenSeq,
          id: 'root-starts-background-callee',
          name: 'tellaskSessionless',
          arguments: JSON.stringify({
            targetAgentId: 'pangu',
            tellaskContent: 'Please continue in the background.',
          }),
        },
      ],
      allowedSpecials: new Set(['tellaskSessionless']),
      callbacks: {
        scheduleDrive: () => {},
        driveDialog: async () => {},
      },
    });

    const activeCallees = await DialogPersistence.loadActiveCallees(root.id, root.status);
    assert.equal(
      activeCallees.batches.flatMap((batch) =>
        batch.callees.filter((callee) => callee.status === 'pending'),
      ).length,
      1,
      'root should have one pending background callee after tellaskSessionless',
    );

    const summary = await waitForBackgroundSummary(
      ch,
      (event) => event.backgroundCalleeDialogCount === 1,
      'root tellask should broadcast background callee badge summary',
    );
    assert.equal(summary.dialog.selfId, root.id.selfId);
    assert.equal(summary.backgroundCalleeDialogCount, 1);
    assert.equal(summary.backgroundFreshBootsReasoningCalleeCount, 0);

    const sideDialog = root.getAllDialogs().find((dialog) => dialog.id.selfId !== root.id.selfId);
    assert.ok(sideDialog, 'expected background side dialog to exist');
    await supplyResponseToAskerDialog(
      root,
      sideDialog.id,
      'Side dialog was declared dead.',
      'C',
      'root-starts-background-callee',
      'failed',
    );

    await waitForBackgroundSummary(
      ch,
      (event) => event.backgroundCalleeDialogCount === 0,
      'resolving or declaring a callee dead should broadcast cleared background callee badge summary',
    );

    const deadRoot = await createMainDialog('tester');
    const deadCh = dialogEventRegistry.createSubChan(deadRoot.id);
    const deadCallId = 'already-dead-background-callee';
    const alreadyDeadSideDialog = await deadRoot.createSideDialog(
      'pangu',
      ['@pangu'],
      'This callee will be marked dead before the UI action is retried.',
      {
        callName: 'tellaskSessionless',
        originMemberId: 'tester',
        askerDialogId: deadRoot.id.selfId,
        callId: deadCallId,
        callSiteCourse: 1,
        callSiteGenseq: 1,
        collectiveTargets: ['pangu'],
      },
    );
    await DialogPersistence.appendActiveCalleeDispatch(deadRoot.id, {
      calleeDialogId: alreadyDeadSideDialog.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      batchId: 'already-dead-background-callee-batch',
      callName: 'tellaskSessionless',
      mentionList: ['@pangu'],
      tellaskContent: 'This callee will be marked dead before the UI action is retried.',
      targetAgentId: 'pangu',
      callId: deadCallId,
      callSiteCourse: 1,
      callSiteGenseq: 1,
      callType: 'C',
    });
    await setDialogExecutionMarker(alreadyDeadSideDialog.id, {
      kind: 'dead',
      reason: { kind: 'declared_by_user' },
    });
    await setDialogDisplayState(alreadyDeadSideDialog.id, {
      kind: 'dead',
      reason: { kind: 'declared_by_user' },
    });

    const wsMessages: string[] = [];
    const ws = {
      send(data: string) {
        wsMessages.push(data);
      },
    } as unknown as import('ws').WebSocket;
    const declareDeadPacket: DeclareSideDialogDeadRequest = {
      type: 'declare_sideDialog_dead',
      dialog: {
        rootId: alreadyDeadSideDialog.id.rootId,
        selfId: alreadyDeadSideDialog.id.selfId,
        status: 'running',
      },
    };
    await handleWebSocketMessage(ws, declareDeadPacket);

    const activeAfterRetry = await DialogPersistence.loadActiveCalleeDispatches(
      deadRoot.id,
      deadRoot.status,
    );
    assert.equal(
      activeAfterRetry.length,
      0,
      'retrying declare-dead for an already-dead sideDialog should still clear caller active callee state',
    );
    await waitForBackgroundSummary(
      deadCh,
      (event) => event.backgroundCalleeDialogCount === 0,
      'retrying declare-dead for an already-dead sideDialog should broadcast cleared badge summary',
    );
    assert.equal(
      wsMessages.some((raw) => raw.includes('"type":"error"')),
      false,
      'retrying declare-dead for an already-dead sideDialog should not report a WebSocket error',
    );
  });

  console.log('kernel-driver root-tellask-background-callee-badge-event: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver root-tellask-background-callee-badge-event: FAIL\n${message}`);
  process.exit(1);
});
