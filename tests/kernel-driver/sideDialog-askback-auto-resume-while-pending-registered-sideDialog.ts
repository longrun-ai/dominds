import assert from 'node:assert/strict';

import { SideDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { messageProvider } from '../helpers/message-provider';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector('dominds-askback-with-background-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'controlled-nested-askback';
    for (const language of ['en', 'zh'] as const) {
      setWorkLanguage(language);
      for (const streaming of [true, false]) {
        await writeStandardMinds(rtws, {
          providerApiType: apiType,
          streaming,
          extraMembers: ['worker', 'helper'],
        });
        const root = await createMainDialog();
        root.disableDiligencePush = true;
        const id = `${language}-${streaming ? 'stream' : 'batch'}`;
        const parentCall = `parent-work-${id}`;
        const initialNested = `nested-work-${id}`;
        const askBack = `ask-back-${id}`;
        const answer = `ask-back-answer-data-${id}`;
        let rootRequests = 0;
        let coordinatorRequests = 0;
        let nestedRequests = 0;
        const actualRequests: unknown[] = [];
        const provider = messageProvider(
          apiType,
          async ({ request, agent, context, systemPrompt, genseq, streaming: actualStreaming }) => {
            assert.equal(actualStreaming, streaming);
            const call = (id: string, name: string, args: Record<string, unknown>) => ({
              messages: [
                {
                  type: 'func_call_msg' as const,
                  role: 'assistant' as const,
                  genseq,
                  id,
                  name,
                  arguments: JSON.stringify(args),
                },
              ],
              usage: { kind: 'unavailable' as const },
            });
            if (request.dialogSelfId === root.id.selfId) {
              rootRequests += 1;
              assert.ok(rootRequests <= 2);
              if (rootRequests === 1)
                return call(parentCall, 'tellask', {
                  targetAgentId: 'worker',
                  sessionSlug: 'coordinator-task',
                  tellaskContent: `coordinator-task-data-${id}`,
                });
              const directive = await DialogPersistence.loadActiveTellaskReplyObligation(
                root.id,
                root.status,
              );
              assert.equal(directive?.expectedReplyCallName, 'replyTellaskBack');
              assert.equal(directive?.targetCallId, askBack);
              actualRequests.push({ stage: 'requester-answer', systemPrompt, context });
              return call(`answer-${id}`, 'replyTellaskBack', { replyContent: answer });
            }
            if (agent.id === 'helper') {
              nestedRequests += 1;
              assert.equal(nestedRequests, 1);
              return call(`question-${id}-${nestedRequests}`, 'askHuman', {
                tellaskContent: `nested-input-needed-data-${id}-${nestedRequests}`,
              });
            }
            assert.equal(agent.id, 'worker');
            coordinatorRequests += 1;
            assert.ok(coordinatorRequests <= 3);
            if (coordinatorRequests === 1)
              return call(initialNested, 'tellask', {
                targetAgentId: 'helper',
                sessionSlug: 'nested-task',
                tellaskContent: `initial-nested-task-data-${id}`,
              });
            if (coordinatorRequests === 2)
              return call(askBack, 'tellaskBack', { tellaskContent: `clarification-data-${id}` });
            const resultIndex = context.findIndex(
              (message) => message.type === 'tellask_result_msg' && message.callId === askBack,
            );
            const receiptIndex = context.findIndex(
              (message) => message.type === 'func_result_msg' && message.id === askBack,
            );
            assert.ok(receiptIndex >= 0 && resultIndex > receiptIndex);
            const result = context[resultIndex];
            assert.ok('content' in result && result.content.includes(answer));
            actualRequests.push({
              stage: 'coordinator-resume',
              receiptIndex,
              resultIndex,
              expectedForwardOffset: resultIndex - receiptIndex,
              systemPrompt,
              context,
            });
            return {
              messages: [
                {
                  type: 'saying_msg',
                  role: 'assistant',
                  genseq,
                  content: `resumed-work-data-${id}`,
                },
              ],
              usage: { kind: 'unavailable' },
            };
          },
        );
        registerLlmGenerator(provider);
        try {
          await driveDialogStream(root, makeUserPrompt(`start-data-${id}`, `start-${id}`), true);
          await waitFor(
            async () => {
              provider.assertNoErrors();
              const nested = root
                .getLoadedDialogTreeSnapshot()
                .find((dialog) => dialog.agentId === 'helper');
              return (
                !!nested &&
                (await DialogPersistence.loadQuestions4HumanState(nested.id, nested.status))
                  .length > 0
              );
            },
            4000,
            'registered nested work to reach a real human-wait boundary',
          );
          await waitForAllDialogsUnlocked(root, 4000);
          const coordinator = root
            .getLoadedDialogTreeSnapshot()
            .find((dialog) => dialog.agentId === 'worker');
          const nested = root
            .getLoadedDialogTreeSnapshot()
            .find((dialog) => dialog.agentId === 'helper');
          assert.ok(coordinator instanceof SideDialog && nested instanceof SideDialog);
          await driveDialogStream(
            coordinator,
            {
              content: `runtime-clarification-input-data-${id}`,
              msgId: `clarify-${id}`,
              grammar: 'markdown',
              origin: 'runtime',
              userLanguageCode: language,
            },
            true,
          );
          await waitFor(
            async () => {
              provider.assertNoErrors();
              return (
                (
                  await DialogPersistence.loadActiveCalleeDispatches(
                    coordinator.id,
                    coordinator.status,
                  )
                ).some((dispatch) => dispatch.callId === initialNested) &&
                coordinator.msgs.some(
                  (message) =>
                    message.type === 'saying_msg' && message.content === `resumed-work-data-${id}`,
                )
              );
            },
            4000,
            'ask-back reply to resume while the registered nested task remains pending',
          );
          await waitForAllDialogsUnlocked(root, 4000);
          provider.assertNoErrors();
          assert.equal(rootRequests, 2);
          assert.equal(coordinatorRequests, 3);
          assert.equal(nestedRequests, 1);
          const pending = await DialogPersistence.loadActiveCalleeDispatches(
            coordinator.id,
            coordinator.status,
          );
          assert.equal(pending.length, 1);
          assert.equal(pending[0].calleeDialogId, nested.id.selfId);
          assert.equal(pending[0].callId, initialNested);
          assert.equal(nested.assignmentFromAsker.callId, initialNested);
          const events = await DialogPersistence.loadCourseEvents(
            coordinator.id,
            1,
            coordinator.status,
          );
          assert.equal(events.filter((event) => event.type === 'gen_start_record').length, 3);
          const askBackResults = events
            .filter((event) => event.type === 'tellask_result_record')
            .filter((event) => event.callId === askBack);
          assert.equal(askBackResults.length, 1);
          assert.equal(askBackResults[0].status, 'completed');
          assert.ok(askBackResults[0].content.includes(answer));
          assert.equal(
            events.filter(
              (event) =>
                event.type === 'tellask_reply_resolution_record' &&
                event.targetCallId === parentCall,
            ).length,
            0,
          );
          assert.equal(
            (await DialogPersistence.loadCourseEvents(root.id, 1, root.status)).filter(
              (event) => event.type === 'tellask_result_record' && event.callId === parentCall,
            ).length,
            0,
          );
          assert.deepEqual(
            (await DialogPersistence.loadDialogLatest(coordinator.id, coordinator.status))
              ?.displayState,
            { kind: 'waiting_side_dialog' },
          );
          if (streaming)
            evidence.record({
              id,
              scenario:
                'A coordinator has registered nested work waiting on human input, asks its requester a clarification, receives that reply, and resumes without closing its parent assignment or consuming the nested task.',
              businessValue:
                'Resume a real ask-back while independent nested work remains pending, and keep the result pointer and reply-channel guidance accurate.',
              context: {
                language,
                rootRequests,
                coordinatorRequests,
                nestedRequests,
                parentReplyDelivered: false,
                stillPendingNestedCall: initialNested,
              },
              reviewQuestions: [
                'Are the actual requester and coordinator requests consistent about reply channels and which work remains pending?',
                'Does the resumed context receipt point forward to the correct ask-back result using the actual message indices?',
                'Can the coordinator use the requester answer without prematurely claiming the parent task is finished?',
              ],
              actualText: JSON.stringify(actualRequests, null, 2),
            });
        } finally {
          await waitForAllDialogsUnlocked(root, 4000);
          globalDialogRegistry.unregister(root.id.rootId);
          unregisterLlmGenerator(apiType);
        }
      }
    }
  });
  await evidence.write();
  console.log(
    'real ask-back resumes alongside pending registered work without premature parent delivery: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
