import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';

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
