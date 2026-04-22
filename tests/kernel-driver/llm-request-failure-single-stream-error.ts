import assert from 'node:assert/strict';

import { EndOfStream } from '@longrun-ai/kernel/evt';
import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import { dialogEventRegistry } from '../../main/evt-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  makeUserPrompt,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function readNextEventWithTimeout(
  ch: ReturnType<typeof dialogEventRegistry.createSubChan>,
  timeoutMs: number,
): Promise<TypedDialogEvent | null> {
  const timer = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });
  const ev = await Promise.race([ch.read(), timer]);
  if (ev === null || ev === EndOfStream) {
    return null;
  }
  return ev;
}

async function collectEvents(
  ch: ReturnType<typeof dialogEventRegistry.createSubChan>,
  timeoutMs: number,
): Promise<TypedDialogEvent[]> {
  const events: TypedDialogEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ev = await readNextEventWithTimeout(ch, 30);
    if (!ev) continue;
    events.push(ev);
  }
  return events;
}

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
        forbiddenDetail: 'LLM failed: OPENAI-COMPATIBLE invalid tool call index: null',
        expectedI18nStopReason: {
          zh: '模型服务返回了无效的工具调用信息，本次生成已停止。',
          en: 'The LLM service returned invalid tool-call data. This generation was stopped.',
        },
      },
      {
        trigger: 'Trigger a generic emitted upstream failure.',
        msgId: 'kernel-driver-llm-request-failure-single-stream-error-generic-emitted',
        expectedDetail: 'upstream stream exploded',
        forbiddenDetail: 'LLM failed: upstream stream exploded',
        expectedI18nStopReason: {
          zh: '本次生成因上游报错而停止。上游原文：upstream stream exploded',
          en: 'This generation was stopped because the upstream service returned an error. Upstream message: upstream stream exploded',
        },
      },
    ] as const) {
      const dlg = await createMainDialog('tester');
      dlg.disableDiligencePush = true;
      const ch = dialogEventRegistry.createSubChan(dlg.id);

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
      assert.deepEqual(latest.displayState.reason.i18nStopReason, scenario.expectedI18nStopReason);
      assert.equal(latest.displayState.continueEnabled, true);
      assert.equal(latest.executionMarker?.kind, 'interrupted');
      assert.equal(latest.executionMarker?.reason.kind, 'system_stop');
      if (latest.executionMarker?.reason.kind === 'system_stop') {
        assert.equal(latest.executionMarker.reason.detail, scenario.expectedDetail);
        assert.deepEqual(
          latest.executionMarker.reason.i18nStopReason,
          scenario.expectedI18nStopReason,
        );
      }

      const events = await collectEvents(ch, 500);
      const streamErrors = events.filter(
        (event): event is Extract<TypedDialogEvent, { type: 'stream_error_evt' }> =>
          event.type === 'stream_error_evt',
      );
      assert.equal(streamErrors.length, 1, 'expected exactly one stream_error_evt for one failure');
      assert.equal(streamErrors[0]?.error, scenario.expectedDetail);
      assert.equal(
        streamErrors.some((event) => event.error === scenario.forbiddenDetail),
        false,
        'driver should not re-emit a wrapped second stream_error_evt for the same failure',
      );
    }
  });

  console.log('kernel-driver llm-request-failure-single-stream-error: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver llm-request-failure-single-stream-error: FAIL\n${message}`);
  process.exit(1);
});
