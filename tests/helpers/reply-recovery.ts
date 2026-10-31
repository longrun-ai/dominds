import {
  toAssignmentCourseNumber,
  toAssignmentGenerationSeqNumber,
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
} from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { DialogID, SideDialog, type Dialog, type MainDialog } from '../../main/dialog';
import { ensureDialogLoaded, getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import { registerLlmGenerator } from '../../main/llm/gen/registry';
import { executeTellaskCalls } from '../../main/llm/kernel-driver/tellask-special';
import { DialogPersistence } from '../../main/persistence';
import { createMainDialog, waitForAllDialogsUnlocked } from '../kernel-driver/helpers';
import { messageProvider } from './message-provider';

export const recoveryApiType = 'controlled-reply-recovery';
export type RecoveryScenario = {
  label: string;
  kind: 'back' | 'registered';
  stage: 'pending' | 'delivered' | 'complete';
  rootId: string;
  sideId: string;
  replierId: string;
  requesterId: string;
  workCallId: string;
  targetCallId: string;
  replyCallId: string;
  replyBody: string;
};
export type RecoveryPair = {
  scenario: RecoveryScenario;
  root: MainDialog;
  side: SideDialog;
  replier: Dialog;
  requester: Dialog;
};

/** Public setup commits a command/outbox at a crash boundary; it does not simulate model reasoning. */
export async function createRecoveryPair(
  label: string,
  kind: RecoveryScenario['kind'],
  stage: RecoveryScenario['stage'],
): Promise<RecoveryPair> {
  const root = await createMainDialog('tester');
  root.disableDiligencePush = true;
  await DialogPersistence.mutateDialogLatest(root.id, () => ({
    kind: 'patch',
    patch: { disableDiligencePush: true },
  }));
  const workCallId = `work-${label}`;
  const workBody = `work-input-${label}`;
  await root.persistTellaskCall(
    workCallId,
    'tellask',
    JSON.stringify({ targetAgentId: 'worker', sessionSlug: label, tellaskContent: workBody }),
    1,
  );
  const side = await root.createSideDialog('worker', ['@worker'], workBody, {
    callName: 'tellask',
    originMemberId: 'tester',
    askerDialogId: root.id.selfId,
    callId: workCallId,
    callSiteCourse: toCallSiteCourseNo(1),
    callSiteGenseq: toCallSiteGenseqNo(1),
    sessionSlug: label,
    collectiveTargets: ['worker'],
  });
  side.disableDiligencePush = true;
  await DialogPersistence.mutateDialogLatest(side.id, () => ({
    kind: 'patch',
    patch: {
      disableDiligencePush: true,
      latestAssignmentAnchor: {
        callId: workCallId,
        assignmentCourse: toAssignmentCourseNumber(1),
        assignmentGenseq: toAssignmentGenerationSeqNumber(0),
      },
    },
  }));
  await DialogPersistence.appendActiveCalleeDispatch(root.id, {
    calleeDialogId: side.id.selfId,
    createdAt: formatUnifiedTimestamp(new Date()),
    batchId: `batch-${label}`,
    callName: 'tellask',
    mentionList: ['@worker'],
    tellaskContent: workBody,
    targetAgentId: 'worker',
    callId: workCallId,
    callSiteCourse: toCallSiteCourseNo(1),
    callSiteGenseq: toCallSiteGenseqNo(1),
    callType: 'B',
    sessionSlug: label,
  });
  await root.loadActiveCalleeDispatchesFromPersistence();
  const targetCallId = kind === 'back' ? `back-${label}` : workCallId;
  const replier = kind === 'back' ? root : side;
  const requester = kind === 'back' ? side : root;
  const replyCallId = `reply-${label}`;
  const replyBody = `reply-data-${label}`;
  if (kind === 'back') {
    await side.notifyGeneratingStart(`side-request-${label}`);
    await side.persistTellaskCall(
      targetCallId,
      'tellaskBack',
      JSON.stringify({ tellaskContent: `question-${label}` }),
      1,
    );
    const directive = {
      expectedReplyCallName: 'replyTellaskBack' as const,
      targetDialogId: side.id.selfId,
      targetCallId,
      tellaskContent: `question-${label}`,
    };
    await DialogPersistence.pushTellaskReplyObligation(root.id, directive, root.status);
    await root.persistUserMessage(
      `request-data-${label}`,
      `request-${label}`,
      'markdown',
      'runtime',
      'en',
      undefined,
      directive,
    );
  }
  await replier.persistTellaskCall(
    replyCallId,
    kind === 'back' ? 'replyTellaskBack' : 'replyTellask',
    JSON.stringify({ replyContent: replyBody }),
    1,
  );
  const scenario: RecoveryScenario = {
    label,
    kind,
    stage,
    rootId: root.id.selfId,
    sideId: side.id.selfId,
    replierId: replier.id.selfId,
    requesterId: requester.id.selfId,
    workCallId,
    targetCallId,
    replyCallId,
    replyBody,
  };
  const pair = { scenario, root, side, replier, requester };
  if (stage !== 'pending') {
    const execution = await executeTellaskCalls({
      dlg: replier,
      calls: [
        {
          callId: replyCallId,
          callName: kind === 'back' ? 'replyTellaskBack' : 'replyTellask',
          replyContent: replyBody,
        },
      ],
      callbacks: { scheduleDrive: () => {}, driveDialog: async () => {} },
    });
    assert.deepEqual(execution.successfulReplyCallIds, [replyCallId]);
    if (stage === 'complete') {
      for (const output of execution.toolOutputs) {
        assert.ok(output.type === 'func_result_msg');
        await replier.receiveFuncResult(output);
      }
    }
  }
  await assertRecoveryFacts(scenario, stage === 'pending' ? 0 : 1, stage === 'complete' ? 1 : 0);
  return pair;
}

export async function assertRecoveryFacts(
  s: RecoveryScenario,
  deliveryCount: number,
  toolResultCount: number,
): Promise<void> {
  const replierId = new DialogID(s.replierId, s.rootId),
    requesterId = new DialogID(s.requesterId, s.rootId);
  const requesterEvents = await DialogPersistence.loadCourseEvents(requesterId, 1, 'running');
  const deliveries = requesterEvents.filter(
    (event): event is Extract<typeof event, { type: 'tellask_result_record' }> =>
      event.type === 'tellask_result_record' && event.callId === s.targetCallId,
  );
  assert.equal(deliveries.length, deliveryCount, `${s.label}: canonical requester delivery count`);
  if (deliveryCount) {
    const delivery = deliveries[0];
    assert.ok(delivery);
    assert.equal(delivery.callName, s.kind === 'back' ? 'tellaskBack' : 'tellask');
    assert.ok(
      delivery.content.includes(s.replyBody),
      'provided reply body survives its runtime wrapper',
    );
  }
  const replierEvents = await DialogPersistence.loadCourseEvents(replierId, 1, 'running');
  const results = replierEvents.filter(
    (event) => event.type === 'func_result_record' && event.id === s.replyCallId,
  );
  assert.equal(results.length, toolResultCount, `${s.label}: local tool-result count`);
  assert.equal(
    replierEvents.filter(
      (event) => event.type === 'tellask_reply_resolution_record' && event.callId === s.replyCallId,
    ).length,
    deliveryCount,
  );
  const latest = await DialogPersistence.loadDialogLatest(replierId, 'running');
  assert.ok(latest?.replyDelivery);
  assert.equal(latest.replyDelivery.replyCallId, s.replyCallId);
  assert.equal(latest.replyDelivery.status, deliveryCount ? 'delivered' : 'pending');
  assert.equal(latest.replyDelivery.toolResultStatus, toolResultCount ? 'recorded' : 'pending');
  assert.equal(
    latest.nextStep.triggers.filter(
      (trigger) =>
        trigger.kind === 'reply_delivery_recovery' &&
        trigger.replyDeliveryId === latest.replyDelivery?.replyDeliveryId,
    ).length,
    toolResultCount ? 0 : 1,
  );
}

export async function loadRecoveryPair(s: RecoveryScenario): Promise<RecoveryPair> {
  const root = await getOrRestoreMainDialog(s.rootId, 'running');
  assert.ok(root);
  const side = await ensureDialogLoaded(root, new DialogID(s.sideId, s.rootId), 'running');
  assert.ok(side);
  assert.ok(side instanceof SideDialog);
  return {
    scenario: s,
    root,
    side,
    replier: s.kind === 'back' ? root : side,
    requester: s.kind === 'back' ? side : root,
  };
}

/** Route only on protocol identity; unexpected requests are fatal test failures. */
export function installRecoveryProvider(scenarios: readonly RecoveryScenario[]) {
  const counts = new Map<string, number>();
  const generator = messageProvider(recoveryApiType, ({ request, context, genseq }) => {
    const s = scenarios.find(
      (s) => request.dialogSelfId === s.rootId || request.dialogSelfId === s.sideId,
    );
    assert.ok(s, 'provider request must belong to a known recovery scenario');
    const count = (counts.get(request.dialogSelfId) ?? 0) + 1;
    counts.set(request.dialogSelfId, count);
    assert.equal(count, 1, `${s.label}: each caller consumes the result once`);
    const sideRequester = request.dialogSelfId === s.sideId;
    assert.ok(
      !sideRequester || s.kind === 'back',
      'already-final registered replier must not generate',
    );
    const callId = sideRequester ? s.targetCallId : s.workCallId;
    const results = context.filter(
      (message) => message.type === 'tellask_result_msg' && message.callId === callId,
    );
    assert.equal(results.length, 1, 'actual protocol result is in the provider request');
    const result = results[0];
    assert.ok(result?.type === 'tellask_result_msg');
    const suppliedBody =
      sideRequester || s.kind === 'registered' ? s.replyBody : `work-result-${s.label}`;
    assert.ok(
      result.content.includes(suppliedBody),
      'supplied reply data reaches the actual caller request',
    );
    return {
      messages: sideRequester
        ? [
            {
              type: 'func_call_msg' as const,
              role: 'assistant' as const,
              genseq,
              id: `finish-${s.label}`,
              name: 'replyTellask',
              arguments: JSON.stringify({ replyContent: `work-result-${s.label}` }),
            },
          ]
        : [
            {
              type: 'saying_msg' as const,
              role: 'assistant' as const,
              genseq,
              content: `caller-ack-${s.label}`,
            },
          ],
      usage: { kind: 'unavailable' as const },
    };
  });
  registerLlmGenerator(generator);
  return { counts, assertNoErrors: () => generator.assertNoErrors() };
}

export async function waitRecoveryDrives(pairs: readonly RecoveryPair[]): Promise<void> {
  for (const pair of pairs) await waitForAllDialogsUnlocked(pair.root, 3000);
}

export async function readRecoveryScenarios(file: string): Promise<RecoveryScenario[]> {
  const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok(Array.isArray(value));
  return value.map((row: unknown) => {
    assert.ok(row !== null && typeof row === 'object' && !Array.isArray(row));
    const field = (key: string): string => {
      const value = (row as Record<string, unknown>)[key];
      assert.ok(typeof value === 'string');
      return value;
    };
    const kind = field('kind'),
      stage = field('stage');
    assert.ok(kind === 'back' || kind === 'registered');
    assert.ok(stage === 'pending' || stage === 'delivered' || stage === 'complete');
    return {
      label: field('label'),
      kind,
      stage,
      rootId: field('rootId'),
      sideId: field('sideId'),
      replierId: field('replierId'),
      requesterId: field('requesterId'),
      workCallId: field('workCallId'),
      targetCallId: field('targetCallId'),
      replyCallId: field('replyCallId'),
      replyBody: field('replyBody'),
    };
  });
}
