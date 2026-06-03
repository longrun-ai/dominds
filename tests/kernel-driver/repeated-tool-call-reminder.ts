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

async function loadRepeatedToolGuideGenseqs(
  dlg: Awaited<ReturnType<typeof createMainDialog>>,
): Promise<number[]> {
  const events = await DialogPersistence.loadCourseEvents(dlg.id, 1, dlg.status);
  return events
    .filter((event) => event.type === 'runtime_guide_record' && event.content.includes(GUIDE_MATCH))
    .map((event) => event.genseq);
}

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
  assert.deepEqual(
    await loadRepeatedToolGuideGenseqs(dlg),
    [3],
    'expected a persisted runtime guide record so the UI can render a visible bubble',
  );
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

async function runSameGenerationTripleReminder(): Promise<void> {
  delete process.env[ENV_KEY];

  const prompt = 'Call the same tool three times in one generation, then correct after notice.';
  const corrected = 'I received the same result three times in one generation and will stop.';
  const sameRoundKey = `${ENV_KEY}_SAME_ROUND`;
  await writeMockDb(process.cwd(), [
    {
      message: prompt,
      role: 'user',
      response: 'Same generation triple.',
      funcCalls: [
        { id: 'same-round-1', name: 'env_get', arguments: { key: sameRoundKey } },
        { id: 'same-round-2', name: 'env_get', arguments: { key: sameRoundKey } },
        { id: 'same-round-3', name: 'env_get', arguments: { key: sameRoundKey } },
      ],
    },
    {
      message: '(unset)',
      role: 'tool',
      contextContains: [GUIDE_MATCH, 'same-round-3'],
      response: corrected,
    },
  ]);

  const dlg = await createMainDialog('tester');
  dlg.disableDiligencePush = true;
  await driveDialogStream(
    dlg,
    makeUserPrompt(prompt, 'kernel-driver-repeated-tool-call-same-generation'),
    true,
  );

  const funcCalls = dlg.msgs.filter((msg) => msg.type === 'func_call_msg');
  assert.equal(funcCalls.length, 3, 'expected three function calls in the first generation');
  assert.deepEqual(await loadRepeatedToolGuideGenseqs(dlg), [1]);
  const finalSaying = dlg.msgs
    .filter((msg) => msg.type === 'saying_msg' && msg.role === 'assistant')
    .at(-1);
  assert.equal(finalSaying?.content, corrected);
}

async function runStaleReminderRepromptsInsteadOfStopping(): Promise<void> {
  delete process.env[ENV_KEY];

  const prompt = 'Repeat after the runtime notice, but only after the stop window has expired.';
  const staleKey = `${ENV_KEY}_STALE`;
  const corrected = 'The old notice is stale, so the second notice corrected the loop.';
  const entries = [
    {
      message: prompt,
      role: 'user' as const,
      response: 'Stale setup one.',
      funcCalls: [{ id: 'stale-setup-1', name: 'env_get', arguments: { key: staleKey } }],
    },
    {
      message: '(unset)',
      role: 'tool' as const,
      contextContains: ['Stale setup one.'],
      response: 'Stale setup two.',
      funcCalls: [{ id: 'stale-setup-2', name: 'env_get', arguments: { key: staleKey } }],
    },
    {
      message: '(unset)',
      role: 'tool' as const,
      contextContains: ['Stale setup two.'],
      response: 'Stale setup three.',
      funcCalls: [{ id: 'stale-setup-3', name: 'env_get', arguments: { key: staleKey } }],
    },
    ...Array.from({ length: 6 }, (_, index) => {
      const round = index + 1;
      const previousText = round === 1 ? GUIDE_MATCH : `Window filler ${String(round - 1)}.`;
      return {
        message: '(unset)',
        role: 'tool' as const,
        contextContains: [previousText],
        response: `Window filler ${String(round)}.`,
        funcCalls: [
          {
            id: `stale-window-${String(round)}`,
            name: 'env_get',
            arguments: { key: `${ENV_KEY}_WINDOW_${String(round)}` },
          },
        ],
      };
    }),
    {
      message: '(unset)',
      role: 'tool' as const,
      contextContains: ['Window filler 6.'],
      response: 'Stale repeat one.',
      funcCalls: [{ id: 'stale-repeat-1', name: 'env_get', arguments: { key: staleKey } }],
    },
    {
      message: '(unset)',
      role: 'tool' as const,
      contextContains: ['Stale repeat one.'],
      response: 'Stale repeat two.',
      funcCalls: [{ id: 'stale-repeat-2', name: 'env_get', arguments: { key: staleKey } }],
    },
    {
      message: '(unset)',
      role: 'tool' as const,
      contextContains: ['Stale repeat two.'],
      response: 'Stale repeat three.',
      funcCalls: [{ id: 'stale-repeat-3', name: 'env_get', arguments: { key: staleKey } }],
    },
    {
      message: '(unset)',
      role: 'tool' as const,
      contextContains: [GUIDE_MATCH, 'Stale repeat three.'],
      response: corrected,
    },
  ];
  await writeMockDb(process.cwd(), entries);

  const dlg = await createMainDialog('tester');
  dlg.disableDiligencePush = true;
  await driveDialogStream(
    dlg,
    makeUserPrompt(prompt, 'kernel-driver-repeated-tool-call-stale-reminder'),
    true,
  );

  const guides = dlg.msgs.filter(
    (msg) => msg.type === 'transient_guide_msg' && msg.content.includes(GUIDE_MATCH),
  );
  assert.equal(guides.length, 2, 'expected stale repeated tool loops to be reminded again');
  assert.deepEqual(
    await loadRepeatedToolGuideGenseqs(dlg),
    [3, 12],
    'expected repeated-tool reminders to be user-visible records at both warning points',
  );
  const latest = await DialogPersistence.loadDialogLatest(dlg.id, dlg.status);
  assert.ok(latest, 'expected latest dialog state after stale reminder run');
  assert.notEqual(latest.displayState.kind, 'stopped');
  const finalSaying = dlg.msgs
    .filter((msg) => msg.type === 'saying_msg' && msg.role === 'assistant')
    .at(-1);
  assert.equal(finalSaying?.content, corrected);
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { memberTools: ['env_get'] });
    await runReminderThenSelfCorrection();
    await runStopAfterIgnoredReminder();
    await runSameGenerationTripleReminder();
    await runStaleReminderRepromptsInsteadOfStopping();
  });

  console.log('kernel-driver repeated-tool-call-reminder: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver repeated-tool-call-reminder: FAIL\n${message}`);
  process.exit(1);
});
