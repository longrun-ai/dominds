import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DialogID, SideDialog } from '../../main/dialog';
import { reconcileDisplayStatesAfterRestart } from '../../main/dialog-display-state';
import { globalDialogRegistry } from '../../main/dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreMainDialog } from '../../main/dialog-instance-registry';
import type { LlmBatchResult } from '../../main/llm/gen';
import { registerLlmGenerator } from '../../main/llm/gen/registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { runBackendDriver } from '../../main/llm/kernel-driver/loop';
import { DialogPersistence } from '../../main/persistence';
import { recoverOpenGenerationAfterRestart } from '../../main/recovery/open-generation-recovery';
import { recoverPendingReplyDeliveryAfterRestart } from '../../main/recovery/reply-delivery-recovery';
import { setWorkLanguage } from '../../main/runtime/work-language';
import {
  createMainDialog,
  waitFor,
  withTempRtws,
  writeStandardMinds,
} from '../kernel-driver/helpers';
import { recordDialogEvents } from './dialog-events';
import { messageProvider } from './message-provider';

export const generationManifestFile = 'open-generation-manifest.json';
export type GenerationManifest = {
  seedPid: number;
  rootA: string;
  workerA: string;
  rootB: string;
  sideB: string;
  workCallId: string;
  replyCallId: string;
  inputA: string;
  workBody: string;
  replyBody: string;
  ackA: string;
  ackB: string;
};
export async function readGenerationManifest(): Promise<GenerationManifest> {
  const value: unknown = JSON.parse(await fs.readFile(generationManifestFile, 'utf8'));
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  const field = (key: string): string => {
    const result = row[key];
    assert.equal(typeof result, 'string');
    assert.ok(typeof result === 'string' && result.length > 0);
    return result;
  };
  assert.ok(typeof row.seedPid === 'number' && Number.isInteger(row.seedPid));
  return {
    seedPid: row.seedPid,
    rootA: field('rootA'),
    workerA: field('workerA'),
    rootB: field('rootB'),
    sideB: field('sideB'),
    workCallId: field('workCallId'),
    replyCallId: field('replyCallId'),
    inputA: field('inputA'),
    workBody: field('workBody'),
    replyBody: field('replyBody'),
    ackA: field('ackA'),
    ackB: field('ackB'),
  };
}

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    setWorkLanguage('en');
    assert.equal(globalDialogRegistry.size, 0);
    const apiType = 'controlled-open-generation';
    if (process.argv[2] === 'seed') {
      await writeStandardMinds(rtws, {
        extraMembers: ['worker'],
        providerApiType: apiType,
        diligencePushMax: 0,
      });
      const rootA = await createMainDialog();
      const rootB = await createMainDialog();
      for (const root of [rootA, rootB]) {
        root.disableDiligencePush = true;
        await DialogPersistence.mutateDialogLatest(root.id, () => ({
          kind: 'patch',
          patch: { disableDiligencePush: true },
        }));
        globalDialogRegistry.register(root);
      }
      await rootA.persistTellaskCall(
        'pending-background-work',
        'tellask',
        JSON.stringify({
          targetAgentId: 'worker',
          sessionSlug: 'passive-background',
          tellaskContent: 'background-data',
        }),
        1,
      );
      const workerA = await rootA.createSideDialog('worker', ['@worker'], 'background-data', {
        callName: 'tellask',
        originMemberId: 'tester',
        askerDialogId: rootA.id.selfId,
        callId: 'pending-background-work',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        sessionSlug: 'passive-background',
        collectiveTargets: ['worker'],
      });
      await DialogPersistence.appendActiveCalleeDispatch(rootA.id, {
        calleeDialogId: workerA.id.selfId,
        createdAt: new Date().toISOString(),
        batchId: 'background-batch',
        callName: 'tellask',
        mentionList: ['@worker'],
        tellaskContent: 'background-data',
        targetAgentId: 'worker',
        callId: 'pending-background-work',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        callType: 'B',
        sessionSlug: 'passive-background',
      });
      await rootA.loadActiveCalleeDispatchesFromPersistence();
      const manifest = {
        seedPid: process.pid,
        rootA: rootA.id.selfId,
        workerA: workerA.id.selfId,
        rootB: rootB.id.selfId,
        sideB: '',
        workCallId: 'restart-work-call',
        replyCallId: 'restart-side-reply',
        inputA: 'root-input-data-73ab',
        workBody: 'side-work-data-73ab',
        replyBody: 'side-result-data-73ab',
        ackA: 'root-resumed-data-73ab',
        ackB: 'caller-consumed-data-73ab',
      };
      const requests = new Map<string, number>();
      const held = new Promise<LlmBatchResult>(() => {});
      const generator = messageProvider(apiType, ({ request, genseq, context }) => {
        const count = (requests.get(request.dialogSelfId) ?? 0) + 1;
        requests.set(request.dialogSelfId, count);
        assert.equal(count, 1);
        if (request.dialogSelfId === manifest.rootA) {
          assert.ok(
            context.some(
              (message) =>
                'content' in message &&
                typeof message.content === 'string' &&
                message.content.includes(manifest.inputA),
            ),
          );
          return held;
        }
        if (request.dialogSelfId === manifest.rootB) {
          return {
            messages: [
              {
                type: 'func_call_msg',
                role: 'assistant',
                genseq,
                id: manifest.workCallId,
                name: 'tellask',
                arguments: JSON.stringify({
                  targetAgentId: 'worker',
                  sessionSlug: 'restart-side',
                  tellaskContent: manifest.workBody,
                }),
              },
            ],
            usage: { kind: 'unavailable' },
          };
        }
        assert.equal(request.dialogRootId, manifest.rootB);
        assert.notEqual(request.dialogSelfId, manifest.workerA);
        manifest.sideB = request.dialogSelfId;
        assert.ok(
          context.some(
            (message) =>
              'content' in message &&
              typeof message.content === 'string' &&
              message.content.includes(manifest.workBody),
          ),
        );
        return held;
      });
      registerLlmGenerator(generator);
      void driveDialogStream(
        rootA,
        {
          content: manifest.inputA,
          msgId: 'root-input',
          grammar: 'markdown',
          origin: 'user',
          userLanguageCode: 'en',
        },
        true,
      ).catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
      const initialCallerTrace = recordDialogEvents(rootB);
      const initialCaller = driveDialogStream(
        rootB,
        {
          content: 'start-side-input-data',
          msgId: 'start-side',
          grammar: 'markdown',
          origin: 'user',
          userLanguageCode: 'en',
        },
        true,
      ).catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
      await waitFor(
        async () => {
          generator.assertNoErrors();
          return requests.get(manifest.rootA) === 1 && manifest.sideB !== '';
        },
        4000,
        'both real generations to enter the controlled provider before any reply',
      );
      await initialCaller;
      generator.assertNoErrors();
      assert.deepEqual(
        (await initialCallerTrace.finish()).filter((event) => event.type === 'stream_error_evt'),
        [],
      );
      await fs.writeFile(generationManifestFile, JSON.stringify(manifest, null, 2));
      // The parent observes durable files, then kills this owned process while requests remain open.
      setInterval(() => {}, 1000);
      console.log(JSON.stringify({ probe: 'generation-seed-ready', pid: process.pid }));
      return;
    }
    assert.equal(process.argv[2], 'recover');
    const m = await readGenerationManifest();
    assert.notEqual(process.pid, m.seedPid);
    const rootA = await getOrRestoreMainDialog(m.rootA, 'running');
    const rootB = await getOrRestoreMainDialog(m.rootB, 'running');
    assert.ok(rootA && rootB);
    const side = await ensureDialogLoaded(rootB, new DialogID(m.sideB, m.rootB), 'running');
    assert.ok(side instanceof SideDialog);
    const traces = [rootA, rootB, side].map(recordDialogEvents);
    const counts = new Map<string, number>();
    const generator = messageProvider(apiType, ({ request, context, genseq }) => {
      assert.ok([m.rootA, m.rootB, m.sideB].includes(request.dialogSelfId));
      const count = (counts.get(request.dialogSelfId) ?? 0) + 1;
      counts.set(request.dialogSelfId, count);
      assert.equal(count, 1);
      if (request.dialogSelfId === m.sideB) {
        assert.ok(
          context.some(
            (message) =>
              'content' in message &&
              typeof message.content === 'string' &&
              message.content.includes(m.workBody),
          ),
        );
        return {
          messages: [
            {
              type: 'func_call_msg',
              role: 'assistant',
              genseq,
              id: m.replyCallId,
              name: 'replyTellask',
              arguments: JSON.stringify({ replyContent: m.replyBody }),
            },
          ],
          usage: { kind: 'unavailable' },
        };
      }
      if (request.dialogSelfId === m.rootB) {
        const results = context.filter(
          (message) => message.type === 'tellask_result_msg' && message.callId === m.workCallId,
        );
        assert.equal(results.length, 1);
        const result = results[0];
        assert.ok(result?.type === 'tellask_result_msg' && result.content.includes(m.replyBody));
      } else {
        assert.ok(
          context.some(
            (message) =>
              'content' in message &&
              typeof message.content === 'string' &&
              message.content.includes(m.inputA),
          ),
        );
      }
      return {
        messages: [
          {
            type: 'saying_msg',
            role: 'assistant',
            genseq,
            content: request.dialogSelfId === m.rootA ? m.ackA : m.ackB,
          },
        ],
        usage: { kind: 'unavailable' },
      };
    });
    registerLlmGenerator(generator);
    await reconcileDisplayStatesAfterRestart();
    await recoverPendingReplyDeliveryAfterRestart();
    await recoverOpenGenerationAfterRestart();
    const controller = new AbortController();
    const backend = runBackendDriver({ abortSignal: controller.signal });
    try {
      await waitFor(
        async () => {
          generator.assertNoErrors();
          return (
            [m.rootA, m.rootB, m.sideB].every((id) => counts.get(id) === 1) &&
            [rootA, rootB].every((root) =>
              root.getLoadedDialogTreeSnapshot().every((dialog) => !dialog.isLocked()),
            )
          );
        },
        5000,
        'recovered root/side work and caller continuation to finish without hidden errors',
      );
    } finally {
      controller.abort();
      await backend;
    }
    generator.assertNoErrors();
    const events = (await Promise.all(traces.map((trace) => trace.finish()))).flat();
    assert.deepEqual(
      events.filter((event) => event.type === 'stream_error_evt'),
      [],
    );
    console.log(
      JSON.stringify({
        probe: 'generation-recovered',
        pid: process.pid,
        requests: [...counts.values()].reduce((a, b) => a + b, 0),
      }),
    );
  });
}
// This support module also exports the concrete manifest reader for its parent case.
if (path.resolve(process.argv[1] ?? '') === __filename) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
