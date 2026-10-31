import { toCallSiteGenseqNo, type HumanQuestion } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { driveQueuedDialogsOnce } from '../../main/llm/kernel-driver/loop';
import { DialogPersistence } from '../../main/persistence';
import { recoverPendingReplyDeliveryForDialog } from '../../main/recovery/reply-delivery-recovery';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { recordDialogEvents } from '../helpers/dialog-events';
import {
  assertRecoveryFacts,
  createRecoveryPair,
  installRecoveryProvider,
  recoveryApiType,
  waitRecoveryDrives,
} from '../helpers/reply-recovery';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-human-gated-reply-recovery-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    setWorkLanguage('en');
    await writeStandardMinds(rtws, {
      extraMembers: ['worker'],
      providerApiType: recoveryApiType,
      diligencePushMax: 0,
    });
    const pair = await createRecoveryPair('human-gated', 'registered', 'delivered');
    const { root, side, scenario } = pair;
    globalDialogRegistry.register(root);
    const provider = installRecoveryProvider([scenario]);
    const traces = [recordDialogEvents(root), recordDialogEvents(side)];
    // Exercise the persisted human-wait gate, not the WebSocket answer flow.
    const question: HumanQuestion = {
      id: 'q4h-side-question',
      tellaskContent: 'human-question-data',
      askedAt: new Date().toISOString(),
      callId: 'ask-human-side-call',
      callSiteRef: { course: 1, messageIndex: 0, callSiteGenseq: toCallSiteGenseqNo(2) },
    };
    await DialogPersistence.appendQuestion4HumanState(side.id, question, side.status);
    globalDialogRegistry.queueRootDrive(root.id.rootId, {
      source: 'test_reply_delivery_human_gate',
      reason: 'reply_delivery_recovery',
    });
    await driveQueuedDialogsOnce();
    await waitRecoveryDrives([pair]);
    provider.assertNoErrors();
    await assertRecoveryFacts(scenario, 1, 0);
    assert.equal(
      provider.counts.get(scenario.rootId),
      1,
      'already-delivered caller result can be consumed independently',
    );
    assert.equal(provider.counts.has(scenario.sideId), false);
    const parked = await DialogPersistence.loadDialogLatest(side.id, side.status);
    assert.equal(parked?.userWait?.kind, 'awaiting_user_answer');
    const before = await DialogPersistence.loadWakeQueueTargetDialogIds(root.id, root.status);
    assert.ok(before.some((id) => id.selfId === side.id.selfId));

    const removal = await DialogPersistence.removeQuestion4HumanState(
      side.id,
      question.id,
      side.status,
    );
    assert.equal(removal.found, true);
    assert.equal(removal.removedQuestion?.id, question.id);
    globalDialogRegistry.queueRootDrive(root.id.rootId, {
      source: 'test_reply_delivery_human_gate',
      reason: 'q4h_cleared',
    });
    await driveQueuedDialogsOnce();
    await waitRecoveryDrives([pair]);
    provider.assertNoErrors();
    await assertRecoveryFacts(scenario, 1, 1);
    assert.equal(provider.counts.get(scenario.rootId), 1);
    assert.equal(provider.counts.has(scenario.sideId), false);
    assert.equal(await recoverPendingReplyDeliveryForDialog(side), 0);
    const after = await DialogPersistence.loadWakeQueueTargetDialogIds(root.id, root.status);
    assert.equal(
      after.some((id) => id.selfId === side.id.selfId),
      false,
    );
    const recovered = await DialogPersistence.loadDialogLatest(side.id, side.status);
    assert.equal(recovered?.userWait, undefined);
    const events = (await Promise.all(traces.map((trace) => trace.finish()))).flat();
    assert.deepEqual(
      events.filter((event) => event.type === 'stream_error_evt'),
      [],
    );
    const stored = await DialogPersistence.loadCourseEvents(side.id, 1, side.status);
    const result = stored.find(
      (event) => event.type === 'func_result_record' && event.id === scenario.replyCallId,
    );
    assert.ok(result?.type === 'func_result_record');
    evidence.record({
      id: 'human-gated-local-acknowledgement',
      scenario:
        'A persisted human question parks local acknowledgement recovery. Its removal releases the backend wake; the canonical reply already reached the caller before this gate.',
      businessValue:
        'Keep the human wait intact and repair the local acknowledgement once it clears, without redelivering the reply.',
      context: {
        canonicalDeliveries: 1,
        localResultsBeforeClearing: 0,
        localResultsAfterClearing: 1,
        callerRequests: 1,
        replierRequests: 0,
        providerFailures: 0,
        scope:
          'Persisted gate is seeded and removed through public persistence APIs; real backend/runtime. Does not exercise human-answer WebSocket/UI materialization.',
      },
      reviewQuestions: [
        'Does the acknowledgement accurately describe the delivery, with no implication that an unanswered human question was automatically answered?',
      ],
      actualText: result.content,
    });
    await evidence.write();
  });
  console.log('recovery reply-delivery-recovery-waits-for-q4h: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
