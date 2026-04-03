import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';

import { createRootDialog, withTempRtws, writeMockDb, writeStandardMinds } from './helpers';

function getJsonParseMessage(raw: string): string {
  try {
    JSON.parse(raw);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('Expected malformed JSON input to fail parsing');
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { memberTools: ['env_get'] });

    const trigger = 'Call env_get, but the first tool call arguments are malformed JSON.';
    const badArguments = '{"key":';
    const toolError = `Invalid arguments: Arguments must be valid JSON: ${getJsonParseMessage(badArguments)}`;
    const recovery =
      'The malformed function call failed, so I corrected course and answered normally.';

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: 'Calling env_get with malformed JSON.',
        funcCalls: [{ name: 'env_get', arguments: badArguments }],
      },
      {
        message: toolError,
        role: 'tool',
        response: recovery,
        contextContains: [trigger],
      },
    ]);

    const dlg = await createRootDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      {
        content: trigger,
        msgId: 'kernel-driver-invalid-json-tool-call-feedback',
        grammar: 'markdown',
      },
      true,
    );

    const funcCalls = dlg.msgs.filter((msg) => msg.type === 'func_call_msg');
    assert.equal(funcCalls.length, 1, 'expected exactly one function call');
    assert.equal(funcCalls[0]?.name, 'env_get');
    assert.equal(
      funcCalls[0]?.arguments,
      '{}',
      'invalid function call arguments should be normalized before being fed back to the model',
    );

    const funcResults = dlg.msgs.filter((msg) => msg.type === 'func_result_msg');
    assert.equal(funcResults.length, 1, 'expected exactly one function result');
    assert.equal(
      funcResults[0]?.content,
      toolError,
      'malformed JSON should surface as a function call failure result',
    );

    const persistedEvents = await DialogPersistence.loadCourseEvents(dlg.id, 1, 'running');
    const persistedCall = persistedEvents.find(
      (event) => event.type === 'func_call_record' && event.id === funcCalls[0]?.id,
    );
    assert(persistedCall, 'expected malformed tool call to persist a func_call_record');
    if (persistedCall.type !== 'func_call_record') {
      throw new Error('expected persisted malformed tool call to be a func_call_record');
    }
    assert.deepEqual(
      persistedCall.arguments,
      {},
      'malformed JSON should persist normalized empty call arguments for restoration',
    );

    const restored = await DialogPersistence.restoreDialog(dlg.id, 'running');
    assert(restored, 'expected restoreDialog to succeed after malformed tool call');
    const restoredCall = restored.messages.find(
      (msg) => msg.type === 'func_call_msg' && msg.id === funcCalls[0]?.id,
    );
    assert(restoredCall, 'expected restored dialog state to include the malformed tool call');
    const restoredResult = restored.messages.find(
      (msg) => msg.type === 'func_result_msg' && msg.id === funcCalls[0]?.id,
    );
    assert(
      restoredResult,
      'expected restored dialog state to include the malformed tool failure result',
    );

    const assistantSayings = dlg.msgs.filter(
      (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    assert.ok(assistantSayings.length >= 2, 'expected a recovery round after the tool failure');
    assert.equal(
      assistantSayings[assistantSayings.length - 1]?.content,
      recovery,
      'expected the next model round to see the function failure and recover',
    );
  });

  console.log('kernel-driver invalid-json-tool-call-feedback: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver invalid-json-tool-call-feedback: FAIL\n${message}`);
  process.exit(1);
});
