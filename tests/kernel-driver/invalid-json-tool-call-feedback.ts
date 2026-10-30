import assert from 'node:assert/strict';

import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { ChatMessage } from '../../main/llm/client';
import type { LlmBatchResult, LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import {
  processTellaskFunctionRound,
  type TellaskCallFunctionName,
} from '../../main/llm/kernel-driver/tellask-special';
import { DialogPersistence } from '../../main/persistence';
import { recordDialogEvents } from '../helpers/dialog-events';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

import {
  createMainDialog,
  makeUserPrompt,
  withTempRtws,
  writeStandardMinds,
  type MockEntry,
} from './helpers';

const evidence = semanticEvidenceCollector('dominds-invalid-tool-');
const apiType = 'controlled-invalid-tool';
let entries: MockEntry[] = [];
let phase = 0;
function configureResponses(configured: MockEntry[]): void {
  entries = configured;
  phase = 0;
}
function nextOutput(context: ChatMessage[], genseq: number): LlmBatchResult {
  const entry = entries[phase++];
  assert.ok(entry, 'the scenario must explicitly configure every generation');
  if (phase === 2) {
    const feedback = context.filter(
      (message) => message.type === 'func_result_msg' || message.type === 'transient_guide_msg',
    );
    assert.ok(feedback.length > 0, 'recovery must receive runtime feedback');
    evidence.record({
      id: `recovery-${entries[0].funcCalls?.[0]?.id ?? entries[0].invalidFuncCalls?.[0]?.callId ?? 'native-json'}`,
      scenario:
        'A malformed tool call is rejected and a second provider request receives the actual feedback.',
      businessValue:
        'Let the executor correct invalid arguments or provider payload without assuming an unexecuted tool succeeded.',
      context: {
        firstCall: JSON.stringify(entries[0].funcCalls ?? entries[0].invalidFuncCalls),
        providerMode: entries[0].message,
      },
      reviewQuestions: [
        'Does the actual feedback identify the problem and provide accurate recovery guidance without claiming execution or delivery?',
      ],
      actualText: JSON.stringify(feedback, null, 2),
    });
  }
  const messages: ChatMessage[] = [
    ...(entry.response === ''
      ? []
      : [
          {
            type: 'saying_msg' as const,
            role: 'assistant' as const,
            genseq,
            content: entry.response,
          },
        ]),
    ...(entry.funcCalls ?? []).map((call, index) => ({
      type: 'func_call_msg' as const,
      role: 'assistant' as const,
      genseq,
      id: call.id ?? `invalid-json-call-${index}`,
      name: call.name,
      arguments:
        typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
    })),
  ];
  return {
    messages,
    outputs: [
      ...messages.map((message) => ({ kind: 'message' as const, message })),
      ...(entry.invalidFuncCalls ?? []).map((call) => ({
        kind: 'invalid_func_call' as const,
        call,
      })),
    ],
    usage: { kind: 'unavailable' },
  };
}
const generator: LlmGenerator = {
  apiType,
  async genMoreMessages(_provider, _agent, _system, _tools, _request, context, genseq) {
    return nextOutput(context, genseq);
  },
  async genToReceiver(_provider, _agent, _system, _tools, _request, context, receiver, genseq) {
    const result = nextOutput(context, genseq);
    for (const output of result.outputs ?? []) {
      if (output.kind === 'invalid_func_call') await receiver.invalidFuncCall?.(output.call);
      else if (output.kind === 'message' && output.message.type === 'func_call_msg')
        await receiver.funcCall(output.message.id, output.message.name, output.message.arguments);
      else if (output.kind === 'message' && output.message.type === 'saying_msg') {
        await receiver.sayingStart();
        await receiver.sayingChunk(output.message.content);
        await receiver.sayingFinish();
      } else assert.fail('unexpected controlled provider output');
    }
    return { usage: result.usage };
  },
};

async function main(): Promise<void> {
  registerLlmGenerator(generator);
  try {
    await withTempRtws(async (tmpRoot) => {
      await writeStandardMinds(tmpRoot, { providerApiType: apiType, memberTools: ['env_get'] });

      const trigger = 'Call env_get, but the first tool call arguments are malformed JSON.';
      const badArguments = '{"key":';
      const toolError = 'native-error-input-placeholder';
      const recovery =
        'The malformed function call failed, so I corrected course and answered normally.';

      configureResponses([
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
      assert.equal(funcResults[0]?.id, funcCalls[0]?.id);

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

      configureResponses([
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
        },
      ]);

      const invalidPayloadDlg = await createMainDialog('tester');
      invalidPayloadDlg.disableDiligencePush = true;
      const invalidPayloadCh = recordDialogEvents(invalidPayloadDlg);

      await driveDialogStream(
        invalidPayloadDlg,
        makeUserPrompt(
          invalidPayloadTrigger,
          'kernel-driver-invalid-provider-tool-call-payload-feedback',
        ),
        true,
      );

      const invalidPayloadEvents = await invalidPayloadCh.finish();
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

      configureResponses([
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
          msg.type === 'transient_guide_msg' &&
          msg.content.includes(invalidPayloadWithSayingDetail),
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

      await writeStandardMinds(tmpRoot, {
        providerApiType: apiType,
        memberTools: ['env_get'],
        streaming: false,
      });
      const invalidBatchPayloadTrigger =
        'Provider emits a batch tool-call payload with arguments but no function name.';
      const invalidBatchPayloadRecovery =
        'I saw the invalid batch provider payload notice and continued without assuming the tool ran.';
      const invalidBatchPayloadDetail =
        'OPENAI-COMPATIBLE missing tool function name for callId=batch-missing-name';

      configureResponses([
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
        },
      ]);

      const invalidBatchPayloadDlg = await createMainDialog('tester');
      invalidBatchPayloadDlg.disableDiligencePush = true;
      const invalidBatchPayloadCh = recordDialogEvents(invalidBatchPayloadDlg);

      await driveDialogStream(
        invalidBatchPayloadDlg,
        makeUserPrompt(
          invalidBatchPayloadTrigger,
          'kernel-driver-invalid-batch-provider-tool-call-payload-feedback',
        ),
        true,
      );

      const invalidBatchPayloadEvents = await invalidBatchPayloadCh.finish();
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
      await writeStandardMinds(tmpRoot, { providerApiType: apiType, memberTools: ['env_get'] });

      const replyTrigger =
        'Call replyTellaskSessionless, but the first special-function arguments are malformed JSON.';
      const badReplyArguments = '{"replyContent":';
      const replyToolError = 'unused-special-routing-data';
      const replyRecovery =
        'The malformed replyTellaskSessionless call failed, so I am correcting course instead of treating the raw call text as final.';

      configureResponses([
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
        },
      ]);

      const replyDlg = await createMainDialog('tester');
      replyDlg.disableDiligencePush = true;
      const ch = recordDialogEvents(replyDlg);

      await driveDialogStream(
        replyDlg,
        makeUserPrompt(replyTrigger, 'kernel-driver-invalid-json-reply-delivery-feedback'),
        true,
      );

      const replyFuncResults = replyDlg.msgs.filter((msg) => msg.type === 'func_result_msg');
      assert.equal(
        replyFuncResults.length,
        1,
        'expected exactly one reply delivery failure result',
      );
      assert.equal(replyFuncResults[0]?.id, 'malformed-replyTellaskSessionless');

      const replyAssistantSayings = replyDlg.msgs.filter(
        (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
      );
      assert.ok(
        replyAssistantSayings.length >= 2,
        'expected a recovery round after the reply delivery failure',
      );
      assert.equal(
        replyAssistantSayings[replyAssistantSayings.length - 1]?.content,
        replyRecovery,
        'invalid replyTellaskSessionless must trigger correction instead of stopping after raw call text',
      );

      const streamError = (await ch.finish()).find(
        (event): event is Extract<TypedDialogEvent, { type: 'stream_error_evt' }> =>
          event.type === 'stream_error_evt' &&
          event.error.includes('replyTellaskSessionless') &&
          event.error.includes('callId=malformed-replyTellaskSessionless'),
      );
      assert.ok(
        streamError,
        'invalid replyTellaskSessionless should emit a correlated stream_error_evt',
      );

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
          callSiteCourse: toCallSiteCourseNo(1),
          callSiteGenseq: toCallSiteGenseqNo(1),
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
        callSiteGenseq: toCallSiteGenseqNo(1),
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
            throw new Error(
              'test invariant violation: invalid multi-reply must not schedule drive',
            );
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
        multiReplyRound.tellaskResults.map((msg) => msg.id),
        ['multi-reply-first', 'multi-reply-second'],
      );
      evidence.record({
        id: 'multi-reply',
        scenario: 'Two replyTellaskSessionless calls occur in one round.',
        businessValue:
          'Reject ambiguous duplicate final delivery while preserving the pending task.',
        context: { pendingCaller: multiReplyRoot.id.selfId, targetCallId: 'root-multi-reply-call' },
        reviewQuestions: [
          'Does each actual result explain how to correct the invalid round without implying that either reply was delivered?',
        ],
        actualText: JSON.stringify(multiReplyRound.tellaskResults, null, 2),
      });
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
      assert.equal(
        (
          await DialogPersistence.loadDialogLatest(
            multiReplySideDialog.id,
            multiReplySideDialog.status,
          )
        )?.replyDelivery,
        undefined,
        'multi replyTellask* failure must not leave a pending reply delivery on the side dialog',
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
      assert.equal(mixedReplyRound.hasInvalidTellaskCalls, true);
      assert.deepEqual(
        mixedReplyRound.tellaskResults.map((msg) => msg.id),
        ['mixed-reply-sessionless', 'mixed-reply-back'],
      );
      evidence.record({
        id: 'mixed-reply',
        scenario: 'Different replyTellask tool names occur together in one round.',
        businessValue:
          'Reject ambiguous cross-route delivery while preserving the original obligation.',
        context: { expectedTool: 'replyTellaskSessionless', targetCallId: 'root-multi-reply-call' },
        reviewQuestions: [
          'Do both actual results explain the invalid combination and an accurate single-reply recovery?',
        ],
        actualText: JSON.stringify(mixedReplyRound.tellaskResults, null, 2),
      });
      assert.equal(
        mixedReplyRound.shouldStopAfterReplyTool,
        false,
        'mixed replyTellask* violation must not stop as a successful reply delivery',
      );
      assert.equal(
        (
          await DialogPersistence.loadActiveCalleeDispatches(
            multiReplyRoot.id,
            multiReplyRoot.status,
          )
        ).length,
        1,
        'mixed replyTellask* failure must not clear active callee dispatch',
      );
      assert.equal(
        (
          await DialogPersistence.loadCourseEvents(multiReplyRoot.id, 1, multiReplyRoot.status)
        ).some(
          (event) =>
            event.type === 'tellask_result_record' && event.callId === 'root-multi-reply-call',
        ),
        false,
        'mixed replyTellask* failure must not deliver a tellask result to the requester',
      );
      assert.equal(
        (
          await DialogPersistence.loadDialogLatest(
            multiReplySideDialog.id,
            multiReplySideDialog.status,
          )
        )?.replyDelivery,
        undefined,
        'mixed replyTellask* failure must not leave a pending reply delivery on the side dialog',
      );
    });
  } finally {
    unregisterLlmGenerator(apiType);
  }
  await evidence.write();
  console.log('kernel-driver invalid-json-tool-call-feedback: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver invalid-json-tool-call-feedback: FAIL\n${message}`);
  process.exit(1);
});
