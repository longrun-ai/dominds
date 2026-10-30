import assert from 'node:assert/strict';

import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import type { Dialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import type { ChatMessage } from '../../main/llm/client';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import { resolvePromptReplyGuidance } from '../../main/llm/kernel-driver/reply-guidance';
import {
  createKernelDriverRuntimeState,
  type KernelDriverDriveCallOptions,
} from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  makeDriveOptions,
  makeUserPrompt,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector('dominds-mainline-reply-compat-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'test-mainline-reply-compat';
    await writeStandardMinds(rtws, {
      includePangu: true,
      providerApiType: apiType,
      diligencePushMax: 1,
    });
    for (const variant of ['current', 'legacy-en', 'legacy-zh'] as const) {
      const language = variant === 'legacy-zh' ? 'zh' : 'en';
      setWorkLanguage(language);
      const root = await createMainDialog();
      root.disableDiligencePush = false;
      root.diligencePushRemainingBudget = 1;
      let drivenRoot = root;
      const requester = await root.createSideDialog('pangu', ['@pangu'], 'worker-task-data-849a', {
        callName: 'tellaskSessionless',
        originMemberId: root.agentId,
        askerDialogId: root.id.selfId,
        callId: `worker-task-${variant}`,
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        collectiveTargets: ['pangu'],
      });
      const callId = `askback-${variant}`;
      const requestPayload = 'askback-request-data-95ab';
      const answerPayload = 'ready-answer-data-a6bc';
      const directive = {
        expectedReplyCallName: 'replyTellaskBack' as const,
        targetDialogId: requester.id.selfId,
        targetCallId: callId,
        tellaskContent: requestPayload,
      };
      await requester.persistTellaskCall(
        callId,
        'tellaskBack',
        JSON.stringify({ tellaskContent: requestPayload }),
        1,
      );
      await DialogPersistence.setActiveTellaskReplyObligation(root.id, directive, root.status);
      let rounds = 0;
      const contexts: ChatMessage[][] = [];
      const generator: LlmGenerator = {
        apiType,
        async genToReceiver(_provider, _agent, _system, _tools, request, context, receiver) {
          assert.equal(request.dialogSelfId, root.id.selfId);
          rounds += 1;
          contexts.push(structuredClone(context));
          assert.ok(rounds <= (variant === 'current' ? 2 : 1));
          await receiver.sayingStart();
          await receiver.sayingChunk(answerPayload);
          await receiver.sayingFinish();
          return {
            usage: { kind: 'available', promptTokens: 100, completionTokens: 10, totalTokens: 110 },
            llmGenModel: 'default',
          };
        },
        async genMoreMessages() {
          throw new Error('streaming fixture only');
        },
      };
      registerLlmGenerator(generator);
      const scheduled: KernelDriverDriveCallOptions[] = [];
      const callbacks = {
        scheduleDrive: (_dialog: Dialog, options: KernelDriverDriveCallOptions) => {
          scheduled.push(options);
        },
        driveDialog: async () => {},
      };
      try {
        let pendingId: string;
        if (variant === 'current') {
          await executeDriveRound({
            runtime: createKernelDriverRuntimeState(),
            driveArgs: [
              root,
              {
                content: 'runtime-answer-input-data',
                msgId: 'mainline-first-input',
                grammar: 'markdown',
                origin: 'runtime',
                tellaskReplyDirective: directive,
              },
              true,
              makeDriveOptions(),
            ],
            ...callbacks,
          });
          assert.equal(rounds, 1);
          assert.equal(scheduled.length, 1);
          assert.equal(scheduled[0].driveOptions?.businessContinuation?.kind, 'inter_dialog_reply');
          const queued = root.peekQueuedPrompt();
          assert.ok(queued?.kind === 'new_course_runtime_reply');
          assert.deepEqual(queued.tellaskReplyDirective, directive);
          pendingId = queued.msgId;
          assert.equal(
            (
              await DialogPersistence.loadCourseEvents(
                requester.id,
                requester.currentCourse,
                requester.status,
              )
            ).filter((event) => event.type === 'tellask_result_record' && event.callId === callId)
              .length,
            0,
          );
        } else {
          // These are stored queue tags from before the guidance change, not a meaning oracle.
          const legacyTag =
            language === 'zh'
              ? '[Dominds 现在发送诉请回复]'
              : '[Dominds send the Tellask reply now]';
          const legacyBody = `${legacyTag}\n\nlegacy-runtime-instruction-data-07cd`;
          const userSource = await resolvePromptReplyGuidance({
            dlg: root,
            prompt: makeUserPrompt(legacyBody, `user-same-bytes-${variant}`),
            language,
          });
          assert.equal(
            userSource.promptContent,
            legacyBody,
            'real user payload survives byte-for-byte even when it carries an old runtime tag',
          );
          assert.deepEqual(
            await DialogPersistence.loadActiveTellaskReplyObligation(root.id, root.status),
            directive,
          );
          pendingId = `stored-reminder-${variant}`;
          await root.queueRuntimeReplyPrompt({
            prompt: legacyBody,
            msgId: pendingId,
            grammar: 'markdown',
            userLanguageCode: language,
            tellaskReplyDirective: directive,
          });
          const persisted = await DialogPersistence.loadDialogLatest(root.id, root.status);
          assert.equal(persisted?.pendingRuntimePrompt?.content, legacyBody);
          await DialogPersistence.mutateDialogLatest(root.id, () => ({
            kind: 'patch',
            patch: { disableDiligencePush: false, diligencePushRemainingBudget: 1 },
          }));
          globalDialogRegistry.unregister(root.id.rootId);
          const restored = await getOrRestoreMainDialog(root.id.rootId, root.status);
          assert.ok(restored);
          assert.notEqual(restored, root);
          drivenRoot = restored;
          assert.equal(drivenRoot.peekQueuedPrompt()?.msgId, pendingId);
        }
        await executeDriveRound({
          runtime: createKernelDriverRuntimeState(),
          driveArgs: [
            drivenRoot,
            undefined,
            true,
            scheduled[0]?.driveOptions ??
              makeDriveOptions({ source: 'kernel_driver_follow_up', reason: 'follow_up_prompt' }),
          ],
          ...callbacks,
        });
        assert.equal(
          rounds,
          variant === 'current' ? 2 : 1,
          'old stored queues do not introduce an extra reminder generation',
        );
        assert.equal(drivenRoot.hasQueuedPrompt(), false);
        assert.equal(
          scheduled.filter(
            (options) => options.driveOptions?.businessContinuation?.kind === 'inter_dialog_reply',
          ).length,
          variant === 'current' ? 1 : 0,
        );
        assert.equal(drivenRoot.diligencePushRemainingBudget, 1);
        const delivered = (
          await DialogPersistence.loadCourseEvents(
            requester.id,
            requester.currentCourse,
            requester.status,
          )
        )
          .filter((event) => event.type === 'tellask_result_record')
          .filter((event) => event.callId === callId);
        assert.equal(delivered.length, 1);
        assert.equal(delivered[0].status, 'completed');
        assert.ok(delivered[0].content.includes(answerPayload));
        assert.equal(
          await DialogPersistence.loadActiveTellaskReplyObligation(root.id, root.status),
          undefined,
        );
        const events = await DialogPersistence.loadCourseEvents(
          root.id,
          root.currentCourse,
          root.status,
        );
        const humanRecords = events.filter((event) => event.type === 'human_text_record');
        assert.equal(humanRecords.filter((event) => event.origin === 'diligence_push').length, 0);
        assert.equal(humanRecords.filter((event) => event.msgId === pendingId).length, 1);
        const actualPrompt = contexts
          .at(-1)
          ?.find((message) => message.type === 'prompting_msg' && message.msgId === pendingId);
        assert.ok(actualPrompt && 'content' in actualPrompt);
        if (variant !== 'current')
          evidence.record({
            id: `legacy-queued-reply-${language}`,
            scenario:
              'A durable runtime reply queue from an older version carries the old reminder tag and an active cross-dialog ask-back obligation. The current driver renders its guidance and delivers a controlled ready answer once without another reminder round.',
            businessValue:
              'An upgrade must preserve queued collaboration while replacing outdated readiness assumptions in runtime guidance.',
            context: {
              language,
              callId,
              expectedReplyTool: 'replyTellaskBack',
              actualRequesterAgent: requester.agentId,
              readyAnswerPayload: answerPayload,
            },
            reviewQuestions: [
              'Does the actual normalized guidance state the pending delivery path without falsely claiming every prior thought was a ready final answer?',
              'Does it allow necessary task work and require the exact reply tool only when the result is ready?',
            ],
            actualText: actualPrompt.content,
          });
      } finally {
        unregisterLlmGenerator(apiType);
      }
    }
  });
  await evidence.write();
  console.log(
    'current and legacy queued ask-back reminders deliver once without spending diligence budget: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
