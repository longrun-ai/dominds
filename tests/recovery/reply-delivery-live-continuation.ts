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

const evidence = semanticEvidenceCollector('dominds-live-reply-recovery-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    setWorkLanguage('en');
    await writeStandardMinds(rtws, {
      extraMembers: ['worker'],
      providerApiType: recoveryApiType,
      diligencePushMax: 0,
    });
    const pair = await createRecoveryPair('live', 'registered', 'delivered');
    const { root, side, scenario } = pair;
    const serialized = await createRecoveryPair('serialized', 'registered', 'delivered');
    globalDialogRegistry.register(serialized.root);
    const traces = [root, side, serialized.root, serialized.side].map(recordDialogEvents);
    // Recovery and a live drive share the public dialog execution lock. A later owner must
    // observe the completed acknowledgement, not race an out-of-band recovery write.
    const releaseForeground = await serialized.side.acquire();
    const recovery = recoverPendingReplyDeliveryForDialog(serialized.side);
    const nextOwner = serialized.side.acquire();
    releaseForeground();
    const releaseNextOwner = await nextOwner;
    try {
      await assertRecoveryFacts(serialized.scenario, 1, 1);
    } finally {
      releaseNextOwner();
    }
    assert.equal(await recovery, 1);
    assert.equal(await recoverPendingReplyDeliveryForDialog(serialized.side), 0);
    globalDialogRegistry.register(root);
    const provider = installRecoveryProvider([scenario, serialized.scenario]);
    const before = await DialogPersistence.loadWakeQueueTargetDialogIds(root.id, root.status);
    assert.ok(before.some((id) => id.selfId === side.id.selfId));

    globalDialogRegistry.queueRootDrive(root.id.rootId, {
      source: 'test_reply_delivery_live_continuation',
      reason: 'reply_delivery_recovery',
    });
    await driveQueuedDialogsOnce();
    await waitRecoveryDrives([pair, serialized]);
    provider.assertNoErrors();
    await assertRecoveryFacts(scenario, 1, 1);
    assert.equal(provider.counts.get(scenario.rootId), 1);
    assert.equal(provider.counts.has(scenario.sideId), false);
    const after = await DialogPersistence.loadWakeQueueTargetDialogIds(root.id, root.status);
    assert.equal(
      after.some((id) => id.selfId === side.id.selfId),
      false,
    );

    assert.equal(await recoverPendingReplyDeliveryForDialog(side), 0);
    globalDialogRegistry.queueRootDrive(root.id.rootId, {
      source: 'test_reply_delivery_live_continuation',
      reason: 'duplicate_wake',
    });
    await driveQueuedDialogsOnce();
    await waitRecoveryDrives([pair, serialized]);
    provider.assertNoErrors();
    await assertRecoveryFacts(scenario, 1, 1);
    assert.equal(provider.counts.get(scenario.rootId), 1);
    const events = (await Promise.all(traces.map((trace) => trace.finish()))).flat();
    assert.deepEqual(
      events.filter((event) => event.type === 'stream_error_evt'),
      [],
    );
    await assertRecoveryFacts(serialized.scenario, 1, 1);
    assert.equal(provider.counts.get(serialized.scenario.rootId), 1);
    const stored = await DialogPersistence.loadCourseEvents(side.id, 1, side.status);
    const result = stored.find(
      (event) => event.type === 'func_result_record' && event.id === scenario.replyCallId,
    );
    assert.ok(result?.type === 'func_result_record');
    evidence.record({
      id: 'live-delivered-reply',
      scenario:
        'The real reply has reached its registered caller; a live backend wake repairs only the missing local tool acknowledgement and the caller consumes its canonical result.',
      businessValue:
        'Finish collaboration without replaying an already delivered reply or hiding a failed caller continuation.',
      context: {
        canonicalDeliveries: 1,
        localResults: 1,
        callerRequests: 1,
        replierRequests: 0,
        providerFailures: 0,
        scope:
          'Real runtime, persistence and backend wake; controlled provider; no process restart.',
      },
      reviewQuestions: [
        'Does the actual acknowledgement agree with completed delivery and avoid instructing a duplicate reply?',
      ],
      actualText: result.content,
    });
    await evidence.write();
  });
  console.log('recovery reply-delivery-live-continuation: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
