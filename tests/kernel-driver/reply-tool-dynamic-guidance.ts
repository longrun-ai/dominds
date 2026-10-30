import assert from 'node:assert/strict';

import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import type { TellaskReplyDirective } from '@longrun-ai/kernel/types/storage';
import {
  toAssignmentCourseNumber,
  toAssignmentGenerationSeqNumber,
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
} from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { SideDialog } from '../../main/dialog';
import type { ChatMessage } from '../../main/llm/client';
import type { LlmGenerator } from '../../main/llm/gen';
import { getLlmGenerator, registerLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import { resolvePromptReplyGuidance } from '../../main/llm/kernel-driver/reply-guidance';
import { supplySideDialogResponseToAssignedAskerIfPendingV2 } from '../../main/llm/kernel-driver/sideDialog';
import { executeTellaskCalls } from '../../main/llm/kernel-driver/tellask-special';
import { createKernelDriverRuntimeState } from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import { formatAssignmentFromAskerDialog } from '../../main/runtime/inter-dialog-format';
import { getWorkLanguage, setWorkLanguage } from '../../main/runtime/work-language';
import { recordDialogEvents } from '../helpers/dialog-events';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  makeDriveOptions,
  makeUserPrompt,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

const evidence = semanticEvidenceCollector('dominds-reply-errors-');
const liveReplyPayload = 'reply-data-live-804a';
function recordGuidance(
  id: string,
  actualText: string,
  scenario: string,
  context: Record<string, string | number>,
) {
  evidence.record({
    id,
    scenario,
    businessValue:
      'Deliver the correct requester reply without confusing human answers, stale requests or another dialog obligation.',
    context: { language: 'en', ...context },
    reviewQuestions: [
      'Does the full guidance describe the actual current reply obligation and the exact tool appropriate for this state?',
      'Can the executor recover without resending an already delivered result or mistaking answerHuman output for requester delivery?',
    ],
    actualText,
  });
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { includePangu: true });

    const root = await createMainDialog('tester');
    root.disableDiligencePush = true;
    await DialogPersistence.mutateDialogLatest(root.id, () => ({
      kind: 'patch',
      patch: { disableDiligencePush: true },
    }));
    async function seedRenderedAssignment(side: SideDialog): Promise<void> {
      const assignment = side.assignmentFromAsker;
      await root.persistTellaskCall(
        assignment.callId,
        'tellask',
        JSON.stringify({
          targetAgentId: side.agentId,
          sessionSlug: side.sessionSlug,
          tellaskContent: assignment.tellaskContent,
        }),
        1,
      );
      await DialogPersistence.mutateDialogLatest(side.id, () => ({
        kind: 'patch',
        patch: {
          latestAssignmentAnchor: {
            callId: assignment.callId,
            assignmentCourse: toAssignmentCourseNumber(side.currentCourse),
            assignmentGenseq: toAssignmentGenerationSeqNumber(0),
          },
        },
      }));
    }

    const tellaskContent = 'Please review the current implementation.';
    const callId = 'pending-tellask-call';
    const sessionSlug = 'reply-guidance';
    const sideDialog = await root.createSideDialog('pangu', ['@pangu'], tellaskContent, {
      callName: 'tellask',
      originMemberId: 'tester',
      askerDialogId: root.id.selfId,
      callId,
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      sessionSlug,
      collectiveTargets: ['pangu'],
    });

    const directive: TellaskReplyDirective = {
      expectedReplyCallName: 'replyTellask',
      targetDialogId: root.id.selfId,
      targetCallId: callId,
      tellaskContent,
    };
    await sideDialog.persistUserMessage(
      formatAssignmentFromAskerDialog({
        callName: 'tellask',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: ['@pangu'],
        tellaskContent,
        language: getWorkLanguage(),
        sessionSlug,
        collectiveTargets: ['pangu'],
      }),
      'assignment-msg',
      'markdown',
      'runtime',
      'en',
      undefined,
      directive,
    );

    const wrongReply = await executeTellaskCalls({
      dlg: sideDialog,
      calls: [
        {
          callId: 'wrong-reply-call',
          callName: 'replyTellaskBack',
          replyContent: 'Done.',
        },
      ],
      callbacks: {
        scheduleDrive: () => {},
        driveDialog: async () => {},
      },
    });
    assert.deepEqual(
      wrongReply.successfulReplyCallIds,
      [],
      'wrong reply tool must not count as delivered',
    );
    assert.deepEqual(
      wrongReply.failedReplyCallIds,
      ['wrong-reply-call'],
      'wrong reply tool must be tracked as a failed reply delivery',
    );
    assert.equal(wrongReply.toolOutputs.length, 1, 'expected one tool result for wrong reply tool');
    assert.equal(wrongReply.toolOutputs[0]?.type, 'func_result_msg');
    const wrongReplyToolOutput = wrongReply.toolOutputs[0];
    assert.ok(wrongReplyToolOutput, 'expected wrong reply tool output');
    recordGuidance(
      'wrong-tool',
      wrongReplyToolOutput.content,
      'The active side-dialog obligation requires replyTellask, but the executor called replyTellaskBack.',
      { expectedTool: 'replyTellask', rejectedTool: 'replyTellaskBack', targetCallId: callId },
    );

    assert.deepEqual(
      await DialogPersistence.loadActiveTellaskReplyObligation(sideDialog.id, sideDialog.status),
      directive,
    );
    assert.equal(
      (await DialogPersistence.loadCourseEvents(root.id, root.currentCourse, root.status)).some(
        (event) => event.type === 'tellask_result_record' && event.callId === callId,
      ),
      false,
    );

    await sideDialog.appendTellaskReplyResolution({
      callId: 'resolved-reply-call',
      replyCallName: 'replyTellask',
      targetCallId: callId,
    });

    const staleReply = await executeTellaskCalls({
      dlg: sideDialog,
      calls: [
        {
          callId: 'stale-reply-call',
          callName: 'replyTellask',
          replyContent: 'Done again.',
        },
      ],
      callbacks: {
        scheduleDrive: () => {},
        driveDialog: async () => {},
      },
    });
    assert.deepEqual(
      staleReply.successfulReplyCallIds,
      [],
      'resolved reply obligation must not accept another reply delivery',
    );
    assert.deepEqual(
      staleReply.failedReplyCallIds,
      ['stale-reply-call'],
      'resolved reply obligation must track the stale reply as a failed delivery',
    );
    assert.equal(staleReply.toolOutputs.length, 1, 'expected one tool result for stale reply call');
    assert.equal(staleReply.toolOutputs[0]?.type, 'func_result_msg');
    const staleReplyToolOutput = staleReply.toolOutputs[0];
    assert.ok(staleReplyToolOutput, 'expected stale reply tool output');
    recordGuidance(
      'stale-reply',
      staleReplyToolOutput.content,
      'This side-dialog reply obligation has already been resolved, so another reply must not deliver again.',
      { targetCallId: callId },
    );

    const deliveredAskBackCallId = 'already-delivered-askback-call';
    await sideDialog.persistTellaskCall(
      deliveredAskBackCallId,
      'tellaskBack',
      JSON.stringify({ tellaskContent: 'Need one ask-back answer.' }),
      1,
    );
    const askBackDirective: TellaskReplyDirective = {
      expectedReplyCallName: 'replyTellaskBack',
      targetDialogId: sideDialog.id.selfId,
      targetCallId: deliveredAskBackCallId,
      tellaskContent: 'Need one ask-back answer.',
    };
    const askBackPrompt = {
      content: 'Please call the reply tool now. runtime-data-askback-19bf',
      msgId: 'queued-askback-reminder',
      grammar: 'markdown' as const,
      origin: 'runtime' as const,
      userLanguageCode: 'en' as const,
      tellaskReplyDirective: askBackDirective,
    };
    await DialogPersistence.setActiveTellaskReplyObligation(root.id, askBackDirective);
    await root.dlgStore.persistPendingRuntimePrompt(root, askBackPrompt);
    assert.deepEqual(
      (await resolvePromptReplyGuidance({ dlg: root, prompt: askBackPrompt, language: 'en' }))
        .activeReplyDirective,
      askBackDirective,
      'a queued reminder retains a genuinely unfinished ask-back obligation',
    );
    await sideDialog.receiveTellaskResult({
      type: 'tellask_result_msg',
      role: 'tool',
      callId: deliveredAskBackCallId,
      callName: 'tellaskBack',
      status: 'completed',
      content: 'Already delivered ask-back reply.',
      call: {
        tellaskContent: 'Need one ask-back answer.',
      },
      responder: {
        responderId: 'tester',
        agentId: 'tester',
        originMemberId: 'pangu',
      },
    });
    const staleAskBackGuidance = await resolvePromptReplyGuidance({
      dlg: root,
      prompt: askBackPrompt,
      language: 'en',
    });
    assert.equal(staleAskBackGuidance.activeReplyDirective, undefined);
    assert.equal(staleAskBackGuidance.persistedTellaskReplyDirective, undefined);
    assert.equal(staleAskBackGuidance.promptContent?.includes(askBackPrompt.content), false);
    recordGuidance(
      'stale-askback-prompt',
      staleAskBackGuidance.promptContent ?? '',
      'The requester already has a canonical ask-back result, while both a queued runtime reminder and a stale executor obligation survive on disk.',
      { targetCallId: deliveredAskBackCallId },
    );
    const staleAskBackZh = await resolvePromptReplyGuidance({
      dlg: root,
      prompt: askBackPrompt,
      language: 'zh',
    });
    assert.equal(staleAskBackZh.activeReplyDirective, undefined);
    recordGuidance(
      'stale-askback-prompt-zh',
      staleAskBackZh.promptContent ?? '',
      'A completed ask-back still has a queued runtime reminder and a stale executor obligation; render the expiration notice in Chinese.',
      { language: 'zh', targetCallId: deliveredAskBackCallId },
    );
    const duplicateAskBackRecorder = recordDialogEvents(root);
    const duplicateAskBackReply = await executeTellaskCalls({
      dlg: root,
      calls: [
        {
          callId: 'duplicate-askback-reply-tool-call',
          callName: 'replyTellaskBack',
          replyContent: 'Done again.',
        },
      ],
      callbacks: {
        scheduleDrive: () => {},
        driveDialog: async () => {},
      },
    });
    assert.deepEqual(
      duplicateAskBackReply.successfulReplyCallIds,
      [],
      'already resolved replyTellaskBack target must not count as delivered',
    );
    assert.deepEqual(
      duplicateAskBackReply.failedReplyCallIds,
      ['duplicate-askback-reply-tool-call'],
      'already resolved replyTellaskBack target must track the duplicate reply as failed',
    );
    assert.equal(
      duplicateAskBackReply.toolOutputs.length,
      1,
      'expected one tool result for already resolved replyTellaskBack target',
    );
    assert.equal(duplicateAskBackReply.toolOutputs[0]?.type, 'func_result_msg');
    const duplicateAskBackToolOutput = duplicateAskBackReply.toolOutputs[0];
    assert.ok(duplicateAskBackToolOutput, 'expected duplicate ask-back reply tool output');
    recordGuidance(
      'duplicate-askback',
      duplicateAskBackToolOutput.content,
      'The ask-back target already has a canonical result; a stale active obligation must be cleared rather than delivered twice.',
      { targetCallId: deliveredAskBackCallId },
    );
    const duplicateAskBackEvents = await duplicateAskBackRecorder.finish();
    assert.equal(
      duplicateAskBackEvents.some((event) => event.type === 'stream_error_evt'),
      false,
      'already resolved replyTellaskBack target should not emit stream_error_evt',
    );
    assert.equal(
      (await DialogPersistence.loadCourseEvents(sideDialog.id, 1, sideDialog.status)).filter(
        (event) =>
          event.type === 'tellask_result_record' && event.callId === deliveredAskBackCallId,
      ).length,
      1,
      'already resolved replyTellaskBack target must keep exactly one canonical result',
    );
    assert.equal(
      await DialogPersistence.loadActiveTellaskReplyObligation(root.id, root.status),
      undefined,
      'already resolved replyTellaskBack target should clear stale reply obligation',
    );

    const deferredTargetCallId = 'deferred-reply-call';
    const deferredTellaskContent = 'Please finish this deferred reply once and only once.';
    const deferredSideDialog = await root.createSideDialog(
      'pangu',
      ['@pangu'],
      deferredTellaskContent,
      {
        callName: 'tellask',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId: deferredTargetCallId,
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        sessionSlug: 'deferred-reply-guidance',
        collectiveTargets: ['pangu'],
      },
    );
    const deferredDirective: TellaskReplyDirective = {
      expectedReplyCallName: 'replyTellask',
      targetDialogId: root.id.selfId,
      targetCallId: deferredTargetCallId,
      tellaskContent: deferredTellaskContent,
    };
    await deferredSideDialog.persistUserMessage(
      formatAssignmentFromAskerDialog({
        callName: 'tellask',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: ['@pangu'],
        tellaskContent: deferredTellaskContent,
        language: getWorkLanguage(),
        sessionSlug: 'deferred-reply-guidance',
        collectiveTargets: ['pangu'],
      }),
      'deferred-assignment-msg',
      'markdown',
      'runtime',
      'en',
      undefined,
      deferredDirective,
    );
    await DialogPersistence.saveActiveCalleeDispatches(
      root.id,
      [
        {
          calleeDialogId: deferredSideDialog.id.selfId,
          createdAt: formatUnifiedTimestamp(new Date()),
          batchId: 'deferred-reply-guidance-batch',
          callName: 'tellask',
          mentionList: ['@pangu'],
          tellaskContent: deferredTellaskContent,
          targetAgentId: 'pangu',
          callId: deferredTargetCallId,
          callSiteCourse: toCallSiteCourseNo(1),
          callSiteGenseq: toCallSiteGenseqNo(1),
          callType: 'B',
          sessionSlug: 'deferred-reply-guidance',
        },
      ],
      undefined,
      root.status,
    );
    await seedRenderedAssignment(deferredSideDialog);
    const suppliedDeferredReply = await supplySideDialogResponseToAssignedAskerIfPendingV2({
      sideDialog: deferredSideDialog,
      responseText: 'Deferred reply delivered exactly once.',
      responseGenseq: 1,
      replyResolution: {
        callId: 'deliver-deferred-reply-call',
        replyCallName: 'replyTellask',
      },
      scheduleDrive: () => {},
    });
    assert.equal(
      suppliedDeferredReply,
      true,
      'expected sideDialog reply resolution path to accept the deferred reply delivery',
    );
    assert.equal(
      await DialogPersistence.loadActiveTellaskReplyObligation(
        deferredSideDialog.id,
        deferredSideDialog.status,
      ),
      undefined,
      'replyTellask delivery must clear the sideDialog-level active reply obligation',
    );

    const stalePrompt = {
      content: 'Please call the reply tool now. runtime-data-side-082c',
      msgId: 'stale-runtime-reply-reminder',
      grammar: 'markdown' as const,
      origin: 'runtime' as const,
      userLanguageCode: 'en' as const,
      tellaskReplyDirective: deferredDirective,
    };
    await deferredSideDialog.dlgStore.persistPendingRuntimePrompt(deferredSideDialog, stalePrompt);
    const stalePromptGuidance = await resolvePromptReplyGuidance({
      dlg: deferredSideDialog,
      prompt: stalePrompt,
      language: 'en',
    });
    assert.equal(stalePromptGuidance.activeReplyDirective, undefined);
    assert.equal(stalePromptGuidance.persistedTellaskReplyDirective, undefined);
    assert.equal(stalePromptGuidance.promptContent?.includes(stalePrompt.content), false);
    const sameTextFromUser = await resolvePromptReplyGuidance({
      dlg: deferredSideDialog,
      prompt: {
        ...stalePrompt,
        origin: 'user',
        msgId: 'user-same-text-42ec',
        tellaskReplyDirective: undefined,
      },
      language: 'en',
    });
    assert.ok(
      sameTextFromUser.promptContent?.endsWith(stalePrompt.content),
      'real user payload survives byte-for-byte even when it equals an expired runtime reminder',
    );

    recordGuidance(
      'stale-prompt',
      stalePromptGuidance.promptContent ?? '',
      'A queued runtime prompt still carries an old reply directive after durable delivery resolved the obligation.',
      { targetCallId: deferredTargetCallId },
    );

    const stalePromptZh = await resolvePromptReplyGuidance({
      dlg: deferredSideDialog,
      prompt: stalePrompt,
      language: 'zh',
    });
    assert.equal(stalePromptZh.activeReplyDirective, undefined);
    recordGuidance(
      'stale-prompt-zh',
      stalePromptZh.promptContent ?? '',
      'A completed side-dialog reply still has a durable queued runtime reminder; render the expiration notice in Chinese.',
      { language: 'zh', targetCallId: deferredTargetCallId },
    );

    const liveDirective: TellaskReplyDirective = {
      expectedReplyCallName: 'replyTellask',
      targetDialogId: root.id.selfId,
      targetCallId: 'live-reply-call',
      tellaskContent: 'Please acknowledge the correction and stop.',
    };
    const liveSideDialog = await root.createSideDialog(
      'pangu',
      ['@pangu'],
      liveDirective.tellaskContent,
      {
        callName: 'tellask',
        originMemberId: 'tester',
        askerDialogId: root.id.selfId,
        callId: liveDirective.targetCallId,
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        sessionSlug: 'live-reply-guidance',
        collectiveTargets: ['pangu'],
      },
    );
    await liveSideDialog.persistUserMessage(
      formatAssignmentFromAskerDialog({
        callName: 'tellask',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: ['@pangu'],
        tellaskContent: liveDirective.tellaskContent,
        language: getWorkLanguage(),
        sessionSlug: 'live-reply-guidance',
        collectiveTargets: ['pangu'],
      }),
      'live-assignment-msg',
      'markdown',
      'runtime',
      'en',
      undefined,
      liveDirective,
    );

    await seedRenderedAssignment(liveSideDialog);
    await DialogPersistence.appendActiveCalleeDispatch(root.id, {
      calleeDialogId: liveSideDialog.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      batchId: 'live-reply-batch',
      callName: 'tellask',
      mentionList: ['@pangu'],
      tellaskContent: liveDirective.tellaskContent,
      targetAgentId: 'pangu',
      callId: liveDirective.targetCallId,
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      callType: 'B',
      sessionSlug: 'live-reply-guidance',
    });
    const liveRecorder = recordDialogEvents(liveSideDialog);
    const originalLiveGenerator = getLlmGenerator('mock');
    assert.ok(originalLiveGenerator);
    let liveRootRounds = 0;
    let liveSideRounds = 0;
    registerLlmGenerator({
      apiType: 'mock',
      async genToReceiver(_provider, _agent, _system, _tools, request, _context, receiver) {
        if (request.dialogSelfId === liveSideDialog.id.selfId) {
          liveSideRounds += 1;
          assert.equal(liveSideRounds, 1);
          await receiver.funcCall(
            'explicit-live-reply',
            'replyTellask',
            JSON.stringify({ replyContent: liveReplyPayload }),
          );
        } else {
          assert.equal(request.dialogSelfId, root.id.selfId);
          liveRootRounds += 1;
          assert.equal(liveRootRounds, 1);
          await receiver.sayingStart();
          await receiver.sayingChunk('caller-consumed-data-916b');
          await receiver.sayingFinish();
        }
        return { usage: { kind: 'unavailable' }, llmGenModel: 'default' };
      },
      async genMoreMessages() {
        throw new Error('streaming fixture only');
      },
    });
    try {
      await driveDialogStream(
        liveSideDialog,
        makeUserPrompt('live-reply-input-data', 'live-reply-user-msg'),
        true,
      );
      await waitForAllDialogsUnlocked(root, 2000);
      assert.equal(liveSideRounds, 1);
      assert.equal(liveRootRounds, 1);
    } finally {
      registerLlmGenerator(originalLiveGenerator);
    }
    const liveEvents = await liveRecorder.finish();

    const funcCallEvt = liveEvents.find(
      (ev): ev is Extract<TypedDialogEvent, { type: 'func_call_requested_evt' }> =>
        ev.type === 'func_call_requested_evt' && ev.funcName === 'replyTellask',
    );
    assert.ok(
      funcCallEvt,
      'expected live sideDialog to emit func_call_requested_evt for replyTellask',
    );

    const funcResultEvt = liveEvents.find(
      (ev): ev is Extract<TypedDialogEvent, { type: 'func_result_evt' }> =>
        ev.type === 'func_result_evt' && ev.name === 'replyTellask',
    );
    assert.ok(funcResultEvt, 'expected live sideDialog to emit func_result_evt for replyTellask');
    assert.equal(funcResultEvt.id, funcCallEvt.funcId);
    const delivered = (
      await DialogPersistence.loadCourseEvents(root.id, root.currentCourse, root.status)
    )
      .filter((event) => event.type === 'tellask_result_record')
      .filter((event) => event.callId === liveDirective.targetCallId);
    assert.equal(
      delivered.length,
      1,
      'the successful tool receipt corresponds to exactly one canonical caller delivery',
    );
    assert.equal(delivered[0].status, 'completed');
    assert.ok(
      delivered[0].content.includes(liveReplyPayload),
      'canonical caller delivery retains the supplied opaque reply payload',
    );
    assert.equal(
      (await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status)).some(
        (dispatch) => dispatch.callId === liveDirective.targetCallId,
      ),
      false,
    );

    recordGuidance(
      'delivered-reply',
      funcResultEvt.content,
      'The required reply tool was actually called for the current side-dialog task.',
      { targetCallId: liveDirective.targetCallId },
    );

    // A restored runtime prompt must expire in scheduling as well as in its rendered guidance.
    const previousGenerator = getLlmGenerator('mock');
    assert.ok(previousGenerator);
    const expiredContexts: ChatMessage[][] = [];
    const expiredGenerator: LlmGenerator = {
      apiType: 'mock',
      async genToReceiver(_provider, _agent, _system, _tools, _request, context, receiver) {
        expiredContexts.push(structuredClone(context));
        await receiver.sayingStart();
        await receiver.sayingChunk('local-output-data-expired-f23a');
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
    registerLlmGenerator(expiredGenerator);
    try {
      for (const [dialog, prompt, expectedContent] of [
        [root, askBackPrompt, staleAskBackGuidance.promptContent],
        [deferredSideDialog, stalePrompt, stalePromptGuidance.promptContent],
      ] as const) {
        let scheduled = 0;
        const outcome = await executeDriveRound({
          runtime: createKernelDriverRuntimeState(),
          driveArgs: [
            dialog,
            prompt,
            true,
            makeDriveOptions({
              suppressDiligencePush: true,
              businessContinuation: {
                kind: 'inter_dialog_reply',
                tellaskReplyDirective: prompt.tellaskReplyDirective,
              },
            }),
          ],
          scheduleDrive: () => {
            scheduled += 1;
          },
          driveDialog: async () => {
            throw new Error('expired reminder must not drive another round');
          },
        });
        assert.equal(outcome?.lastAssistantSayingContent, 'local-output-data-expired-f23a');
        const actualWords = (
          await DialogPersistence.loadCourseEvents(dialog.id, dialog.currentCourse, dialog.status)
        ).filter((event) => event.type === 'agent_words_record');
        assert.equal(actualWords.at(-1)?.content, 'local-output-data-expired-f23a');
        assert.equal(scheduled, 0);
        assert.equal(dialog.hasQueuedPrompt(), false);
        assert.deepEqual(outcome?.lastBusinessContinuation, { kind: 'none' });
        const deliveredContext = expiredContexts.at(-1);
        assert.ok(deliveredContext);
        const projectedPrompt = deliveredContext.find(
          (message) => message.type === 'prompting_msg' && message.msgId === prompt.msgId,
        );
        assert.ok(projectedPrompt && 'content' in projectedPrompt);
        assert.equal(
          projectedPrompt.content,
          expectedContent,
          'the actual provider receives the reviewed expiration guidance',
        );
      }
      assert.equal(expiredContexts.length, 2);
    } finally {
      registerLlmGenerator(previousGenerator);
    }
  });

  await evidence.write();
  console.log('kernel-driver reply-tool-dynamic-guidance: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver reply-tool-dynamic-guidance: FAIL\n${message}`);
  process.exit(1);
});
