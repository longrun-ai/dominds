import assert from 'node:assert/strict';

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

const GUIDE_MATCH = 'same tool call three times';
const ENV_KEY = 'DOMINDS_REPEATED_TOOL_CALL_REMINDER';

async function runReminderThenSelfCorrection(): Promise<void> {
  delete process.env[ENV_KEY];

  const prompt = 'Probe repeated identical tool calls, then correct after the runtime notice.';
  const corrected =
    'I will stop repeating the same tool call and answer from the available result.';

  await writeMockDb(process.cwd(), [
    {
      message: prompt,
      role: 'user',
      response: 'First repeated attempt.',
      funcCalls: [{ id: 'repeat-reminder-1', name: 'env_get', arguments: { key: ENV_KEY } }],
    },
    {
      message: '(unset)',
      role: 'tool',
      contextContains: ['First repeated attempt.'],
      response: 'Second repeated attempt.',
      funcCalls: [{ id: 'repeat-reminder-2', name: 'env_get', arguments: { key: ENV_KEY } }],
    },
    {
      message: '(unset)',
      role: 'tool',
      contextContains: ['Second repeated attempt.'],
      response: 'Third repeated attempt.',
      funcCalls: [{ id: 'repeat-reminder-3', name: 'env_get', arguments: { key: ENV_KEY } }],
    },
    {
      message: '(unset)',
      role: 'tool',
      contextContains: [GUIDE_MATCH],
      response: corrected,
    },
  ]);

  const dlg = await createMainDialog('tester');
  dlg.disableDiligencePush = true;
  await driveDialogStream(
    dlg,
    makeUserPrompt(prompt, 'kernel-driver-repeated-tool-call-reminder'),
    true,
  );

  const funcCalls = dlg.msgs.filter((msg) => msg.type === 'func_call_msg');
  assert.equal(funcCalls.length, 3, 'expected exactly three repeated tool calls before correction');
  const guides = dlg.msgs.filter(
    (msg) => msg.type === 'transient_guide_msg' && msg.content.includes(GUIDE_MATCH),
  );
  assert.equal(guides.length, 1, 'expected one runtime guide for repeated identical tool calls');
  const finalSaying = dlg.msgs
    .filter((msg) => msg.type === 'saying_msg' && msg.role === 'assistant')
    .at(-1);
  assert.equal(finalSaying?.content, corrected);
}

async function runStopAfterIgnoredReminder(): Promise<void> {
  delete process.env[ENV_KEY];

  const prompt = 'Keep repeating the identical tool call even after the runtime notice.';
  await writeMockDb(process.cwd(), [
    {
      message: prompt,
      role: 'user',
      response: 'Loop one.',
      funcCalls: [{ id: 'repeat-stop-1', name: 'env_get', arguments: { key: ENV_KEY } }],
    },
    {
      message: '(unset)',
      role: 'tool',
      contextContains: ['Loop one.'],
      response: 'Loop two.',
      funcCalls: [{ id: 'repeat-stop-2', name: 'env_get', arguments: { key: ENV_KEY } }],
    },
    {
      message: '(unset)',
      role: 'tool',
      contextContains: ['Loop two.'],
      response: 'Loop three.',
      funcCalls: [{ id: 'repeat-stop-3', name: 'env_get', arguments: { key: ENV_KEY } }],
    },
    {
      message: '(unset)',
      role: 'tool',
      contextContains: [GUIDE_MATCH],
      response: 'Ignored reminder once.',
      funcCalls: [{ id: 'repeat-stop-4', name: 'env_get', arguments: { key: ENV_KEY } }],
    },
    {
      message: '(unset)',
      role: 'tool',
      contextContains: ['Ignored reminder once.'],
      response: 'Ignored reminder twice.',
      funcCalls: [{ id: 'repeat-stop-5', name: 'env_get', arguments: { key: ENV_KEY } }],
    },
    {
      message: '(unset)',
      role: 'tool',
      contextContains: ['Ignored reminder twice.'],
      response: 'Ignored reminder three times.',
      funcCalls: [{ id: 'repeat-stop-6', name: 'env_get', arguments: { key: ENV_KEY } }],
    },
  ]);

  const dlg = await createMainDialog('tester');
  dlg.disableDiligencePush = true;
  await driveDialogStream(
    dlg,
    makeUserPrompt(prompt, 'kernel-driver-repeated-tool-call-stop'),
    true,
  );

  const funcCalls = dlg.msgs.filter((msg) => msg.type === 'func_call_msg');
  assert.equal(funcCalls.length, 6, 'expected the second repeated triple before stopping');
  const latest = await DialogPersistence.loadDialogLatest(dlg.id, dlg.status);
  assert.equal(latest?.displayState.kind, 'stopped');
  assert.equal(latest?.displayState.reason.kind, 'system_stop');
  if (latest?.displayState.reason.kind === 'system_stop') {
    assert.match(latest.displayState.reason.detail, /behavior\/personality problem/);
  }
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { memberTools: ['env_get'] });
    await runReminderThenSelfCorrection();
    await runStopAfterIgnoredReminder();
  });

  console.log('kernel-driver repeated-tool-call-reminder: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver repeated-tool-call-reminder: FAIL\n${message}`);
  process.exit(1);
});
