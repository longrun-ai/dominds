import assert from 'node:assert/strict';

import { EndOfStream } from '@longrun-ai/kernel/evt';
import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import { toCallSiteCourseNo } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { dialogEventRegistry } from '../../main/evt-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import {
  processTellaskFunctionRound,
  type TellaskCallFunctionName,
} from '../../main/llm/kernel-driver/tellask-special';
import { DialogPersistence } from '../../main/persistence';

import {
  createMainDialog,
  makeUserPrompt,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

function getJsonParseMessage(raw: string): string {
  try {
    JSON.parse(raw);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('Expected malformed JSON input to fail parsing');
}

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

    const dlg = await createMainDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      makeUserPrompt(trigger, 'kernel-driver-invalid-json-tool-call-feedback'),
      true,
    );

    const funcCalls = dlg.msgs.filter((msg) => msg.type === 'func_call_msg');
    assert.equal(funcCalls.length, 1, 'expected exactly one function call');
    assert.equal(funcCalls[0]?.name, 'env_get');
    assert.equal(
      funcCalls[0]?.arguments,
      badArguments,
      'invalid function call arguments should preserve the original raw string in dialog history',
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
    assert.equal(
      persistedCall.rawArgumentsText,
      badArguments,
      'malformed JSON should persist the original raw argument string for restoration',
    );

    const restored = await DialogPersistence.restoreDialog(dlg.id, 'running');
    assert(restored, 'expected restoreDialog to succeed after malformed tool call');
    const restoredCall = restored.messages.find(
      (msg) => msg.type === 'func_call_msg' && msg.id === funcCalls[0]?.id,
    );
    assert(restoredCall, 'expected restored dialog state to include the malformed tool call');
    if (restoredCall.type !== 'func_call_msg') {
      throw new Error('expected restored malformed tool call to be a func_call_msg');
    }
    assert.equal(
      restoredCall.arguments,
      badArguments,
      'expected restored malformed tool call to preserve original raw arguments',
    );
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

    const invalidPayloadTrigger =
      'Provider emits a streamed tool-call payload with arguments but no function name.';
    const invalidPayloadRecovery =
      'I saw the invalid provider tool-call payload notice and continued without assuming the tool ran.';
    const invalidPayloadDetail =
      'OPENAI-COMPATIBLE missing streamed tool function name for callId=toolcall_67_2';

    await writeMockDb(tmpRoot, [
      {
        message: invalidPayloadTrigger,
        role: 'user',
        response: '',
        omitDefaultThinking: true,
        invalidFuncCalls: [
          {
            provider: 'openai-compatible',
            callId: 'toolcall_67_2',
            detail: invalidPayloadDetail,
            toolCallIndex: 2,
            rawArgumentsText: '{}',
          },
        ],
      },
      {
        message: invalidPayloadTrigger,
        role: 'user',
        response: invalidPayloadRecovery,
        contextContains: [invalidPayloadDetail, 'rawArgumentsText'],
      },
    ]);

    const invalidPayloadDlg = await createMainDialog('tester');
    invalidPayloadDlg.disableDiligencePush = true;
    const invalidPayloadCh = dialogEventRegistry.createSubChan(invalidPayloadDlg.id);

    await driveDialogStream(
      invalidPayloadDlg,
      makeUserPrompt(
        invalidPayloadTrigger,
        'kernel-driver-invalid-provider-tool-call-payload-feedback',
      ),
      true,
    );

    const invalidPayloadEvents = await collectEvents(invalidPayloadCh, 500);
    assert.ok(
      invalidPayloadEvents.some(
        (event) => event.type === 'stream_error_evt' && event.error === invalidPayloadDetail,
      ),
      'expected invalid provider tool-call payload to emit stream_error_evt',
    );
    const invalidPayloadGuides = invalidPayloadDlg.msgs.filter(
      (msg) => msg.type === 'transient_guide_msg' && msg.content.includes(invalidPayloadDetail),
    );
    assert.equal(
      invalidPayloadGuides.length,
      1,
      'expected invalid provider tool-call payload to persist one runtime guide',
    );
    const invalidPayloadSayings = invalidPayloadDlg.msgs.filter(
      (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    assert.equal(
      invalidPayloadSayings[invalidPayloadSayings.length - 1]?.content,
      invalidPayloadRecovery,
      'invalid provider tool-call payload should trigger same-drive recovery instead of stopping',
    );

    const invalidPayloadWithSayingTrigger =
      'Provider emits assistant text before an invalid streamed tool-call payload.';
    const invalidPayloadPrelude = 'I will try a provider tool call now.';
    const invalidPayloadWithSayingRecovery =
      'I saw the invalid provider payload after my previous text and continued in order.';
    const invalidPayloadWithSayingDetail =
      'OPENAI-COMPATIBLE missing streamed tool function name for callId=toolcall_68_1';

    await writeMockDb(tmpRoot, [
      {
        message: invalidPayloadWithSayingTrigger,
        role: 'user',
        response: invalidPayloadPrelude,
        omitDefaultThinking: true,
        invalidFuncCalls: [
          {
            provider: 'openai-compatible',
            callId: 'toolcall_68_1',
            detail: invalidPayloadWithSayingDetail,
            toolCallIndex: 1,
            rawArgumentsText: '{"path":"README.md"}',
          },
        ],
      },
      {
        message: invalidPayloadWithSayingTrigger,
        role: 'user',
        response: invalidPayloadWithSayingRecovery,
        contextContains: [invalidPayloadWithSayingDetail, invalidPayloadPrelude],
      },
    ]);

    const invalidPayloadWithSayingDlg = await createMainDialog('tester');
    invalidPayloadWithSayingDlg.disableDiligencePush = true;

    await driveDialogStream(
      invalidPayloadWithSayingDlg,
      makeUserPrompt(
        invalidPayloadWithSayingTrigger,
        'kernel-driver-invalid-provider-tool-call-payload-after-saying-feedback',
      ),
      true,
    );

    const preludeIndex = invalidPayloadWithSayingDlg.msgs.findIndex(
      (msg) => msg.type === 'saying_msg' && msg.content === invalidPayloadPrelude,
    );
    const guideIndex = invalidPayloadWithSayingDlg.msgs.findIndex(
      (msg) =>
        msg.type === 'transient_guide_msg' && msg.content.includes(invalidPayloadWithSayingDetail),
    );
    assert.ok(preludeIndex >= 0, 'expected assistant prelude before invalid payload guide');
    assert.ok(guideIndex >= 0, 'expected runtime guide for invalid payload after assistant text');
    assert.ok(
      preludeIndex < guideIndex,
      'runtime guide should remain after earlier assistant text in dialog memory',
    );
    const invalidPayloadWithSayingSayings = invalidPayloadWithSayingDlg.msgs.filter(
      (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    assert.equal(
      invalidPayloadWithSayingSayings[invalidPayloadWithSayingSayings.length - 1]?.content,
      invalidPayloadWithSayingRecovery,
      'invalid provider payload after assistant text should still recover in same drive',
    );

    await writeStandardMinds(tmpRoot, { memberTools: ['env_get'], streaming: false });
    const invalidBatchPayloadTrigger =
      'Provider emits a batch tool-call payload with arguments but no function name.';
    const invalidBatchPayloadRecovery =
      'I saw the invalid batch provider payload notice and continued without assuming the tool ran.';
    const invalidBatchPayloadDetail =
      'OPENAI-COMPATIBLE missing tool function name for callId=batch-missing-name';

    await writeMockDb(tmpRoot, [
      {
        message: invalidBatchPayloadTrigger,
        role: 'user',
        response: '',
        omitDefaultThinking: true,
        invalidFuncCalls: [
          {
            provider: 'openai-compatible',
            callId: 'batch-missing-name',
            detail: invalidBatchPayloadDetail,
            toolCallIndex: 0,
            rawArgumentsText: '{"path":"README.md"}',
          },
        ],
      },
      {
        message: invalidBatchPayloadTrigger,
        role: 'user',
        response: invalidBatchPayloadRecovery,
        contextContains: [invalidBatchPayloadDetail, 'rawArgumentsText'],
      },
    ]);

    const invalidBatchPayloadDlg = await createMainDialog('tester');
    invalidBatchPayloadDlg.disableDiligencePush = true;
    const invalidBatchPayloadCh = dialogEventRegistry.createSubChan(invalidBatchPayloadDlg.id);

    await driveDialogStream(
      invalidBatchPayloadDlg,
      makeUserPrompt(
        invalidBatchPayloadTrigger,
        'kernel-driver-invalid-batch-provider-tool-call-payload-feedback',
      ),
      true,
    );

    const invalidBatchPayloadEvents = await collectEvents(invalidBatchPayloadCh, 500);
    assert.ok(
      invalidBatchPayloadEvents.some(
        (event) => event.type === 'stream_error_evt' && event.error === invalidBatchPayloadDetail,
      ),
      'expected invalid batch provider tool-call payload to emit stream_error_evt',
    );
    const invalidBatchPayloadGuides = invalidBatchPayloadDlg.msgs.filter(
      (msg) =>
        msg.type === 'transient_guide_msg' && msg.content.includes(invalidBatchPayloadDetail),
    );
    assert.equal(
      invalidBatchPayloadGuides.length,
      1,
      'expected invalid batch provider tool-call payload to persist one runtime guide',
    );
    const invalidBatchPayloadSayings = invalidBatchPayloadDlg.msgs.filter(
      (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    assert.equal(
      invalidBatchPayloadSayings[invalidBatchPayloadSayings.length - 1]?.content,
      invalidBatchPayloadRecovery,
      'invalid batch provider payload should trigger same-drive recovery instead of stopping',
    );
    await writeStandardMinds(tmpRoot, { memberTools: ['env_get'] });

    const replyTrigger =
      'Call replyTellaskSessionless, but the first special-function arguments are malformed JSON.';
    const badReplyArguments = '{"replyContent":';
    const replyToolError = `Invalid arguments for tellask special function 'replyTellaskSessionless': arguments must be valid JSON: ${getJsonParseMessage(
      badReplyArguments,
    )}`;
    const replyRecovery =
      'The malformed replyTellaskSessionless call failed, so I am correcting course instead of treating the raw call text as final.';

    await writeMockDb(tmpRoot, [
      {
        message: replyTrigger,
        role: 'user',
        response: 'Function: replyTellaskSessionless\n{"replyContent":',
        funcCalls: [
          {
            id: 'malformed-replyTellaskSessionless',
            name: 'replyTellaskSessionless',
            arguments: badReplyArguments,
          },
        ],
      },
      {
        message: replyToolError,
        role: 'tool',
        response: replyRecovery,
        contextContains: [replyTrigger],
      },
    ]);

    const replyDlg = await createMainDialog('tester');
    replyDlg.disableDiligencePush = true;
    const ch = dialogEventRegistry.createSubChan(replyDlg.id);

    await driveDialogStream(
      replyDlg,
      makeUserPrompt(replyTrigger, 'kernel-driver-invalid-json-reply-special-feedback'),
      true,
    );

    const replyFuncResults = replyDlg.msgs.filter((msg) => msg.type === 'func_result_msg');
    assert.equal(replyFuncResults.length, 1, 'expected exactly one reply-special failure result');
    assert.equal(
      replyFuncResults[0]?.content,
      replyToolError,
      'malformed replyTellaskSessionless arguments should surface as a special-function failure result',
    );

    const replyAssistantSayings = replyDlg.msgs.filter(
      (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    assert.ok(
      replyAssistantSayings.length >= 2,
      'expected a recovery round after the reply-special failure',
    );
    assert.equal(
      replyAssistantSayings[replyAssistantSayings.length - 1]?.content,
      replyRecovery,
      'invalid replyTellaskSessionless must trigger correction instead of stopping after raw call text',
    );

    const streamError = (await collectEvents(ch, 500)).find(
      (event): event is Extract<TypedDialogEvent, { type: 'stream_error_evt' }> =>
        event.type === 'stream_error_evt' &&
        event.error.includes('replyTellaskSessionless') &&
        event.error.includes('callId=malformed-replyTellaskSessionless'),
    );
    assert.ok(
      streamError,
      'invalid replyTellaskSessionless should emit a correlated stream_error_evt',
    );

    const multiReplyError =
      '不允许一轮多次调用 replyTellask*，必须只用当前诉请要求的唯一 reply special 完成交付。 Do not call multiple replyTellask* functions in one round; deliver with exactly one reply special required by the current tellask.';
    const multiReplyRoot = await createMainDialog('tester');
    const multiReplySideDialog = await multiReplyRoot.createSideDialog(
      'pangu',
      ['@pangu'],
      'Finish the assigned work exactly once.',
      {
        callName: 'tellaskSessionless',
        originMemberId: 'tester',
        askerDialogId: multiReplyRoot.id.selfId,
        callId: 'root-multi-reply-call',
        callSiteCourse: 1,
        callSiteGenseq: 1,
        collectiveTargets: ['pangu'],
      },
    );
    await DialogPersistence.appendActiveCalleeDispatch(multiReplyRoot.id, {
      calleeDialogId: multiReplySideDialog.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      batchId: 'root-multi-reply-batch',
      callName: 'tellaskSessionless',
      mentionList: ['@pangu'],
      tellaskContent: 'Finish the assigned work exactly once.',
      targetAgentId: 'pangu',
      callId: 'root-multi-reply-call',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: 1,
      callType: 'C',
    });

    const multiReplyRound = await processTellaskFunctionRound({
      dlg: multiReplySideDialog,
      funcCalls: [
        {
          type: 'func_call_msg',
          role: 'assistant',
          genseq: 1,
          id: 'multi-reply-first',
          name: 'replyTellaskSessionless',
          arguments: JSON.stringify({ replyContent: 'first delivery attempt' }),
        },
        {
          type: 'func_call_msg',
          role: 'assistant',
          genseq: 1,
          id: 'multi-reply-second',
          name: 'replyTellaskSessionless',
          arguments: JSON.stringify({ replyContent: 'second delivery attempt' }),
        },
      ],
      allowedSpecials: new Set<TellaskCallFunctionName>(['replyTellaskSessionless']),
      callbacks: {
        scheduleDrive: () => {
          throw new Error('test invariant violation: invalid multi-reply must not schedule drive');
        },
        driveDialog: async () => {
          throw new Error('test invariant violation: invalid multi-reply must not drive dialog');
        },
      },
      activePromptReplyDirective: {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: multiReplyRoot.id.selfId,
        targetCallId: 'root-multi-reply-call',
        tellaskContent: 'Finish the assigned work exactly once.',
      },
    });

    assert.equal(
      multiReplyRound.hasInvalidTellaskCalls,
      true,
      'multi replyTellask* round should be classified as invalid',
    );
    assert.equal(
      multiReplyRound.shouldStopAfterReplyTool,
      false,
      'multi replyTellask* round must not stop as a successful reply delivery',
    );
    assert.deepEqual(
      multiReplyRound.tellaskResults.map((msg) => msg.content),
      [multiReplyError, multiReplyError],
      'every replyTellask* call in a multi-reply round should fail',
    );
    const stillPending = await DialogPersistence.loadActiveCalleeDispatches(
      multiReplyRoot.id,
      multiReplyRoot.status,
    );
    assert.equal(
      stillPending.length,
      1,
      'multi replyTellask* failure must not clear active callee dispatch',
    );
    const multiReplyRootEvents = await DialogPersistence.loadCourseEvents(
      multiReplyRoot.id,
      1,
      multiReplyRoot.status,
    );
    assert.equal(
      multiReplyRootEvents.some(
        (event) =>
          event.type === 'tellask_result_record' && event.callId === 'root-multi-reply-call',
      ),
      false,
      'multi replyTellask* failure must not deliver a tellask result to the requester',
    );

    const mixedReplyRound = await processTellaskFunctionRound({
      dlg: multiReplySideDialog,
      funcCalls: [
        {
          type: 'func_call_msg',
          role: 'assistant',
          genseq: 2,
          id: 'mixed-reply-sessionless',
          name: 'replyTellaskSessionless',
          arguments: JSON.stringify({ replyContent: 'sessionless delivery attempt' }),
        },
        {
          type: 'func_call_msg',
          role: 'assistant',
          genseq: 2,
          id: 'mixed-reply-back',
          name: 'replyTellaskBack',
          arguments: JSON.stringify({ replyContent: 'ask-back delivery attempt' }),
        },
      ],
      allowedSpecials: new Set<TellaskCallFunctionName>([
        'replyTellaskSessionless',
        'replyTellaskBack',
      ]),
      callbacks: {
        scheduleDrive: () => {
          throw new Error(
            'test invariant violation: invalid mixed multi-reply must not schedule drive',
          );
        },
        driveDialog: async () => {
          throw new Error(
            'test invariant violation: invalid mixed multi-reply must not drive dialog',
          );
        },
      },
      activePromptReplyDirective: {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: multiReplyRoot.id.selfId,
        targetCallId: 'root-multi-reply-call',
        tellaskContent: 'Finish the assigned work exactly once.',
      },
    });
    assert.deepEqual(
      mixedReplyRound.tellaskResults.map((msg) => msg.content),
      [multiReplyError, multiReplyError],
      'mixed replyTellask* names in one round should still all fail as one multi-reply violation',
    );
    assert.equal(
      mixedReplyRound.shouldStopAfterReplyTool,
      false,
      'mixed replyTellask* violation must not stop as a successful reply delivery',
    );
    assert.equal(
      (await DialogPersistence.loadActiveCalleeDispatches(multiReplyRoot.id, multiReplyRoot.status))
        .length,
      1,
      'mixed replyTellask* failure must not clear active callee dispatch',
    );
    assert.equal(
      (await DialogPersistence.loadCourseEvents(multiReplyRoot.id, 1, multiReplyRoot.status)).some(
        (event) =>
          event.type === 'tellask_result_record' && event.callId === 'root-multi-reply-call',
      ),
      false,
      'mixed replyTellask* failure must not deliver a tellask result to the requester',
    );
  });

  console.log('kernel-driver invalid-json-tool-call-feedback: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver invalid-json-tool-call-feedback: FAIL\n${message}`);
  process.exit(1);
});
