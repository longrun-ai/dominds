import assert from 'node:assert/strict';

import { EndOfStream } from '@longrun-ai/kernel/evt';
import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import { dialogEventRegistry } from '../../main/evt-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';

import {
  createRootDialog,
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
    await writeStandardMinds(tmpRoot, { memberToolsets: ['codex_style_tools'] });

    const trigger = 'Please keep the execution plan updated until you are truly done.';
    const repeatedRoundSaying = 'Recording the same plan again.';
    const shouldNotReachFourthRound = 'This fourth identical update_plan follow-up should not run.';
    const identicalPlanArgs = {
      explanation: 'Track the same looped plan',
      plan: [
        { step: 'Keep recording the same plan', status: 'in_progress' },
        { step: 'Finish once real progress exists', status: 'pending' },
      ],
    };

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: repeatedRoundSaying,
        funcCalls: [{ name: 'update_plan', arguments: identicalPlanArgs }],
      },
      {
        message: 'Updated',
        role: 'tool',
        response: shouldNotReachFourthRound,
        contextContains: [repeatedRoundSaying],
        funcCalls: [{ name: 'update_plan', arguments: identicalPlanArgs }],
      },
      {
        message: 'Updated',
        role: 'tool',
        response: repeatedRoundSaying,
        contextContains: [repeatedRoundSaying],
        funcCalls: [{ name: 'update_plan', arguments: identicalPlanArgs }],
      },
      {
        message: 'Updated',
        role: 'tool',
        response: repeatedRoundSaying,
        contextContains: [repeatedRoundSaying],
        funcCalls: [{ name: 'update_plan', arguments: identicalPlanArgs }],
      },
    ]);

    const dlg = await createRootDialog('tester');
    dlg.disableDiligencePush = true;
    const ch = dialogEventRegistry.createSubChan(dlg.id);

    await driveDialogStream(
      dlg,
      makeUserPrompt(trigger, 'kernel-driver-identical-update-plan-loop-stop'),
      true,
    );

    const latest = await DialogPersistence.loadDialogLatest(dlg.id, dlg.status);
    assert.ok(latest?.displayState, 'expected latest.yaml displayState to be persisted');
    assert.equal(latest?.displayState?.kind, 'stopped');
    if (!latest?.displayState || latest.displayState.kind !== 'stopped') {
      throw new Error('Expected final displayState.kind to be stopped');
    }
    assert.equal(
      latest.displayState.continueEnabled,
      true,
      'guard stop should reuse the stopped panel and still allow manual Continue',
    );
    assert.equal(latest.displayState.reason.kind, 'system_stop');
    if (latest.displayState.reason.kind !== 'system_stop') {
      throw new Error('Expected guard stop reason.kind to be system_stop');
    }
    assert.match(
      latest.displayState.reason.detail,
      /update_plan|自激发循环|self-trigger loop/i,
      'guard stop detail should explain the repeated update_plan loop',
    );

    const courseEvents = await DialogPersistence.loadCourseEvents(
      dlg.id,
      dlg.currentCourse,
      dlg.status,
    );
    const genStartCount = courseEvents.filter((event) => event.type === 'gen_start_record').length;
    assert.equal(
      genStartCount,
      3,
      'the driver should stop after the third identical update_plan-only round before starting a fourth generation',
    );

    const assistantSayings = dlg.msgs.filter(
      (msg): msg is Extract<(typeof dlg.msgs)[number], { type: 'saying_msg'; role: 'assistant' }> =>
        msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    assert.ok(
      assistantSayings.length >= 2,
      'expected the loop to produce at least the initial repeated plan sayings before stopping',
    );
    assert.equal(
      assistantSayings.some((msg) => msg.content === shouldNotReachFourthRound),
      false,
      'a fourth identical update_plan auto-follow-up should never start',
    );

    const funcCalls = dlg.msgs.filter((msg) => msg.type === 'func_call_msg');
    assert.equal(funcCalls.length, 3, 'expected exactly three update_plan tool calls');
    assert.equal(
      funcCalls.every((msg) => msg.name === 'update_plan'),
      true,
      'expected every tool call in the loop to be update_plan',
    );

    const funcResults = dlg.msgs.filter((msg) => msg.type === 'func_result_msg');
    assert.equal(funcResults.length, 3, 'expected exactly three tool results before stopping');
    assert.equal(
      funcResults.every((msg) => msg.content === 'Updated'),
      true,
      'expected repeated update_plan results to remain unchanged across the stopped loop',
    );

    const events = await collectEvents(ch, 500);
    const streamErrors = events.filter(
      (event): event is Extract<TypedDialogEvent, { type: 'stream_error_evt' }> =>
        event.type === 'stream_error_evt',
    );
    assert.equal(
      streamErrors.length,
      0,
      'identical update_plan guard should stop cleanly without emitting stream_error_evt',
    );
  });

  console.log('kernel-driver identical-update-plan-loop-stops-auto-followup: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver identical-update-plan-loop-stops-auto-followup: FAIL\n${message}`);
  process.exit(1);
});
