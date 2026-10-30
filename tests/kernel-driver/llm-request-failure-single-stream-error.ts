import assert from 'node:assert/strict';

import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { recordDialogEvents } from '../helpers/dialog-events';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  makeUserPrompt,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector('dominds-provider-stop-');

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);

    await writeMockDb(tmpRoot, [
      {
        message: 'Trigger a mock provider-emitted stream failure.',
        role: 'user',
        response: '',
        streamError: 'OPENAI-COMPATIBLE invalid tool call index: null',
        emitStreamErrorBeforeThrow: true,
      },
      {
        message: 'Trigger a generic emitted upstream failure.',
        role: 'user',
        response: '',
        streamError: 'upstream stream exploded',
        emitStreamErrorBeforeThrow: true,
      },
    ]);

    // Under the new long-run retry model, generic transport/upstream failures no longer stop after
    // a fixed retry-count ceiling; they keep the dialog alive via conservative retry. This
    // regression test should therefore stay focused on the single-stream-error contract: when the
    // provider path has already emitted stream_error_evt before throwing, the driver must not emit
    // a wrapped duplicate error for the same failure.
    for (const scenario of [
      {
        trigger: 'Trigger a mock provider-emitted stream failure.',
        msgId: 'kernel-driver-llm-request-failure-single-stream-error-emitted',
        expectedDetail: 'OPENAI-COMPATIBLE invalid tool call index: null',
      },
      {
        trigger: 'Trigger a generic emitted upstream failure.',
        msgId: 'kernel-driver-llm-request-failure-single-stream-error-generic-emitted',
        expectedDetail: 'upstream stream exploded',
      },
    ] as const) {
      const dlg = await createMainDialog('tester');
      dlg.disableDiligencePush = true;
      const recording = recordDialogEvents(dlg);

      await driveDialogStream(dlg, makeUserPrompt(scenario.trigger, scenario.msgId), true);

      const latest = await DialogPersistence.loadDialogLatest(dlg.id, dlg.status);
      assert.ok(latest?.displayState, 'expected latest.yaml displayState to be persisted');
      assert.equal(latest?.displayState?.kind, 'stopped');
      if (!latest?.displayState || latest.displayState.kind !== 'stopped') {
        throw new Error('Expected final displayState.kind to be stopped');
      }
      assert.equal(latest.displayState.reason.kind, 'system_stop');
      if (latest.displayState.reason.kind !== 'system_stop') {
        throw new Error('Expected system_stop detail for failed LLM request');
      }
      assert.equal(
        latest.displayState.reason.detail,
        scenario.expectedDetail,
        'displayState should preserve the original provider/runtime detail',
      );

      assert.equal(latest.displayState.continueEnabled, true);
      assert.equal(latest.executionMarker?.kind, 'interrupted');
      assert.equal(latest.executionMarker?.reason.kind, 'system_stop');
      if (latest.executionMarker?.reason.kind === 'system_stop') {
        assert.equal(latest.executionMarker.reason.detail, scenario.expectedDetail);
        assert.deepEqual(
          latest.executionMarker.reason,
          latest.displayState.reason,
          'persisted interruption must carry the same reason as the visible stop',
        );
      }

      const events = await recording.finish();
      const streamErrors = events.filter(
        (event): event is Extract<TypedDialogEvent, { type: 'stream_error_evt' }> =>
          event.type === 'stream_error_evt',
      );
      assert.equal(streamErrors.length, 1, 'expected exactly one stream_error_evt for one failure');
      assert.equal(streamErrors[0]?.error, scenario.expectedDetail);
      evidence.record({
        id: scenario.msgId,
        scenario: 'The provider emits a stream error and then throws for the same request.',
        businessValue:
          'Show one accurate stoppage and preserve the upstream failure for human recovery.',
        context: {
          rawDetail: scenario.expectedDetail,
          streamErrors: streamErrors.length,
          continueEnabled: latest.displayState.continueEnabled,
        },
        reviewQuestions: [
          'Do both localized stop reasons accurately describe this failure without exposing an invented recovery or claiming completion?',
        ],
        actualText: JSON.stringify(latest.displayState, null, 2),
      });
    }
  });

  await evidence.write();
  console.log('kernel-driver llm-request-failure-single-stream-error: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver llm-request-failure-single-stream-error: FAIL\n${message}`);
  process.exit(1);
});
