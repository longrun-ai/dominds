import assert from 'node:assert/strict';

import { SideDialog } from '../../main/dialog';
import type { FuncCallMsg } from '../../main/llm/client';
import type { LlmGenerator, LlmRequestContext } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { processTellaskFunctionRound } from '../../main/llm/kernel-driver/tellask-special';
import { DialogPersistence } from '../../main/persistence';
import {
  createMainDialog,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'controlled-sibling-batch';
    for (const streaming of [true, false]) {
      await writeStandardMinds(rtws, {
        providerApiType: apiType,
        streaming,
        includePangu: true,
        extraMembers: ['nuwa'],
      });
      const root = await createMainDialog();
      await root.notifyGeneratingStart(`sibling-batch-${streaming}`);
      const genseq = root.activeGenSeq;
      const calls: FuncCallMsg[] = ['pangu', 'nuwa'].map((target) => ({
        type: 'func_call_msg',
        role: 'assistant',
        genseq,
        id: `dispatch-${target}-${streaming}`,
        name: 'tellaskSessionless',
        arguments: JSON.stringify({
          targetAgentId: target,
          tellaskContent: `task-payload-${target}`,
        }),
      }));
      const scheduled: string[] = [];
      const generated: string[] = [];
      const childDrives: Array<ReturnType<typeof driveDialogStream>> = [];
      const prepare = async (request: LlmRequestContext, seq: number): Promise<FuncCallMsg> => {
        const side = root.lookupDialog(request.dialogSelfId);
        assert.ok(side instanceof SideDialog);
        generated.push(side.id.selfId);
        assert.equal(generated.filter((id) => id === side.id.selfId).length, 1);
        const pending = await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status);
        assert.deepEqual(
          pending.map((record) => record.callId),
          calls.map((call) => call.id),
          'each actual child provider request sees the complete same-round dispatch batch',
        );
        assert.ok(
          pending.every(
            (record) =>
              record.callSiteCourse === root.currentCourse && record.callSiteGenseq === genseq,
          ),
        );
        return {
          type: 'func_call_msg',
          role: 'assistant',
          genseq: seq,
          id: `human-${side.agentId}`,
          name: 'askHuman',
          arguments: JSON.stringify({ tellaskContent: `question-payload-${side.agentId}` }),
        };
      };
      const generator: LlmGenerator = {
        apiType,
        classifyFailure(error) {
          return {
            kind: 'fatal',
            code: 'test_provider_failure',
            message: error instanceof Error ? error.message : String(error),
          };
        },
        async genMoreMessages(_provider, _agent, _system, _tools, request, _context, seq) {
          assert.equal(streaming, false);
          return { messages: [await prepare(request, seq)], usage: { kind: 'unavailable' } };
        },
        async genToReceiver(_provider, _agent, _system, _tools, request, _context, receiver, seq) {
          assert.equal(streaming, true);
          const call = await prepare(request, seq);
          await receiver.funcCall(call.id, call.name, call.arguments);
          return { usage: { kind: 'unavailable' } };
        },
      };
      registerLlmGenerator(generator);
      try {
        const result = await processTellaskFunctionRound({
          dlg: root,
          funcCalls: calls,
          allowedSpecials: new Set(['tellaskSessionless']),
          callbacks: {
            scheduleDrive(dialog, options) {
              scheduled.push(dialog.id.selfId);
              childDrives.push(
                options.humanPrompt
                  ? driveDialogStream(
                      dialog,
                      options.humanPrompt,
                      options.waitInQue,
                      options.driveOptions,
                    )
                  : driveDialogStream(dialog, undefined, options.waitInQue, options.driveOptions),
              );
            },
            async driveDialog() {
              assert.fail('sessionless calls schedule their independent children');
            },
          },
        });
        await Promise.all(childDrives);
        await waitForAllDialogsUnlocked(root, 3000);
        assert.deepEqual(
          result.handledCallIds,
          calls.map((call) => call.id),
        );
        assert.equal(scheduled.length, 2);
        assert.equal(new Set(scheduled).size, 2);
        assert.equal(generated.length, 2);
        const pending = await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status);
        assert.equal(pending.length, 2);
        assert.ok(pending.every((record) => scheduled.includes(record.calleeDialogId)));
        for (const id of scheduled) {
          const side = root.lookupDialog(id);
          assert.ok(side instanceof SideDialog);
          const questions = await DialogPersistence.loadQuestions4HumanState(side.id, side.status);
          assert.equal(questions.length, 1);
          assert.equal(questions[0].tellaskContent, `question-payload-${side.agentId}`);
        }
        await root.notifyGeneratingFinish();
      } finally {
        await Promise.all(childDrives);
        unregisterLlmGenerator(apiType);
      }
    }
  });
  console.log('all sibling dispatches are durable before real child drives begin: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
