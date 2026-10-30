import assert from 'node:assert/strict';
import type WebSocket from 'ws';

import type { ChatMessage } from '../../main/llm/client';
import type { LlmBatchResult, LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence, DiskFileDialogStore } from '../../main/persistence';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { createMainDialog, makeUserPrompt, withTempRtws, writeStandardMinds } from './helpers';

const evidence = semanticEvidenceCollector('dominds-multi-human-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'controlled-multi-human';
    const valid = (id: string) => ({
      id,
      name: 'askHuman',
      arguments: JSON.stringify({ tellaskContent: `question-payload-${id}` }),
    });
    const scenarios = [
      { id: 'two-valid', calls: [valid('human-first'), valid('human-second')] },
      {
        id: 'mixed-validity',
        calls: [
          { id: 'human-invalid-first', name: 'askHuman', arguments: '{"tellaskContent":' },
          valid('human-valid-second'),
        ],
      },
      {
        id: 'interleaved',
        calls: [
          valid('human-order-first'),
          {
            id: 'tellask-order-middle',
            name: 'tellaskSessionless',
            arguments: '{"targetAgentId":',
          },
          valid('human-order-last'),
        ],
      },
    ];
    for (const streaming of [true, false]) {
      await writeStandardMinds(rtws, { providerApiType: apiType, streaming });
      for (const scenario of scenarios) {
        const root = await createMainDialog();
        root.disableDiligencePush = true;
        let rounds = 0;
        const output = (context: ChatMessage[], genseq: number): LlmBatchResult => {
          rounds += 1;
          assert.ok(rounds <= 2);
          if (rounds === 2) {
            const feedback = context.filter((message) => message.type === 'func_result_msg');
            assert.deepEqual(
              feedback.map((message) => message.id),
              scenario.calls.map((call) => call.id),
            );
            evidence.record({
              id: `${scenario.id}-${streaming ? 'stream' : 'batch'}`,
              scenario:
                'A generation emits multiple askHuman calls, possibly mixed with malformed arguments or another special call.',
              businessValue:
                'Reject the whole ambiguous human-question round without losing call order or creating a partial human request.',
              context: { calls: JSON.stringify(scenario.calls), streaming, registeredQuestions: 0 },
              reviewQuestions: [
                'Does every actual failure explain the appropriate recovery without implying that a human question was registered or an unexecuted special call succeeded?',
              ],
              actualText: JSON.stringify(feedback, null, 2),
            });
          }
          return {
            messages:
              rounds === 1
                ? scenario.calls.map((call) => ({
                    type: 'func_call_msg' as const,
                    role: 'assistant' as const,
                    genseq,
                    ...call,
                  }))
                : [
                    {
                      type: 'saying_msg',
                      role: 'assistant',
                      genseq,
                      content: 'recovery-output-data-a1f4',
                    },
                  ],
            usage: { kind: 'unavailable' },
          };
        };
        const generator: LlmGenerator = {
          apiType,
          async genMoreMessages(_provider, _agent, _system, _tools, request, context, genseq) {
            assert.equal(request.dialogSelfId, root.id.selfId);
            return output(context, genseq);
          },
          async genToReceiver(
            _provider,
            _agent,
            _system,
            _tools,
            request,
            context,
            receiver,
            genseq,
          ) {
            assert.equal(request.dialogSelfId, root.id.selfId);
            const result = output(context, genseq);
            for (const message of result.messages) {
              if (message.type === 'func_call_msg')
                await receiver.funcCall(message.id, message.name, message.arguments);
              else if (message.type === 'saying_msg') {
                await receiver.sayingStart();
                await receiver.sayingChunk(message.content);
                await receiver.sayingFinish();
              } else assert.fail('unexpected controlled provider output');
            }
            return { usage: result.usage };
          },
        };
        registerLlmGenerator(generator);
        try {
          await driveDialogStream(
            root,
            makeUserPrompt('multi-human-input-data', `${scenario.id}-${streaming}`),
            true,
          );
          assert.equal(rounds, 2, 'rejection must reach an explicit recovery generation');
          assert.deepEqual(
            await DialogPersistence.loadQuestions4HumanState(root.id, root.status),
            [],
          );
          assert.deepEqual(
            await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status),
            [],
          );
          const events = await DialogPersistence.loadCourseEvents(
            root.id,
            root.currentCourse,
            root.status,
          );
          assert.deepEqual(
            events
              .filter((event) => event.type === 'tellask_call_record')
              .map((event) => ({ id: event.id, name: event.name, raw: event.rawArgumentsText })),
            scenario.calls.map((call) => ({ id: call.id, name: call.name, raw: call.arguments })),
          );
          assert.deepEqual(
            events.filter((event) => event.type === 'func_result_record').map((event) => event.id),
            scenario.calls.map((call) => call.id),
          );
          const replayed: unknown[] = [];
          // This boundary needs only the WebSocket open-state/send contract; real persistence produces the packets.
          const socket = {
            readyState: 1,
            send(payload: string) {
              replayed.push(JSON.parse(payload));
            },
          } as unknown as WebSocket;
          await new DiskFileDialogStore(root.id).sendDialogEventsDirectly(
            socket,
            root,
            root.currentCourse,
            root.currentCourse,
            root.status,
          );
          const replayedCalls = replayed.filter(
            (
              packet,
            ): packet is { type: string; funcId: string; funcName: string; arguments: string } =>
              typeof packet === 'object' &&
              packet !== null &&
              'type' in packet &&
              packet.type === 'func_call_requested_evt',
          );
          assert.deepEqual(
            replayedCalls.map((packet) => ({
              id: packet.funcId,
              name: packet.funcName,
              raw: packet.arguments,
            })),
            scenario.calls.map((call) => ({ id: call.id, name: call.name, raw: call.arguments })),
          );
          assert.equal(
            replayed.filter(
              (packet) =>
                typeof packet === 'object' &&
                packet !== null &&
                'type' in packet &&
                packet.type === 'tellask_call_start_evt',
            ).length,
            0,
          );
        } finally {
          unregisterLlmGenerator(apiType);
        }
      }
    }
  });
  await evidence.write();
  console.log(
    'multi-askHuman rejection, recovery and replay preserve every call without creating human requests: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
