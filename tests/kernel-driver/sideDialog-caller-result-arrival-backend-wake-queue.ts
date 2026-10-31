import assert from 'node:assert/strict';

import {
  toAskerCourseNumber,
  toCalleeGenerationSeqNumber,
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
  toDialogCourseNumber,
} from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { MainDialog, SideDialog } from '../../main/dialog';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { driveQueuedDialogsOnce } from '../../main/llm/kernel-driver/loop';
import { supplyResponseToAskerDialog } from '../../main/llm/kernel-driver/sideDialog';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { messageProvider } from '../helpers/message-provider';
import {
  createMainDialog,
  hasPendingNextStepTriggers,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

function lastSideDialogAssistantSaying(dlg: SideDialog): string | null {
  for (let i = dlg.msgs.length - 1; i >= 0; i -= 1) {
    const msg = dlg.msgs[i];
    if (msg && msg.type === 'saying_msg' && msg.role === 'assistant') {
      return typeof msg.content === 'string' ? msg.content : null;
    }
  }
  return null;
}

function lastMainAssistantSaying(dlg: MainDialog): string | null {
  for (let i = dlg.msgs.length - 1; i >= 0; i -= 1) {
    const msg = dlg.msgs[i];
    if (msg && msg.type === 'saying_msg' && msg.role === 'assistant') {
      return typeof msg.content === 'string' ? msg.content : null;
    }
  }
  return null;
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    for (const streaming of [true, false]) {
      await writeStandardMinds(tmpRoot, {
        extraMembers: ['fullstack', 'mentor'],
        providerApiType: 'controlled-caller-wake',
        streaming,
      });
      setWorkLanguage('en');
      const suppliedBodies = new Map([
        ['caller-to-callee', 'mentor finished the nested task'],
        ['caller-without-final-to-callee', 'mentor finished the other nested task'],
        [
          'root-to-caller-without-final',
          'Caller without final response resumed from active-callees result arrival.',
        ],
        ['root-to-main-callee', 'mentor finished the mainline task'],
      ]);
      const answers = new Map([
        ['caller-to-callee', 'Caller resumed from Wake Queue side-dialog result arrival.'],
        [
          'caller-without-final-to-callee',
          'Caller without final response resumed from active-callees result arrival.',
        ],
        ['root-to-caller-without-final', 'root-consumed-recovered-work-data'],
        ['root-to-main-callee', 'Mainline resumed from Wake Queue result arrival.'],
      ]);
      const requests = new Map<string, number>();
      const provider = messageProvider(
        'controlled-caller-wake',
        ({ context, genseq, streaming: actualStreaming }) => {
          assert.equal(actualStreaming, streaming);
          const result = context.filter((message) => message.type === 'tellask_result_msg').at(-1);
          assert.ok(result);
          const body = suppliedBodies.get(result.callId);
          const answer = answers.get(result.callId);
          assert.ok(
            body && answer,
            'every attempted result continuation must have a defined fixture',
          );
          assert.ok(
            result.content.includes(body),
            'the supplied result body reaches its real caller',
          );
          requests.set(result.callId, (requests.get(result.callId) ?? 0) + 1);
          assert.equal(
            requests.get(result.callId),
            1,
            'consumed result work must not re-enter the provider',
          );
          return {
            messages: [
              { type: 'saying_msg', role: 'assistant', genseq, content: answer },
              ...(result.callId === 'caller-without-final-to-callee'
                ? [
                    {
                      type: 'func_call_msg' as const,
                      role: 'assistant' as const,
                      genseq,
                      id: 'caller-finishes-recovered-work',
                      name: 'replyTellask',
                      arguments: JSON.stringify({ replyContent: answer }),
                    },
                  ]
                : []),
            ],
            usage: { kind: 'unavailable' },
          };
        },
      );
      registerLlmGenerator(provider);
      const registeredRoots: string[] = [];
      try {
        const root = await createMainDialog('tester');
        root.disableDiligencePush = true;
        globalDialogRegistry.register(root);
        registeredRoots.push(root.id.rootId);

        const caller = await root.createSideDialog(
          'fullstack',
          ['@fullstack'],
          'Please coordinate the nested work.',
          {
            callName: 'tellask',
            originMemberId: 'tester',
            askerDialogId: root.id.selfId,
            callId: 'root-to-caller',
            callSiteCourse: toCallSiteCourseNo(1),
            callSiteGenseq: toCallSiteGenseqNo(1),
            sessionSlug: 'wake-queue-caller',
            collectiveTargets: ['fullstack'],
          },
        );
        const callee = await caller.createSideDialog(
          'mentor',
          ['@mentor'],
          'Please finish the nested task.',
          {
            callName: 'tellaskSessionless',
            originMemberId: 'fullstack',
            askerDialogId: caller.id.selfId,
            callId: 'caller-to-callee',
            callSiteCourse: toCallSiteCourseNo(1),
            callSiteGenseq: toCallSiteGenseqNo(2),
            collectiveTargets: ['mentor'],
          },
        );

        await DialogPersistence.appendActiveCalleeDispatch(caller.id, {
          batchId: 'dispatch:test:caller:c1:g2',
          calleeDialogId: callee.id.selfId,
          callId: 'caller-to-callee',
          callName: 'tellaskSessionless',
          callSiteCourse: toCallSiteCourseNo(1),
          callSiteGenseq: toCallSiteGenseqNo(2),
          callType: 'C',
          createdAt: formatUnifiedTimestamp(new Date()),
          mentionList: ['@mentor'],
          targetAgentId: 'mentor',
          tellaskContent: 'Please finish the nested task.',
        });
        await DialogPersistence.mutateDialogLatest(caller.id, () => ({
          kind: 'patch',
          patch: {
            sideDialogFinalResponse: {
              callId: 'root-to-caller',
              responseCourse: toDialogCourseNumber(1),
              responseGenseq: toCalleeGenerationSeqNumber(1),
              askerDialogId: root.id.selfId,
              askerCourse: toAskerCourseNumber(1),
            },
          },
        }));

        await supplyResponseToAskerDialog({
          callerDialog: caller,
          sideDialogId: callee.id,
          responseText: 'mentor finished the nested task',
          callType: 'C',
          callId: 'caller-to-callee',
          calleeResponseRef: { course: 1, genseq: 1 },
          scheduleDrive: () => {},
        });

        const callerLatestAfterReply = await DialogPersistence.loadDialogLatest(
          caller.id,
          caller.status,
        );
        assert.equal(
          hasPendingNextStepTriggers(callerLatestAfterReply),
          true,
          'side-dialog caller should retain durable result_arrival trigger when direct schedule is lost',
        );

        const wakeQueueTargets = await DialogPersistence.loadWakeQueueTargetDialogIds(
          root.id,
          root.status,
        );
        assert.ok(
          wakeQueueTargets.some((dialogId) => dialogId.selfId === caller.id.selfId),
          'side-dialog caller with durable result_arrival must stay in Wake Queue even after a final response anchor',
        );

        await driveQueuedDialogsOnce();
        await waitForAllDialogsUnlocked(root, 3_000);

        assert.equal(
          lastSideDialogAssistantSaying(caller),
          'Caller resumed from Wake Queue side-dialog result arrival.',
        );
        const callerLatestAfterDrive = await DialogPersistence.loadDialogLatest(
          caller.id,
          caller.status,
        );
        assert.equal(
          hasPendingNextStepTriggers(callerLatestAfterDrive),
          false,
          'backend wake queue should consume side-dialog caller result_arrival trigger',
        );
        const callerEventsAfterDrive = await DialogPersistence.loadCourseEvents(
          caller.id,
          caller.currentCourse,
          caller.status,
        );
        const genStartCountAfterDrive = callerEventsAfterDrive.filter(
          (event) => event.type === 'gen_start_record',
        ).length;

        await driveDialogStream(caller, undefined, true, {
          source: 'kernel_driver_business_continuation',
          reason: 'late_direct_continuation_after_backend_wake_queue_consumed_result_arrival',
          suppressDiligencePush: true,
          businessContinuation: {
            kind: 'requested_work_reply',
            callerDialogId: caller.id.selfId,
            batchId: 'dispatch:test:caller:c1:g2',
            callSiteCourse: toCallSiteCourseNo(1),
            callSiteGenseq: toCallSiteGenseqNo(2),
            sideDialogId: callee.id.selfId,
            callType: 'C',
            callId: 'caller-to-callee',
            resolvedCallIds: ['caller-to-callee'],
            triggerCallId: 'caller-to-callee',
          },
        });
        await waitForAllDialogsUnlocked(root, 3_000);

        const callerEventsAfterLateDirectContinuation = await DialogPersistence.loadCourseEvents(
          caller.id,
          caller.currentCourse,
          caller.status,
        );
        const genStartCountAfterLateDirectContinuation =
          callerEventsAfterLateDirectContinuation.filter(
            (event) => event.type === 'gen_start_record',
          ).length;
        assert.equal(
          genStartCountAfterLateDirectContinuation,
          genStartCountAfterDrive,
          'late direct requested-work reply after consumed result_arrival must not open an empty generation',
        );

        await DialogPersistence.upsertNextStepTrigger(
          caller.id,
          {
            triggerId: 'result-arrival:dispatch:test:caller:c1:g2',
            kind: 'result_arrival',
            batchId: 'dispatch:test:caller:c1:g2',
          },
          caller.status,
        );
        await driveDialogStream(caller, undefined, true, {
          source: 'kernel_driver_business_continuation',
          reason:
            'late_direct_continuation_after_consumed_result_arrival_with_stale_trigger_residue',
          suppressDiligencePush: true,
          businessContinuation: {
            kind: 'requested_work_reply',
            callerDialogId: caller.id.selfId,
            batchId: 'dispatch:test:caller:c1:g2',
            callSiteCourse: toCallSiteCourseNo(1),
            callSiteGenseq: toCallSiteGenseqNo(2),
            sideDialogId: callee.id.selfId,
            callType: 'C',
            callId: 'caller-to-callee',
            resolvedCallIds: ['caller-to-callee'],
            triggerCallId: 'caller-to-callee',
          },
        });
        await waitForAllDialogsUnlocked(root, 3_000);
        const callerEventsAfterLateDirectContinuationWithResidue =
          await DialogPersistence.loadCourseEvents(caller.id, caller.currentCourse, caller.status);
        const genStartCountAfterLateDirectContinuationWithResidue =
          callerEventsAfterLateDirectContinuationWithResidue.filter(
            (event) => event.type === 'gen_start_record',
          ).length;
        assert.equal(
          genStartCountAfterLateDirectContinuationWithResidue,
          genStartCountAfterDrive,
          'late direct requested-work reply must stay stale when active-callees says the result_arrival batch was consumed',
        );
        await driveQueuedDialogsOnce();
        await waitForAllDialogsUnlocked(root, 3_000);
        const callerEventsAfterStaleBackendResidue = await DialogPersistence.loadCourseEvents(
          caller.id,
          caller.currentCourse,
          caller.status,
        );
        const genStartCountAfterStaleBackendResidue = callerEventsAfterStaleBackendResidue.filter(
          (event) => event.type === 'gen_start_record',
        ).length;
        assert.equal(
          genStartCountAfterStaleBackendResidue,
          genStartCountAfterDrive,
          'backend-loop stale result_arrival trigger must not open a generation after active-callees consumption',
        );
        const callerLatestAfterStaleBackendResidue = await DialogPersistence.loadDialogLatest(
          caller.id,
          caller.status,
        );
        assert.equal(
          callerLatestAfterStaleBackendResidue?.nextStep.triggers.some(
            (trigger) => trigger.kind === 'result_arrival',
          ),
          false,
          'backend-loop stale side-dialog result_arrival trigger should be cleared by requested-work claim',
        );

        const callerWithoutFinalResponse = await root.createSideDialog(
          'fullstack',
          ['@fullstack'],
          'Please coordinate another nested work item.',
          {
            callName: 'tellask',
            originMemberId: 'tester',
            askerDialogId: root.id.selfId,
            callId: 'root-to-caller-without-final',
            callSiteCourse: toCallSiteCourseNo(1),
            callSiteGenseq: toCallSiteGenseqNo(3),
            sessionSlug: 'wake-queue-caller-without-final',
            collectiveTargets: ['fullstack'],
          },
        );
        // A child can deliver a reply only while its parent has the corresponding dispatch.
        // Creating the dialog alone does not establish that business fact.
        await DialogPersistence.appendActiveCalleeDispatch(root.id, {
          batchId: 'dispatch:test:root:c1:g3',
          calleeDialogId: callerWithoutFinalResponse.id.selfId,
          callId: 'root-to-caller-without-final',
          callName: 'tellask',
          callSiteCourse: toCallSiteCourseNo(1),
          callSiteGenseq: toCallSiteGenseqNo(3),
          callType: 'B',
          createdAt: formatUnifiedTimestamp(new Date()),
          mentionList: ['@fullstack'],
          targetAgentId: 'fullstack',
          tellaskContent: 'Please coordinate another nested work item.',
          sessionSlug: 'wake-queue-caller-without-final',
        });
        const calleeWithoutFinalResponse = await callerWithoutFinalResponse.createSideDialog(
          'mentor',
          ['@mentor'],
          'Please finish the other nested task.',
          {
            callName: 'tellaskSessionless',
            originMemberId: 'fullstack',
            askerDialogId: callerWithoutFinalResponse.id.selfId,
            callId: 'caller-without-final-to-callee',
            callSiteCourse: toCallSiteCourseNo(1),
            callSiteGenseq: toCallSiteGenseqNo(4),
            collectiveTargets: ['mentor'],
          },
        );

        await DialogPersistence.appendActiveCalleeDispatch(callerWithoutFinalResponse.id, {
          batchId: 'dispatch:test:caller-without-final:c1:g4',
          calleeDialogId: calleeWithoutFinalResponse.id.selfId,
          callId: 'caller-without-final-to-callee',
          callName: 'tellaskSessionless',
          callSiteCourse: toCallSiteCourseNo(1),
          callSiteGenseq: toCallSiteGenseqNo(4),
          callType: 'C',
          createdAt: formatUnifiedTimestamp(new Date()),
          mentionList: ['@mentor'],
          targetAgentId: 'mentor',
          tellaskContent: 'Please finish the other nested task.',
        });
        await supplyResponseToAskerDialog({
          callerDialog: callerWithoutFinalResponse,
          sideDialogId: calleeWithoutFinalResponse.id,
          responseText: 'mentor finished the other nested task',
          callType: 'C',
          callId: 'caller-without-final-to-callee',
          calleeResponseRef: { course: 1, genseq: 1 },
          scheduleDrive: () => {},
        });
        await DialogPersistence.removeNextStepTriggers(
          callerWithoutFinalResponse.id,
          (trigger) => trigger.kind === 'result_arrival',
          callerWithoutFinalResponse.status,
        );

        const callerWithoutFinalEventsBeforeLateContinuation =
          await DialogPersistence.loadCourseEvents(
            callerWithoutFinalResponse.id,
            callerWithoutFinalResponse.currentCourse,
            callerWithoutFinalResponse.status,
          );
        const genStartCountBeforeLateContinuation =
          callerWithoutFinalEventsBeforeLateContinuation.filter(
            (event) => event.type === 'gen_start_record',
          ).length;

        await driveDialogStream(callerWithoutFinalResponse, undefined, true, {
          source: 'kernel_driver_business_continuation',
          reason:
            'direct_continuation_after_result_arrival_trigger_was_lost_without_final_response',
          suppressDiligencePush: true,
          businessContinuation: {
            kind: 'requested_work_reply',
            callerDialogId: callerWithoutFinalResponse.id.selfId,
            batchId: 'dispatch:test:caller-without-final:c1:g4',
            callSiteCourse: toCallSiteCourseNo(1),
            callSiteGenseq: toCallSiteGenseqNo(4),
            sideDialogId: calleeWithoutFinalResponse.id.selfId,
            callType: 'C',
            callId: 'caller-without-final-to-callee',
            resolvedCallIds: ['caller-without-final-to-callee'],
            triggerCallId: 'caller-without-final-to-callee',
          },
        });
        await waitForAllDialogsUnlocked(root, 3_000);

        const callerWithoutFinalEventsAfterLateContinuation =
          await DialogPersistence.loadCourseEvents(
            callerWithoutFinalResponse.id,
            callerWithoutFinalResponse.currentCourse,
            callerWithoutFinalResponse.status,
          );
        const genStartCountAfterLateContinuationWithoutFinal =
          callerWithoutFinalEventsAfterLateContinuation.filter(
            (event) => event.type === 'gen_start_record',
          ).length;
        assert.equal(
          genStartCountAfterLateContinuationWithoutFinal - genStartCountBeforeLateContinuation,
          1,
          'direct requested-work reply should recover when active-callees still has a resolved result_arrival batch even if its trigger was lost',
        );
        provider.assertNoErrors();
        assert.equal(
          lastSideDialogAssistantSaying(callerWithoutFinalResponse),
          answers.get('caller-without-final-to-callee'),
        );
        const activeCalleesAfterLostTriggerContinuation = await DialogPersistence.loadActiveCallees(
          callerWithoutFinalResponse.id,
          callerWithoutFinalResponse.status,
        );
        assert.equal(
          activeCalleesAfterLostTriggerContinuation.batches.some(
            (batch) => batch.batchId === 'dispatch:test:caller-without-final:c1:g4',
          ),
          false,
          'active-callees-backed direct continuation should consume the resolved result_arrival batch',
        );

        await driveDialogStream(callerWithoutFinalResponse, undefined, true, {
          source: 'kernel_driver_business_continuation',
          reason: 'late_direct_continuation_after_active_callees_consumed_without_final_response',
          suppressDiligencePush: true,
          businessContinuation: {
            kind: 'requested_work_reply',
            callerDialogId: callerWithoutFinalResponse.id.selfId,
            batchId: 'dispatch:test:caller-without-final:c1:g4',
            callSiteCourse: toCallSiteCourseNo(1),
            callSiteGenseq: toCallSiteGenseqNo(4),
            sideDialogId: calleeWithoutFinalResponse.id.selfId,
            callType: 'C',
            callId: 'caller-without-final-to-callee',
            resolvedCallIds: ['caller-without-final-to-callee'],
            triggerCallId: 'caller-without-final-to-callee',
          },
        });
        await waitForAllDialogsUnlocked(root, 3_000);

        const callerWithoutFinalEventsAfterConsumedContinuation =
          await DialogPersistence.loadCourseEvents(
            callerWithoutFinalResponse.id,
            callerWithoutFinalResponse.currentCourse,
            callerWithoutFinalResponse.status,
          );
        const genStartCountAfterConsumedContinuation =
          callerWithoutFinalEventsAfterConsumedContinuation.filter(
            (event) => event.type === 'gen_start_record',
          ).length;
        assert.equal(
          genStartCountAfterConsumedContinuation,
          genStartCountAfterLateContinuationWithoutFinal,
          'late direct requested-work reply after active-callees consumption and no final response must not open an empty generation',
        );

        // Keep the mainline residue case independent of the nested caller scenario.
        globalDialogRegistry.unregister(root.id.rootId);
        const mainlineRoot = await createMainDialog('tester');
        mainlineRoot.disableDiligencePush = true;
        globalDialogRegistry.register(mainlineRoot);
        registeredRoots.push(mainlineRoot.id.rootId);

        const mainlineCallee = await mainlineRoot.createSideDialog(
          'mentor',
          ['@mentor'],
          'Please finish the mainline task.',
          {
            callName: 'tellaskSessionless',
            originMemberId: 'tester',
            askerDialogId: mainlineRoot.id.selfId,
            callId: 'root-to-main-callee',
            callSiteCourse: toCallSiteCourseNo(1),
            callSiteGenseq: toCallSiteGenseqNo(5),
            collectiveTargets: ['mentor'],
          },
        );
        await DialogPersistence.appendActiveCalleeDispatch(mainlineRoot.id, {
          batchId: 'dispatch:test:root:c1:g5',
          calleeDialogId: mainlineCallee.id.selfId,
          callId: 'root-to-main-callee',
          callName: 'tellaskSessionless',
          callSiteCourse: toCallSiteCourseNo(1),
          callSiteGenseq: toCallSiteGenseqNo(5),
          callType: 'C',
          createdAt: formatUnifiedTimestamp(new Date()),
          mentionList: ['@mentor'],
          targetAgentId: 'mentor',
          tellaskContent: 'Please finish the mainline task.',
        });
        await supplyResponseToAskerDialog({
          callerDialog: mainlineRoot,
          sideDialogId: mainlineCallee.id,
          responseText: 'mentor finished the mainline task',
          callType: 'C',
          callId: 'root-to-main-callee',
          calleeResponseRef: { course: 1, genseq: 1 },
          scheduleDrive: () => {},
        });

        await driveQueuedDialogsOnce();
        await waitForAllDialogsUnlocked(mainlineRoot, 3_000);

        assert.equal(
          lastMainAssistantSaying(mainlineRoot),
          'Mainline resumed from Wake Queue result arrival.',
          'main dialog caller should process the Wake Queue result_arrival once',
        );
        const rootEventsAfterMainlineDrive = await DialogPersistence.loadCourseEvents(
          mainlineRoot.id,
          mainlineRoot.currentCourse,
          mainlineRoot.status,
        );
        const rootGenStartCountAfterMainlineDrive = rootEventsAfterMainlineDrive.filter(
          (event) => event.type === 'gen_start_record',
        ).length;

        await driveDialogStream(mainlineRoot, undefined, true, {
          source: 'kernel_driver_business_continuation',
          reason: 'late_direct_mainline_continuation_after_consumed_result_arrival',
          suppressDiligencePush: true,
          businessContinuation: {
            kind: 'requested_work_reply',
            callerDialogId: mainlineRoot.id.selfId,
            batchId: 'dispatch:test:root:c1:g5',
            callSiteCourse: toCallSiteCourseNo(1),
            callSiteGenseq: toCallSiteGenseqNo(5),
            sideDialogId: mainlineCallee.id.selfId,
            callType: 'C',
            callId: 'root-to-main-callee',
            resolvedCallIds: ['root-to-main-callee'],
            triggerCallId: 'root-to-main-callee',
          },
        });
        await waitForAllDialogsUnlocked(mainlineRoot, 3_000);

        const rootEventsAfterLateMainlineContinuation = await DialogPersistence.loadCourseEvents(
          mainlineRoot.id,
          mainlineRoot.currentCourse,
          mainlineRoot.status,
        );
        const rootGenStartCountAfterLateMainlineContinuation =
          rootEventsAfterLateMainlineContinuation.filter(
            (event) => event.type === 'gen_start_record',
          ).length;
        assert.equal(
          rootGenStartCountAfterLateMainlineContinuation,
          rootGenStartCountAfterMainlineDrive,
          'late direct main-dialog continuation after consumed result_arrival must not open an empty generation',
        );

        await DialogPersistence.upsertNextStepTrigger(
          mainlineRoot.id,
          {
            triggerId: 'result-arrival:dispatch:test:root:c1:g5',
            kind: 'result_arrival',
            batchId: 'dispatch:test:root:c1:g5',
          },
          mainlineRoot.status,
        );
        globalDialogRegistry.queueRootDrive(mainlineRoot.id.rootId, {
          source: 'test_stale_result_arrival',
          reason: 'exercise explicit wake after injecting stale residue',
        });
        await driveQueuedDialogsOnce();
        await waitForAllDialogsUnlocked(mainlineRoot, 3_000);

        const rootEventsAfterStaleMainlineBackendResidue = await DialogPersistence.loadCourseEvents(
          mainlineRoot.id,
          mainlineRoot.currentCourse,
          mainlineRoot.status,
        );
        const rootGenStartCountAfterStaleMainlineBackendResidue =
          rootEventsAfterStaleMainlineBackendResidue.filter(
            (event) => event.type === 'gen_start_record',
          ).length;
        assert.equal(
          rootGenStartCountAfterStaleMainlineBackendResidue,
          rootGenStartCountAfterMainlineDrive,
          'backend-loop stale main-dialog result_arrival trigger must not open a generation after active-callees consumption',
        );
        const rootLatestAfterStaleMainlineBackendResidue = await DialogPersistence.loadDialogLatest(
          mainlineRoot.id,
          mainlineRoot.status,
        );
        assert.equal(
          rootLatestAfterStaleMainlineBackendResidue?.nextStep.triggers.some(
            (trigger) => trigger.kind === 'result_arrival',
          ),
          false,
          'backend-loop stale main-dialog result_arrival trigger should be cleared by requested-work claim',
        );
        provider.assertNoErrors();
        assert.deepEqual(
          [...requests.entries()].sort(),
          [...answers.keys()].map((key) => [key, 1]).sort(),
        );
      } finally {
        for (const rootId of registeredRoots) globalDialogRegistry.unregister(rootId);
        unregisterLlmGenerator('controlled-caller-wake');
      }
    }
  });

  console.log('kernel-driver sideDialog-caller-result-arrival-backend-wake-queue: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `kernel-driver sideDialog-caller-result-arrival-backend-wake-queue: FAIL\n${message}`,
  );
  process.exit(1);
});
