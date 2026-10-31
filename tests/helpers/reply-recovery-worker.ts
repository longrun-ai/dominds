import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { DialogID } from '../../main/dialog';
import { reconcileDisplayStatesAfterRestart } from '../../main/dialog-display-state';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { runBackendDriver } from '../../main/llm/kernel-driver/loop';
import { DialogPersistence } from '../../main/persistence';
import { recoverOpenGenerationAfterRestart } from '../../main/recovery/open-generation-recovery';
import {
  recoverPendingReplyDeliveryAfterRestart,
  recoverPendingReplyDeliveryForDialog,
} from '../../main/recovery/reply-delivery-recovery';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { waitFor, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';
import { recordDialogEvents } from './dialog-events';
import {
  assertRecoveryFacts,
  createRecoveryPair,
  installRecoveryProvider,
  loadRecoveryPair,
  readRecoveryScenarios,
  recoveryApiType,
  type RecoveryScenario,
} from './reply-recovery';
import { semanticEvidenceCollector } from './semantic-evidence';

const manifest = 'reply-recovery-scenarios.json';
const phase = process.argv[2];
const evidence = semanticEvidenceCollector('dominds-cold-reply-recovery-');
async function main(): Promise<void> {
  await withTempRtws(async (root) => {
    setWorkLanguage('en');
    assert.equal(globalDialogRegistry.size, 0, 'this probe starts with no live dialog instances');
    if (phase === 'seed') {
      await writeStandardMinds(root, {
        extraMembers: ['worker'],
        providerApiType: recoveryApiType,
        diligencePushMax: 0,
      });
      const scenarios: RecoveryScenario[] = [];
      for (const [label, kind, stage] of [
        ['pending', 'back', 'pending'],
        ['already-delivered', 'registered', 'delivered'],
        ['resolution-only', 'back', 'delivered'],
        ['concurrent', 'back', 'pending'],
        ['live-mirror', 'back', 'complete'],
      ] as const) {
        const pair = await createRecoveryPair(label, kind, stage);
        if (stage === 'complete') {
          const messages = pair.requester.msgs.filter(
            (message) =>
              message.type === 'tellask_result_msg' &&
              message.callId === pair.scenario.targetCallId,
          );
          assert.equal(
            messages.length,
            1,
            'live delivery mirrors the canonical result onto the real requester',
          );
          assert.equal(
            pair.root.msgs.some(
              (message) =>
                message.type === 'tellask_result_msg' &&
                message.callId === pair.scenario.targetCallId,
            ),
            false,
            'ask-back result is not delivered to the replying root itself',
          );
        }
        scenarios.push(pair.scenario);
      }
      await fs.writeFile(manifest, JSON.stringify(scenarios, null, 2));
      console.log(
        JSON.stringify({
          probe: 'reply-recovery-phase',
          phase,
          pid: process.pid,
          scenarios: scenarios.length,
        }),
      );
      return; // Natural process exit waits for real buffered persistence writes.
    }
    const scenarios = await readRecoveryScenarios(manifest);
    assert.equal(scenarios.length, 5);
    if (phase === 'verify') {
      for (const s of scenarios) {
        await assertRecoveryFacts(s, 1, 1);
        const events = await DialogPersistence.loadCourseEvents(
          new DialogID(s.rootId),
          1,
          'running',
        );
        assert.equal(
          events.filter(
            (event) =>
              event.type === 'agent_words_record' && event.content === `caller-ack-${s.label}`,
          ).length,
          1,
        );
        const workResults = events.filter(
          (event) => event.type === 'tellask_result_record' && event.callId === s.workCallId,
        );
        assert.equal(
          workResults.length,
          1,
          'original registered work result is durable exactly once',
        );
        const workResult = workResults[0];
        assert.ok(workResult?.type === 'tellask_result_record');
        assert.ok(
          workResult.content.includes(
            s.kind === 'registered' ? s.replyBody : `work-result-${s.label}`,
          ),
          'supplied work result survives the independent disk read',
        );
        assert.deepEqual(
          await DialogPersistence.loadActiveCalleeDispatches(new DialogID(s.rootId), 'running'),
          [],
        );
        if (s.kind === 'back') {
          const sideId = new DialogID(s.sideId, s.rootId);
          const sideEvents = await DialogPersistence.loadCourseEvents(sideId, 1, 'running');
          assert.equal(
            sideEvents.filter(
              (event) => event.type === 'func_result_record' && event.id === `finish-${s.label}`,
            ).length,
            1,
            'continued side work has one local completion, without hidden failure/success duplicates',
          );
          assert.equal(
            sideEvents.filter(
              (event) =>
                event.type === 'tellask_reply_resolution_record' &&
                event.callId === `finish-${s.label}`,
            ).length,
            1,
          );
          const latest = await DialogPersistence.loadDialogLatest(sideId, 'running');
          assert.equal(latest?.sideDialogFinalResponse?.callId, s.workCallId);
          assert.equal(latest?.replyDelivery?.toolResultStatus, 'recorded');
        }
      }
      console.log(
        JSON.stringify({
          probe: 'reply-recovery-phase',
          phase,
          pid: process.pid,
          scenarios: scenarios.length,
        }),
      );
      return;
    }
    assert.equal(phase, 'recover');
    const pairs = await Promise.all(scenarios.map(loadRecoveryPair));
    const traces = pairs.flatMap((pair) => [
      recordDialogEvents(pair.root),
      recordDialogEvents(pair.side),
    ]);
    const provider = installRecoveryProvider(scenarios);
    // Match the actual server boot order, with the transport/provider boundary controlled.
    await reconcileDisplayStatesAfterRestart();
    const concurrent = pairs.find((pair) => pair.scenario.label === 'concurrent');
    assert.ok(concurrent);
    assert.deepEqual(
      await Promise.all([
        recoverPendingReplyDeliveryForDialog(concurrent.replier),
        recoverPendingReplyDeliveryForDialog(concurrent.replier),
      ]),
      [1, 1],
    );
    await recoverPendingReplyDeliveryAfterRestart();
    await recoverOpenGenerationAfterRestart();
    const controller = new AbortController();
    const backend = runBackendDriver({ abortSignal: controller.signal });
    const manualResumeLabels = new Set(['already-delivered', 'resolution-only']);
    try {
      await waitFor(
        async () => {
          provider.assertNoErrors();
          return pairs.every(
            (pair) =>
              (provider.counts.get(pair.scenario.rootId) ?? 0) ===
                (manualResumeLabels.has(pair.scenario.label) ? 0 : 1) &&
              (pair.scenario.kind !== 'back' || provider.counts.get(pair.scenario.sideId) === 1) &&
              !pair.root.getLoadedDialogTreeSnapshot().some((dialog) => dialog.isLocked()),
          );
        },
        5000,
        'open generations to resume while stale non-generating roots remain stopped',
      );
      for (const pair of pairs.filter((pair) => manualResumeLabels.has(pair.scenario.label))) {
        const latest = await DialogPersistence.loadDialogLatest(pair.root.id, 'running');
        assert.deepEqual(latest?.displayState, {
          kind: 'stopped',
          reason: { kind: 'server_restart' },
          continueEnabled: true,
        });
        assert.ok(latest.nextStep.triggers.some((trigger) => trigger.kind === 'result_arrival'));
        await driveDialogStream(pair.root, undefined, true, {
          allowResumeFromInterrupted: true,
          source: 'ws_resume_dialog',
          reason: 'resume_dialog',
          suppressDiligencePush: true,
        });
      }
      for (const pair of pairs) assert.equal(provider.counts.get(pair.scenario.rootId), 1);
    } finally {
      controller.abort();
      await backend;
    }
    provider.assertNoErrors();
    const events = (await Promise.all(traces.map((trace) => trace.finish()))).flat();
    assert.deepEqual(
      events.filter((event) => event.type === 'stream_error_evt'),
      [],
    );
    for (const pair of pairs) {
      await assertRecoveryFacts(pair.scenario, 1, 1);
      assert.equal(
        await recoverPendingReplyDeliveryForDialog(pair.replier),
        0,
        'second recovery is a no-op',
      );
      const s = pair.scenario;
      const replierEvents = await DialogPersistence.loadCourseEvents(pair.replier.id, 1, 'running');
      const result = replierEvents.find(
        (event) => event.type === 'func_result_record' && event.id === s.replyCallId,
      );
      assert.ok(result?.type === 'func_result_record');
      evidence.record({
        id: s.label,
        scenario: `A new process restores a ${s.kind} reply at the ${s.stage} stage and completes canonical delivery, local acknowledgement and the real caller continuation.`,
        businessValue:
          'Resume durable collaboration after process loss without a duplicate reply, fabricated success or hidden provider failure.',
        context: {
          language: 'en',
          independentProcess: true,
          callerRequiredExplicitResume: manualResumeLabels.has(s.label),
          canonicalDeliveryCount: 1,
          localResultCount: 1,
          secondRecoveryCount: 0,
          providerFailures: 0,
          scope:
            'Public startup recovery order and real local backend/persistence; controlled external provider, no HTTP server/browser or live model.',
        },
        reviewQuestions: [
          'Does the actual recovery acknowledgement agree with the observed delivery and avoid telling the agent to resend an already delivered reply?',
        ],
        actualText: result.content,
      });
    }
    await evidence.write();
    console.log(
      JSON.stringify({
        probe: 'reply-recovery-phase',
        phase,
        pid: process.pid,
        scenarios: scenarios.length,
        requests: [...provider.counts.values()].reduce((a, b) => a + b, 0),
      }),
    );
  });
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
