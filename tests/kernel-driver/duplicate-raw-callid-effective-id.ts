import assert from 'node:assert/strict';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  makeUserPrompt,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot, { memberTools: ['env_get'] });

    const key = 'DOMINDS_DUP_RAW_CALL_ID_EFFECTIVE_ID';
    delete process.env[key];

    const reusedCallId = 'reused-raw-call-id';
    const firstPrompt = 'First tool call with a raw id.';
    const secondPrompt = 'Second tool call reusing the same raw id in the same course.';
    const manualReusePrompt = 'Reuse a manually persisted raw id in the same course.';
    const mixedPrompt = 'Use a normal tool and askHuman with the same raw id in one round.';
    const firstDone = 'First tool result accepted.';
    const secondDone = 'Second tool result accepted.';
    const sharedSpecialCallId = 'shared-special-call-id';

    await writeMockDb(tmpRoot, [
      {
        message: firstPrompt,
        role: 'user',
        response: 'Calling the first tool.',
        funcCalls: [{ id: reusedCallId, name: 'env_get', arguments: { key } }],
      },
      {
        message: '(unset)',
        role: 'tool',
        response: firstDone,
      },
      {
        message: secondPrompt,
        role: 'user',
        response: 'Calling the second tool with reused raw id.',
        funcCalls: [{ id: reusedCallId, name: 'env_get', arguments: { key } }],
      },
      {
        message: '(unset)',
        role: 'tool',
        response: secondDone,
      },
      {
        message: manualReusePrompt,
        role: 'user',
        response: 'Calling a tool with a manually reused raw id.',
        funcCalls: [{ id: 'manual-raw-id', name: 'env_get', arguments: { key } }],
      },
      {
        message: '(unset)',
        role: 'tool',
        response: 'Manual raw id reuse accepted.',
      },
      {
        message: mixedPrompt,
        role: 'user',
        response: 'Calling a normal tool before askHuman with the same id.',
        funcCalls: [
          { id: sharedSpecialCallId, name: 'env_get', arguments: { key } },
          {
            id: sharedSpecialCallId,
            name: 'askHuman',
            arguments: { tellaskContent: 'Please confirm the shared-id behavior.' },
          },
        ],
      },
      {
        message: '(unset)',
        role: 'tool',
        response: 'Tool result after shared id remap.',
      },
    ]);

    const dlg = await createMainDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      makeUserPrompt(firstPrompt, 'kernel-driver-duplicate-raw-callid-effective-id-1'),
      true,
    );
    await driveDialogStream(
      dlg,
      makeUserPrompt(secondPrompt, 'kernel-driver-duplicate-raw-callid-effective-id-2'),
      true,
    );

    const funcCalls = dlg.msgs.filter((msg) => msg.type === 'func_call_msg');
    assert.equal(funcCalls.length, 2, 'expected both duplicate raw-id calls to remain in context');
    assert.equal(funcCalls[0]?.id, reusedCallId, 'first call should keep raw id as effective id');
    assert.equal(funcCalls[0]?.rawId, reusedCallId, 'first call should persist raw id');
    assert.equal(funcCalls[1]?.rawId, reusedCallId, 'second call should preserve duplicate raw id');
    assert.notEqual(
      funcCalls[1]?.id,
      reusedCallId,
      'second call should receive a unique effective id',
    );
    assert.match(
      funcCalls[1]?.id ?? '',
      /^reused-raw-call-id__dominds_c1_g\d+_2$/u,
      'second call should use the course-scoped effective id suffix',
    );

    const funcResults = dlg.msgs.filter((msg) => msg.type === 'func_result_msg');
    assert.equal(funcResults.length, 2, 'expected both function results');
    assert.equal(funcResults[1]?.rawId, reusedCallId, 'second result should keep raw id');
    assert.equal(
      funcResults[1]?.id,
      funcCalls[1]?.id,
      'second result should correlate by effective id',
    );

    const events = await DialogPersistence.loadCourseEvents(dlg.id, 1, dlg.status);
    const callRecords = events.filter((event) => event.type === 'func_call_record');
    assert.equal(callRecords.length, 2, 'expected two persisted call records');
    assert.deepEqual(
      callRecords.map((event) => event.rawId),
      [reusedCallId, reusedCallId],
      'persisted records should retain raw ids',
    );
    assert.notEqual(
      callRecords[1]?.id,
      reusedCallId,
      'persisted duplicate call should use effective id as record id',
    );
    await dlg.persistFunctionCall('manual-effective-id', 'env_get', '{}', 5, 'manual-raw-id');
    await driveDialogStream(
      dlg,
      makeUserPrompt(manualReusePrompt, 'kernel-driver-manual-raw-callid-reuse'),
      true,
    );
    const manualReuseEvents = await DialogPersistence.loadCourseEvents(dlg.id, 1, dlg.status);
    const manualReuseCall = manualReuseEvents.find(
      (event) =>
        event.type === 'func_call_record' &&
        event.rawId === 'manual-raw-id' &&
        event.name === 'env_get' &&
        event.rawArgumentsText === JSON.stringify({ key }),
    );
    assert.ok(manualReuseCall, 'expected reuse of manually persisted raw id to be recorded');
    assert.notEqual(
      manualReuseCall.id,
      'manual-raw-id',
      'history rawId occupancy should force a distinct effective id',
    );

    await dlg.startNewCourse('new course for raw call id reuse');
    await dlg.persistFunctionCall(reusedCallId, 'env_get', '{}', 1, reusedCallId);
    const secondCourseEvents = await DialogPersistence.loadCourseEvents(dlg.id, 2, dlg.status);
    assert(
      secondCourseEvents.some(
        (event) =>
          event.type === 'func_call_record' &&
          event.id === reusedCallId &&
          event.rawId === reusedCallId,
      ),
      'cross-course reuse of raw/effective call id should be allowed',
    );

    const mixedDlg = await createMainDialog('tester');
    mixedDlg.disableDiligencePush = true;
    await driveDialogStream(
      mixedDlg,
      makeUserPrompt(mixedPrompt, 'kernel-driver-shared-normal-special-callid'),
      true,
    );
    const mixedEvents = await DialogPersistence.loadCourseEvents(
      mixedDlg.id,
      mixedDlg.currentCourse,
      mixedDlg.status,
    );
    const mixedEnvGetCall = mixedEvents.find(
      (event) => event.type === 'func_call_record' && event.name === 'env_get',
    );
    assert.ok(mixedEnvGetCall, 'expected normal tool call to persist');
    assert.equal(mixedEnvGetCall.rawId, sharedSpecialCallId);
    assert.notEqual(
      mixedEnvGetCall.id,
      sharedSpecialCallId,
      'normal tool should not steal a same-round special business callId',
    );
    const mixedAskHumanCall = mixedEvents.find(
      (event) => event.type === 'tellask_call_record' && event.name === 'askHuman',
    );
    assert.ok(mixedAskHumanCall, 'expected askHuman call to persist');
    assert.equal(
      mixedAskHumanCall.id,
      sharedSpecialCallId,
      'askHuman should keep its raw business callId',
    );
    const questions = await DialogPersistence.loadQuestions4HumanState(
      mixedDlg.id,
      mixedDlg.status,
    );
    assert.equal(questions.length, 1, 'expected askHuman to register one Q4H question');
    assert.equal(questions[0]?.callId, sharedSpecialCallId);
  });

  console.log('kernel-driver duplicate-raw-callid-effective-id: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver duplicate-raw-callid-effective-id: FAIL\n${message}`);
  process.exit(1);
});
