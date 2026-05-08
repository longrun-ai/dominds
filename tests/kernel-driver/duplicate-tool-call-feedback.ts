import assert from 'node:assert/strict';

import { EndOfStream } from '@longrun-ai/kernel/evt';
import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import { dialogEventRegistry } from '../../main/evt-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
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
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { memberTools: ['env_get'] });

    const duplicatePrompt = 'Repeat an old function call id.';
    const duplicateCallId = 'duplicate-function-call-id';
    const duplicateCallName = 'env_get';
    const recovered = 'Recovered after duplicate raw call-id mapping.';
    const sameRoundPrompt = 'Reuse one function call id twice in the same response.';
    const sameRoundCallId = 'same-round-duplicate-function-call-id';
    const sameRoundRecovered = 'Recovered after same-round duplicate raw call-id mapping.';

    await writeMockDb(tmpRoot, [
      {
        message: duplicatePrompt,
        role: 'user',
        response: 'Trying the duplicate call.',
        funcCalls: [
          {
            id: duplicateCallId,
            name: duplicateCallName,
            arguments: { key: 'DOMINDS_DUPLICATE_TOOL_CALL_FEEDBACK' },
          },
        ],
      },
      {
        message: '(unset)',
        role: 'tool',
        response: recovered,
      },
      {
        message: sameRoundPrompt,
        role: 'user',
        response: 'Trying two calls with one id.',
        funcCalls: [
          {
            id: sameRoundCallId,
            name: duplicateCallName,
            arguments: { key: 'DOMINDS_DUPLICATE_TOOL_CALL_FEEDBACK' },
          },
          {
            id: sameRoundCallId,
            name: duplicateCallName,
            arguments: { key: 'DOMINDS_DUPLICATE_TOOL_CALL_FEEDBACK' },
          },
        ],
      },
      {
        message: '(unset)',
        role: 'tool',
        response: sameRoundRecovered,
      },
    ]);

    const dlg = await createMainDialog('tester');
    dlg.disableDiligencePush = true;
    await dlg.persistFunctionCall(duplicateCallId, duplicateCallName, '{}', 1);
    const ch = dialogEventRegistry.createSubChan(dlg.id);

    await driveDialogStream(
      dlg,
      makeUserPrompt(duplicatePrompt, 'kernel-driver-duplicate-tool-call-feedback'),
      true,
    );

    const duplicateFuncCalls = dlg.msgs.filter(
      (msg) => msg.type === 'func_call_msg' && msg.name === duplicateCallName,
    );
    assert.equal(
      duplicateFuncCalls.length,
      1,
      'expected one duplicate raw-id call in live context',
    );
    assert.equal(duplicateFuncCalls[0]?.rawId, duplicateCallId);
    assert.notEqual(duplicateFuncCalls[0]?.id, duplicateCallId);
    const events = await DialogPersistence.loadCourseEvents(dlg.id, 1, dlg.status);
    const duplicateCallRecords = events.filter(
      (event) =>
        event.type === 'func_call_record' &&
        event.name === duplicateCallName &&
        event.rawId === duplicateCallId,
    );
    assert.equal(
      duplicateCallRecords.length,
      2,
      'duplicate raw id should still persist both calls',
    );
    assert.notEqual(duplicateCallRecords[1]?.id, duplicateCallId);

    const streamErrors = (await collectEvents(ch, 300)).filter(
      (event): event is Extract<TypedDialogEvent, { type: 'stream_error_evt' }> =>
        event.type === 'stream_error_evt',
    );
    assert.deepEqual(streamErrors, [], 'duplicate raw-id mapping must not emit stream_error_evt');

    const sameRoundDlg = await createMainDialog('tester');
    sameRoundDlg.disableDiligencePush = true;
    const sameRoundCh = dialogEventRegistry.createSubChan(sameRoundDlg.id);

    await driveDialogStream(
      sameRoundDlg,
      makeUserPrompt(sameRoundPrompt, 'kernel-driver-same-round-duplicate-tool-call-feedback'),
      true,
    );

    const sameRoundFuncCalls = sameRoundDlg.msgs.filter(
      (msg) => msg.type === 'func_call_msg' && msg.name === duplicateCallName,
    );
    assert.equal(sameRoundFuncCalls.length, 2, 'expected both same-round raw-id calls');
    assert.equal(sameRoundFuncCalls[0]?.id, sameRoundCallId);
    assert.equal(sameRoundFuncCalls[1]?.rawId, sameRoundCallId);
    assert.notEqual(sameRoundFuncCalls[1]?.id, sameRoundCallId);
    const sameRoundEvents = await DialogPersistence.loadCourseEvents(
      sameRoundDlg.id,
      1,
      sameRoundDlg.status,
    );
    const sameRoundCallRecords = sameRoundEvents.filter(
      (event) =>
        event.type === 'func_call_record' &&
        event.name === duplicateCallName &&
        event.rawId === sameRoundCallId,
    );
    assert.equal(
      sameRoundCallRecords.length,
      2,
      'same-round duplicate raw ids should both persist',
    );
    assert.notEqual(sameRoundCallRecords[1]?.id, sameRoundCallId);
    const sameRoundStreamErrors = (await collectEvents(sameRoundCh, 300)).filter(
      (event): event is Extract<TypedDialogEvent, { type: 'stream_error_evt' }> =>
        event.type === 'stream_error_evt',
    );
    assert.deepEqual(
      sameRoundStreamErrors,
      [],
      'same-round duplicate LLM call feedback must not emit stream_error_evt',
    );
  });

  console.log('kernel-driver duplicate-tool-call-feedback: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver duplicate-tool-call-feedback: FAIL\n${message}`);
  process.exit(1);
});
