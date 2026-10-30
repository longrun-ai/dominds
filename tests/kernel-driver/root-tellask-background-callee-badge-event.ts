import assert from 'node:assert/strict';
import type WebSocket from 'ws';

import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import type { DeclareSideDialogDeadRequest } from '@longrun-ai/kernel/types/wire';
import { installRecordingGlobalDialogEventBroadcaster } from '../../main/bootstrap/global-dialog-event-broadcaster';
import { setDialogDisplayState, setDialogExecutionMarker } from '../../main/dialog-display-state';
import { getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import type { LlmGenerator } from '../../main/llm/gen';
import { registerLlmGenerator, unregisterLlmGenerator } from '../../main/llm/gen/registry';
import { supplyResponseToAskerDialog } from '../../main/llm/kernel-driver/sideDialog';
import { processTellaskFunctionRound } from '../../main/llm/kernel-driver/tellask-special';
import { DialogPersistence } from '../../main/persistence';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { handleWebSocketMessage } from '../../main/server/websocket-handler';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import {
  createMainDialog,
  waitFor,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeStandardMinds,
} from './helpers';

type Summary = Extract<TypedDialogEvent, { type: 'dlg_background_callee_summary_evt' }>;
const evidence = semanticEvidenceCollector('dominds-background-callee-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const apiType = 'controlled-background-badge';
    await writeStandardMinds(rtws, { providerApiType: apiType, includePangu: true });
    const expectedCallers = new Map<string, { callId: string; rounds: number }>();
    const generator: LlmGenerator = {
      apiType,
      classifyFailure(error) {
        return {
          kind: 'fatal',
          code: 'test_provider_failure',
          message: error instanceof Error ? error.message : String(error),
        };
      },
      async genMoreMessages() {
        throw new Error('streaming fixture only');
      },
      async genToReceiver(_provider, _agent, _system, _tools, request, context, receiver) {
        const caller = expectedCallers.get(request.dialogSelfId);
        assert.ok(caller);
        caller.rounds += 1;
        assert.equal(caller.rounds, 1);
        const delivered = context
          .filter((message) => message.type === 'tellask_result_msg')
          .filter((message) => message.callId === caller.callId);
        assert.equal(delivered.length, 1);
        assert.equal(delivered[0].status, 'failed');
        await receiver.sayingStart();
        await receiver.sayingChunk('caller-consumed-dead-result-data');
        await receiver.sayingFinish();
        return { usage: { kind: 'unavailable' } };
      },
    };
    registerLlmGenerator(generator);
    try {
      let onSummary: ((event: Summary) => void) | undefined;
      const recorder = installRecordingGlobalDialogEventBroadcaster({
        label: 'background-callee-events',
        publish(event) {
          if (event.type === 'dlg_background_callee_summary_evt') onSummary?.(event);
        },
      });
      const duringSummary = async (
        rootId: string,
        count: number,
        action: () => Promise<unknown>,
      ): Promise<Summary> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expected = new Promise<Summary>((resolve, reject) => {
          onSummary = (event) => {
            if (event.dialog.selfId === rootId && event.backgroundCalleeDialogCount === count)
              resolve(event);
          };
          timer = setTimeout(
            () => reject(new Error(`Missing summary for ${rootId}: ${count}`)),
            2000,
          );
        });
        try {
          const [, event] = await Promise.all([action(), expected]);
          return event;
        } finally {
          clearTimeout(timer);
          onSummary = undefined;
        }
      };
      for (const language of ['en', 'zh'] as const) {
        setWorkLanguage(language);
        recorder.clear();
        const root = await createMainDialog();
        await root.notifyGeneratingStart();
        const taskId = `background-call-${language}`;
        const scheduled: string[] = [];
        const created = await duringSummary(root.id.selfId, 1, () =>
          processTellaskFunctionRound({
            dlg: root,
            funcCalls: [
              {
                type: 'func_call_msg',
                role: 'assistant',
                genseq: root.activeGenSeq,
                id: taskId,
                name: 'tellaskSessionless',
                arguments: JSON.stringify({
                  targetAgentId: 'pangu',
                  tellaskContent: 'background-task-data',
                }),
              },
            ],
            allowedSpecials: new Set(['tellaskSessionless']),
            callbacks: {
              scheduleDrive(dialog) {
                scheduled.push(dialog.id.selfId);
              },
              async driveDialog() {
                assert.fail('sessionless child should be scheduled');
              },
            },
          }),
        );
        assert.equal(created.backgroundFreshBootsReasoningCalleeCount, 0);
        assert.equal(scheduled.length, 1);
        const pending = await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status);
        assert.equal(pending.length, 1);
        assert.equal(pending[0].callId, taskId);
        const side = root.lookupDialog(scheduled[0]);
        assert.ok(side);
        await duringSummary(root.id.selfId, 0, () =>
          supplyResponseToAskerDialog({
            callerDialog: root,
            sideDialogId: side.id,
            responseText: 'failed-operation-payload-data',
            callType: 'C',
            callId: taskId,
            status: 'failed',
            scheduleDrive() {},
          }),
        );
        assert.deepEqual(
          await DialogPersistence.loadActiveCalleeDispatches(root.id, root.status),
          [],
        );
        const results = (
          await DialogPersistence.loadCourseEvents(root.id, root.currentCourse, root.status)
        )
          .filter((event) => event.type === 'tellask_result_record')
          .filter((event) => event.callId === taskId);
        assert.equal(results.length, 1);
        assert.equal(results[0].status, 'failed');
        assert.ok(results[0].content.includes('failed-operation-payload-data'));
        await root.notifyGeneratingFinish();

        const deadRoot = await createMainDialog();
        const callId = `already-dead-call-${language}`;
        expectedCallers.set(deadRoot.id.selfId, { callId, rounds: 0 });
        await DialogPersistence.mutateDialogLatest(deadRoot.id, () => ({
          kind: 'patch',
          patch: { disableDiligencePush: true },
        }));
        const deadSide = await deadRoot.createSideDialog(
          'pangu',
          ['@pangu'],
          'declared-dead-task-data',
          {
            callName: 'tellaskSessionless',
            originMemberId: 'tester',
            askerDialogId: deadRoot.id.selfId,
            callId,
            callSiteCourse: toCallSiteCourseNo(1),
            callSiteGenseq: toCallSiteGenseqNo(1),
            collectiveTargets: ['pangu'],
          },
        );
        await DialogPersistence.appendActiveCalleeDispatch(deadRoot.id, {
          calleeDialogId: deadSide.id.selfId,
          createdAt: '2026-10-30T00:00:00.000Z',
          batchId: `dead-batch-${language}`,
          callName: 'tellaskSessionless',
          mentionList: ['@pangu'],
          tellaskContent: 'declared-dead-task-data',
          targetAgentId: 'pangu',
          callId,
          callSiteCourse: toCallSiteCourseNo(1),
          callSiteGenseq: toCallSiteGenseqNo(1),
          callType: 'C',
        });
        await setDialogExecutionMarker(deadSide.id, {
          kind: 'dead',
          reason: { kind: 'declared_by_user' },
        });
        await setDialogDisplayState(deadSide.id, {
          kind: 'dead',
          reason: { kind: 'declared_by_user' },
        });
        const packets: unknown[] = [];
        // Real WebSocket request handling and persistence; capture only the socket transport boundary.
        const socket = {
          readyState: 1,
          send(data: string) {
            packets.push(JSON.parse(data));
          },
        } as unknown as WebSocket;
        const request: DeclareSideDialogDeadRequest = {
          type: 'declare_sideDialog_dead',
          dialog: { rootId: deadSide.id.rootId, selfId: deadSide.id.selfId, status: 'running' },
        };
        await duringSummary(deadRoot.id.selfId, 0, () => handleWebSocketMessage(socket, request));
        await handleWebSocketMessage(socket, request);
        await waitFor(
          async () =>
            (
              await DialogPersistence.loadCourseEvents(
                deadRoot.id,
                deadRoot.currentCourse,
                deadRoot.status,
              )
            ).some(
              (event) =>
                event.type === 'agent_words_record' &&
                event.content === 'caller-consumed-dead-result-data',
            ),
          3000,
          'caller consume the actual failed result once',
        );
        const actualCaller = await getOrRestoreMainDialog(deadRoot.id.rootId, deadRoot.status);
        assert.ok(actualCaller);
        await waitForAllDialogsUnlocked(actualCaller, 3000);
        assert.equal(expectedCallers.get(deadRoot.id.selfId)?.rounds, 1);
        assert.equal(
          packets.filter(
            (packet) =>
              typeof packet === 'object' &&
              packet !== null &&
              'type' in packet &&
              packet.type === 'error',
          ).length,
          0,
        );
        assert.deepEqual(
          await DialogPersistence.loadActiveCalleeDispatches(deadRoot.id, deadRoot.status),
          [],
        );
        const failed = (
          await DialogPersistence.loadCourseEvents(
            deadRoot.id,
            deadRoot.currentCourse,
            deadRoot.status,
          )
        )
          .filter((event) => event.type === 'tellask_result_record')
          .filter((event) => event.callId === callId);
        assert.equal(
          failed.length,
          1,
          'repeating a declare-dead UI request cannot duplicate the caller result',
        );
        assert.equal(failed[0].status, 'failed');
        evidence.record({
          id: `declare-dead-${language}`,
          scenario:
            'A user retries declaring an already-dead child whose caller still has a pending dispatch, then repeats the same UI request once more.',
          businessValue:
            'Close the unavailable task exactly once, clear its pending badge and explain failure without pretending successful task completion.',
          context: {
            language,
            callId,
            durableResults: failed.length,
            status: failed[0].status,
            pendingDispatches: 0,
          },
          reviewQuestions: [
            'Does the actual caller result accurately explain that the child was declared dead and its task did not complete?',
            'Does the full text make this a failed result for the existing request rather than a new request or a successful task answer?',
          ],
          actualText: failed[0].content,
        });
      }
    } finally {
      unregisterLlmGenerator(apiType);
    }
  });
  await evidence.write();
  console.log(
    'background badges clear with one failed delivery and idempotent declare-dead requests: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
