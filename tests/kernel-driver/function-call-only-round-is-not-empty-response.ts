import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';

import {
  createRootDialog,
  makeUserPrompt,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { memberToolsets: ['codex_style_tools'] });

    const trigger = 'Update the plan and then finish.';

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: '',
        funcCalls: [
          {
            name: 'update_plan',
            arguments: {
              explanation: 'Record the current work state',
              plan: [
                { step: 'Keep the canary wait state visible', status: 'in_progress' },
                { step: 'Stop when there is nothing else to do', status: 'pending' },
              ],
            },
          },
        ],
      },
      {
        message: 'Updated',
        role: 'tool',
        response: 'Nothing else changed.',
      },
    ]);

    const dlg = await createRootDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      makeUserPrompt(trigger, 'kernel-driver-function-call-only-round-is-not-empty-response'),
      true,
    );

    const funcCalls = dlg.msgs.filter((msg) => msg.type === 'func_call_msg');
    assert.equal(funcCalls.length, 1, 'expected the tool-only round to preserve the function call');
    assert.equal(funcCalls[0]?.name, 'update_plan');

    const funcResults = dlg.msgs.filter((msg) => msg.type === 'func_result_msg');
    assert.equal(funcResults.length, 1, 'expected the function call to execute successfully');
    assert.equal(funcResults[0]?.content, 'Updated');

    const assistantSayings = dlg.msgs.filter(
      (msg): msg is Extract<(typeof dlg.msgs)[number], { type: 'saying_msg'; role: 'assistant' }> =>
        msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    assert.equal(
      assistantSayings.some((msg) => msg.content === 'Nothing else changed.'),
      true,
      'expected the follow-up round to complete normally instead of being treated as empty',
    );
  });

  console.log('kernel-driver function-call-only-round-is-not-empty-response: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver function-call-only-round-is-not-empty-response: FAIL\n${message}`);
  process.exit(1);
});
