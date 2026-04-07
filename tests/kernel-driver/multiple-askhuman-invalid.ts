import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence, DiskFileDialogStore } from '../../main/persistence';

import {
  createRootDialog,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

const MULTI_ASKHUMAN_ERROR =
  '不允许一轮多次调用 askHuman，必须单次调用问所有问题。 Do not call askHuman multiple times in one round; ask all questions in a single askHuman call.';

async function runScenario(args: {
  root: Awaited<ReturnType<typeof createRootDialog>>;
  content: string;
  msgId: string;
}): Promise<void> {
  args.root.disableDiligencePush = true;
  await driveDialogStream(
    args.root,
    {
      content: args.content,
      msgId: args.msgId,
      grammar: 'markdown',
      origin: 'user',
    },
    true,
    { suppressDiligencePush: true },
  );
  await waitForAllDialogsUnlocked(args.root, 3_000);
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);
    await writeMockDb(tmpRoot, [
      {
        message: 'Please ask me two separate human questions right now.',
        role: 'user',
        response: 'I need clarification from the human.',
        funcCalls: [
          {
            id: 'askhuman-primary',
            name: 'askHuman',
            arguments: {
              tellaskContent: 'Please confirm the deployment window.',
            },
          },
          {
            id: 'askhuman-extra',
            name: 'askHuman',
            arguments: {
              tellaskContent: 'Please also confirm whether rollback is allowed.',
            },
          },
        ],
      },
    ]);

    const root = await createRootDialog('tester');
    await runScenario({
      root,
      content: 'Please ask me two separate human questions right now.',
      msgId: 'multiple-askhuman-invalid-user-msg',
    });

    const questions = await DialogPersistence.loadQuestions4HumanState(root.id, root.status);
    assert.equal(
      questions.length,
      0,
      'no askHuman question should be registered when a round emits multiple askHuman calls',
    );

    const courseEvents = await DialogPersistence.loadCourseEvents(
      root.id,
      root.currentCourse,
      root.status,
    );
    const invalidAskHumanPrimaryResult = courseEvents.find(
      (event) =>
        event.type === 'func_result_record' &&
        event.id === 'askhuman-primary' &&
        event.name === 'askHuman',
    );
    assert.ok(
      invalidAskHumanPrimaryResult,
      'the first askHuman call should also receive an automatic tool error result',
    );
    assert.equal(invalidAskHumanPrimaryResult?.content, MULTI_ASKHUMAN_ERROR);

    const invalidAskHumanExtraResult = courseEvents.find(
      (event) =>
        event.type === 'func_result_record' &&
        event.id === 'askhuman-extra' &&
        event.name === 'askHuman',
    );
    assert.ok(
      invalidAskHumanExtraResult,
      'the extra askHuman call should receive an automatic tool error result',
    );
    assert.equal(invalidAskHumanExtraResult?.content, MULTI_ASKHUMAN_ERROR);

    assert.equal(
      courseEvents.filter(
        (event) => event.type === 'tellask_call_record' && event.name === 'askHuman',
      ).length,
      2,
      'failed multi-askHuman calls should still be preserved as handled tool call records',
    );

    const replayedPackets: unknown[] = [];
    const replayWs = {
      readyState: 1,
      send(payload: string): void {
        replayedPackets.push(JSON.parse(payload));
      },
    } as unknown as import('ws').WebSocket;
    const replayStore = new DiskFileDialogStore(root.id);
    await replayStore.sendDialogEventsDirectly(
      replayWs,
      root,
      root.currentCourse,
      root.currentCourse,
      root.status,
    );
    assert.equal(
      replayedPackets.filter((packet) => {
        if (typeof packet !== 'object' || packet === null) return false;
        const evt = packet as { type?: unknown; funcName?: unknown; arguments?: unknown };
        return (
          evt.type === 'func_call_requested_evt' &&
          evt.funcName === 'askHuman' &&
          evt.arguments === '{"tellaskContent":"Please confirm the deployment window."}'
        );
      }).length,
      1,
      'restore replay should preserve the first rejected askHuman raw arguments exactly',
    );
    assert.equal(
      replayedPackets.filter((packet) => {
        if (typeof packet !== 'object' || packet === null) return false;
        const evt = packet as { type?: unknown; funcName?: unknown; arguments?: unknown };
        return (
          evt.type === 'func_call_requested_evt' &&
          evt.funcName === 'askHuman' &&
          evt.arguments === '{"tellaskContent":"Please also confirm whether rollback is allowed."}'
        );
      }).length,
      1,
      'restore replay should preserve the second rejected askHuman raw arguments exactly',
    );
    assert.equal(
      replayedPackets.filter((packet) => {
        if (typeof packet !== 'object' || packet === null) return false;
        const evt = packet as { type?: unknown; callName?: unknown };
        return evt.type === 'tellask_call_start_evt' && evt.callName === 'askHuman';
      }).length,
      0,
      'restore replay should not synthesize tellask_call_start_evt for rejected askHuman calls',
    );

    await writeMockDb(tmpRoot, [
      {
        message: 'Please ask one valid and one malformed human question right now.',
        role: 'user',
        response: 'I will ask the human twice again.',
        funcCalls: [
          {
            id: 'askhuman-invalid-mixed',
            name: 'askHuman',
            arguments: '{"tellaskContent":',
          },
          {
            id: 'askhuman-valid-mixed',
            name: 'askHuman',
            arguments: {
              tellaskContent: 'Please confirm the maintenance window.',
            },
          },
        ],
      },
    ]);

    const mixedRoot = await createRootDialog('tester');
    await runScenario({
      root: mixedRoot,
      content: 'Please ask one valid and one malformed human question right now.',
      msgId: 'multiple-askhuman-invalid-mixed-user-msg',
    });

    const mixedQuestions = await DialogPersistence.loadQuestions4HumanState(
      mixedRoot.id,
      mixedRoot.status,
    );
    assert.equal(
      mixedQuestions.length,
      0,
      'mixed-validity multi-askHuman should also register no Q4H question',
    );

    const mixedEvents = await DialogPersistence.loadCourseEvents(
      mixedRoot.id,
      mixedRoot.currentCourse,
      mixedRoot.status,
    );
    for (const callId of ['askhuman-valid-mixed', 'askhuman-invalid-mixed']) {
      const result = mixedEvents.find(
        (event) =>
          event.type === 'func_result_record' && event.id === callId && event.name === 'askHuman',
      );
      assert.ok(result, `expected ${callId} to receive automatic multi-askHuman failure result`);
      assert.equal(result?.content, MULTI_ASKHUMAN_ERROR);
    }
    assert.deepEqual(
      mixedEvents
        .filter((event) => event.type === 'tellask_call_record' && event.name === 'askHuman')
        .map((event) => event.id),
      ['askhuman-invalid-mixed', 'askhuman-valid-mixed'],
      'mixed-validity multi-askHuman should preserve original call order in persisted history',
    );

    await writeMockDb(tmpRoot, [
      {
        message: 'Please interleave askHuman and another special call.',
        role: 'user',
        response: 'I will emit multiple askHuman calls with another tellask-special between them.',
        funcCalls: [
          {
            id: 'askhuman-order-first',
            name: 'askHuman',
            arguments: {
              tellaskContent: 'Please confirm the release train.',
            },
          },
          {
            id: 'tellask-order-middle',
            name: 'tellaskSessionless',
            arguments: '{"mentionList":',
          },
          {
            id: 'askhuman-order-last',
            name: 'askHuman',
            arguments: {
              tellaskContent: 'Please confirm whether hotfixes are allowed.',
            },
          },
        ],
      },
    ]);

    const interleavedRoot = await createRootDialog('tester');
    await runScenario({
      root: interleavedRoot,
      content: 'Please interleave askHuman and another special call.',
      msgId: 'multiple-askhuman-invalid-order-user-msg',
    });

    const interleavedEvents = await DialogPersistence.loadCourseEvents(
      interleavedRoot.id,
      interleavedRoot.currentCourse,
      interleavedRoot.status,
    );
    assert.deepEqual(
      interleavedEvents
        .filter((event) => event.type === 'tellask_call_record')
        .map((event) => event.id),
      ['askhuman-order-first', 'tellask-order-middle', 'askhuman-order-last'],
      'mixed special-call rounds should preserve original tellask-special call order in persisted history',
    );
    assert.equal(
      interleavedEvents.find(
        (event) =>
          event.type === 'func_result_record' &&
          event.id === 'askhuman-order-first' &&
          event.name === 'askHuman',
      )?.content,
      MULTI_ASKHUMAN_ERROR,
    );
    assert.equal(
      interleavedEvents.find(
        (event) =>
          event.type === 'func_result_record' &&
          event.id === 'askhuman-order-last' &&
          event.name === 'askHuman',
      )?.content,
      MULTI_ASKHUMAN_ERROR,
    );
  });

  console.log('kernel-driver multiple-askhuman-invalid: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver multiple-askhuman-invalid: FAIL\n${message}`);
  process.exit(1);
});
