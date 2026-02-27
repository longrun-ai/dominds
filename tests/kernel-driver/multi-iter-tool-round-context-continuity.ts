import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/driver-entry';

import { createRootDialog, withTempRtws, writeMockDb, writeStandardMinds } from './helpers';

const ENV_KEY = 'DOMINDS_TEST_CTX_CONTINUITY';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { memberTools: ['env_get'] });

    delete process.env[ENV_KEY];

    const trigger = 'Tool-round continuity probe: keep this user request in context.';
    const afterTool = 'Tool round completed with prior context intact.';

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: 'Calling env_get before final answer.',
        funcCalls: [{ name: 'env_get', arguments: { key: ENV_KEY } }],
      },
      {
        message: '(unset)',
        role: 'tool',
        response: afterTool,
        contextContains: [trigger],
      },
    ]);

    const dlg = createRootDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      {
        content: trigger,
        msgId: 'kernel-driver-tool-round-context-continuity',
        grammar: 'markdown',
      },
      true,
    );

    const assistantSayings = dlg.msgs.filter(
      (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    assert.ok(assistantSayings.length >= 2, 'expected at least two assistant sayings');
    assert.equal(
      assistantSayings[assistantSayings.length - 1]?.content,
      afterTool,
      'final assistant saying should come from post-tool round with preserved context',
    );

    const funcCalls = dlg.msgs.filter((msg) => msg.type === 'func_call_msg');
    assert.equal(funcCalls.length, 1, 'expected exactly one function call in first round');
    assert.equal(funcCalls[0]?.name, 'env_get');

    const funcResults = dlg.msgs.filter((msg) => msg.type === 'func_result_msg');
    assert.equal(funcResults.length, 1, 'expected exactly one function result');
    assert.equal(funcResults[0]?.content, '(unset)');

    const fallbackCount = assistantSayings.filter((msg) =>
      msg.content.includes('Mock Response Not Found'),
    ).length;
    assert.equal(
      fallbackCount,
      0,
      'mock fallback indicates context or tool-round assembly drifted unexpectedly',
    );
  });

  console.log('kernel-driver multi-iter-tool-round-context-continuity: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver multi-iter-tool-round-context-continuity: FAIL\n${message}`);
  process.exit(1);
});
