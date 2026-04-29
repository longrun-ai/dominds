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

function duplicateCallResultContent(callId: string, callName: string): string {
  return [
    `Error: this function call was rejected because callId \`${callId}\` has already been used.`,
    '',
    `Do not reuse an existing callId for \`${callName}\`. If you still need the tool, issue a new function call with a fresh callId.`,
  ].join('\n');
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot);

    const duplicatePrompt = 'Repeat an old function call id.';
    const duplicateCallId = 'duplicate-function-call-id';
    const duplicateCallName = 'perform_paste';
    const duplicateResult = duplicateCallResultContent(duplicateCallId, duplicateCallName);
    const recovered = 'Recovered after duplicate call-id feedback.';
    const sameRoundPrompt = 'Reuse one function call id twice in the same response.';
    const sameRoundCallId = 'same-round-duplicate-function-call-id';
    const sameRoundDuplicateResult = duplicateCallResultContent(sameRoundCallId, duplicateCallName);
    const sameRoundRecovered = 'Recovered after same-round duplicate call-id feedback.';

    await writeMockDb(tmpRoot, [
      {
        message: duplicatePrompt,
        role: 'user',
        response: 'Trying the duplicate call.',
        funcCalls: [
          {
            id: duplicateCallId,
            name: duplicateCallName,
            arguments: { text: 'stale paste' },
          },
        ],
      },
      {
        message: duplicateResult,
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
            arguments: { text: 'first paste' },
          },
          {
            id: sameRoundCallId,
            name: duplicateCallName,
            arguments: { text: 'second paste' },
          },
        ],
      },
      {
        message: sameRoundDuplicateResult,
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

    assert(
      dlg.msgs.some(
        (msg) =>
          msg.type === 'func_result_msg' &&
          msg.id === duplicateCallId &&
          msg.name === duplicateCallName &&
          msg.content === duplicateResult,
      ),
      'duplicate function call should be returned to the LLM as a tool failure result',
    );
    assert(
      dlg.msgs.some(
        (msg) => msg.type === 'saying_msg' && msg.role === 'assistant' && msg.content === recovered,
      ),
      'driver should continue after duplicate call-id feedback',
    );

    const events = await DialogPersistence.loadCourseEvents(dlg.id, 1, dlg.status);
    assert.equal(
      events.filter((event) => event.type === 'func_call_record' && event.id === duplicateCallId)
        .length,
      1,
      'duplicate LLM call must not persist a second function call record',
    );
    assert.equal(
      events.filter((event) => event.type === 'func_result_record' && event.id === duplicateCallId)
        .length,
      0,
      'duplicate LLM call feedback must not persist a second call-id result fact',
    );

    const streamErrors = (await collectEvents(ch, 300)).filter(
      (event): event is Extract<TypedDialogEvent, { type: 'stream_error_evt' }> =>
        event.type === 'stream_error_evt',
    );
    assert.deepEqual(
      streamErrors,
      [],
      'duplicate LLM call feedback must not emit stream_error_evt',
    );

    const sameRoundDlg = await createMainDialog('tester');
    sameRoundDlg.disableDiligencePush = true;
    const sameRoundCh = dialogEventRegistry.createSubChan(sameRoundDlg.id);

    await driveDialogStream(
      sameRoundDlg,
      makeUserPrompt(sameRoundPrompt, 'kernel-driver-same-round-duplicate-tool-call-feedback'),
      true,
    );

    assert(
      sameRoundDlg.msgs.some(
        (msg) =>
          msg.type === 'func_result_msg' &&
          msg.id === sameRoundCallId &&
          msg.name === duplicateCallName &&
          msg.content === sameRoundDuplicateResult,
      ),
      'same-round duplicate function call should be returned as a tool failure result',
    );
    assert(
      sameRoundDlg.msgs.some(
        (msg) =>
          msg.type === 'saying_msg' &&
          msg.role === 'assistant' &&
          msg.content === sameRoundRecovered,
      ),
      'driver should continue after same-round duplicate call-id feedback',
    );

    const sameRoundEvents = await DialogPersistence.loadCourseEvents(
      sameRoundDlg.id,
      1,
      sameRoundDlg.status,
    );
    assert.equal(
      sameRoundEvents.filter(
        (event) => event.type === 'func_call_record' && event.id === sameRoundCallId,
      ).length,
      1,
      'same-round duplicate LLM calls must persist only the first function call record',
    );
    assert.equal(
      sameRoundEvents.filter(
        (event) => event.type === 'func_result_record' && event.id === sameRoundCallId,
      ).length,
      1,
      'same-round duplicate LLM calls must persist only the first function result record',
    );
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
