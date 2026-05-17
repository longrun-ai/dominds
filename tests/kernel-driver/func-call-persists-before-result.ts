import assert from 'node:assert/strict';

import type { FuncCallRecord } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { MainDialog } from '../../main/dialog';
import { dialogEventRegistry } from '../../main/evt-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
import { executeDriveRound } from '../../main/llm/kernel-driver/flow';
import { createKernelDriverRuntimeState } from '../../main/llm/kernel-driver/types';
import { DialogPersistence } from '../../main/persistence';
import type { FuncTool } from '../../main/tool';
import { toolSuccess } from '../../main/tool';
import { registerTool, unregisterTool } from '../../main/tools/registry';
import {
  createMainDialog,
  makeUserPrompt,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

const TOOL_NAME = 'delayed_func_call_persistence_probe';
const FAST_TOOL_NAME = 'fast_func_call_persistence_probe';
const RECOVERY_TOOL_NAME = 'recovered_unpaired_func_call_probe';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolveFn: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  if (!resolveFn) {
    throw new Error('Deferred initialization failed');
  }
  return { promise, resolve: resolveFn };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    const toolStarted = deferred<void>();
    const fastToolCalled = deferred<void>();
    const releaseTool = deferred<void>();
    const delayedTool: FuncTool = {
      type: 'func',
      name: TOOL_NAME,
      description: 'Test-only delayed function tool.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      argsValidation: 'passthrough',
      async call() {
        toolStarted.resolve();
        await releaseTool.promise;
        return toolSuccess('delayed result');
      },
    };
    const fastTool: FuncTool = {
      type: 'func',
      name: FAST_TOOL_NAME,
      description: 'Test-only immediate function tool.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      argsValidation: 'passthrough',
      async call() {
        fastToolCalled.resolve();
        return toolSuccess('fast result');
      },
    };

    registerTool(delayedTool);
    registerTool(fastTool);
    try {
      await writeStandardMinds(tmpRoot, { memberTools: [TOOL_NAME, FAST_TOOL_NAME] });
      await writeMockDb(tmpRoot, [
        {
          message: 'Call the delayed and fast persistence probe tools.',
          role: 'user',
          response: 'Calling persistence probes.',
          funcCalls: [
            { id: 'call_delayed_probe', name: TOOL_NAME, arguments: {} },
            { id: 'call_fast_probe', name: FAST_TOOL_NAME, arguments: {} },
          ],
        },
        {
          message: 'delayed result',
          role: 'tool',
          response: 'Observed delayed result.',
        },
      ]);

      const dlg = await createMainDialog('tester');
      dlg.disableDiligencePush = true;
      const sub = dialogEventRegistry.createSubChan(dlg.id);
      const funcCallEventPromise = (async () => {
        for await (const event of sub.stream()) {
          if (event.type === 'func_call_requested_evt' && event.funcName === TOOL_NAME) {
            return event;
          }
        }
        throw new Error('dialog event stream ended before func_call_requested_evt');
      })();

      try {
        const drivePromise = driveDialogStream(
          dlg,
          makeUserPrompt(
            'Call the delayed and fast persistence probe tools.',
            'kernel-driver-func-call-persists-before-result',
          ),
          true,
        );

        const funcCallEvent = await withTimeout(
          funcCallEventPromise,
          2_000,
          'func_call_requested_evt',
        );
        assert.equal(funcCallEvent.funcId, 'call_delayed_probe');
        await withTimeout(toolStarted.promise, 2_000, 'delayed tool start');
        await withTimeout(fastToolCalled.promise, 2_000, 'fast tool call');

        const eventsDuringToolRun = await DialogPersistence.loadCourseEvents(dlg.id, 1, 'running');
        assert(
          eventsDuringToolRun.some(
            (event) =>
              event.type === 'func_call_record' &&
              event.id === 'call_delayed_probe' &&
              event.name === TOOL_NAME,
          ),
          'func_call_record must be persisted before the delayed tool result is available',
        );
        assert(
          eventsDuringToolRun.some(
            (event) =>
              event.type === 'func_call_record' &&
              event.id === 'call_fast_probe' &&
              event.name === FAST_TOOL_NAME,
          ),
          'same-round func_call_record entries must all be persisted before tool execution starts',
        );
        assert.equal(
          eventsDuringToolRun.some(
            (event) => event.type === 'func_result_record' && event.id === 'call_delayed_probe',
          ),
          false,
          'func_result_record should not be persisted while the delayed tool is still running',
        );

        releaseTool.resolve();
        await drivePromise;

        const finalEvents = await DialogPersistence.loadCourseEvents(dlg.id, 1, 'running');
        const callIndex = finalEvents.findIndex(
          (event) => event.type === 'func_call_record' && event.id === 'call_delayed_probe',
        );
        const resultIndex = finalEvents.findIndex(
          (event) => event.type === 'func_result_record' && event.id === 'call_delayed_probe',
        );
        const fastCallIndex = finalEvents.findIndex(
          (event) => event.type === 'func_call_record' && event.id === 'call_fast_probe',
        );
        const fastResultIndex = finalEvents.findIndex(
          (event) => event.type === 'func_result_record' && event.id === 'call_fast_probe',
        );
        const firstResultIndex = finalEvents.findIndex(
          (event) =>
            event.type === 'func_result_record' &&
            (event.id === 'call_delayed_probe' || event.id === 'call_fast_probe'),
        );
        assert.ok(callIndex >= 0, 'expected final transcript to include func_call_record');
        assert.ok(fastCallIndex >= 0, 'expected final transcript to include fast func_call_record');
        assert.ok(resultIndex >= 0, 'expected final transcript to include func_result_record');
        assert.ok(
          fastResultIndex >= 0,
          'expected final transcript to include fast func_result_record',
        );
        assert.ok(
          firstResultIndex >= 0,
          'expected final transcript to include func_result_record entries',
        );
        assert.ok(callIndex < resultIndex, 'func_call_record must precede func_result_record');
        assert.ok(
          callIndex < firstResultIndex && fastCallIndex < firstResultIndex,
          'all same-round func_call_record entries must precede the first func_result_record',
        );
      } finally {
        sub.cancel();
      }
    } finally {
      releaseTool.resolve();
      unregisterTool(TOOL_NAME);
      unregisterTool(FAST_TOOL_NAME);
    }

    const recoveryTool: FuncTool = {
      type: 'func',
      name: RECOVERY_TOOL_NAME,
      description: 'Test-only recovered function tool.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      argsValidation: 'passthrough',
      async call() {
        return toolSuccess('recovered result');
      },
    };
    registerTool(recoveryTool);
    try {
      await writeStandardMinds(tmpRoot, { memberTools: [RECOVERY_TOOL_NAME] });
      await writeMockDb(tmpRoot, [
        {
          message: 'Retry after recovered unpaired call.',
          role: 'user',
          contextContains: ['kernel_driver_unpaired_tool_call_recovered'],
          response: 'Retrying recovered probe.',
          funcCalls: [
            { id: 'call_recovered_probe_retry', name: RECOVERY_TOOL_NAME, arguments: {} },
          ],
        },
        {
          message: 'recovered result',
          role: 'tool',
          response: 'Recovered probe complete.',
        },
      ]);

      const recoveryDlg = await createMainDialog('tester');
      recoveryDlg.disableDiligencePush = true;
      const staleCall: FuncCallRecord = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'func_call_record',
        genseq: 1,
        id: 'call_recovered_probe_stale',
        rawId: 'call_recovered_probe_stale',
        effectiveId: 'call_recovered_probe_stale',
        name: RECOVERY_TOOL_NAME,
        rawArgumentsText: '{}',
      };
      await DialogPersistence.appendEvent(recoveryDlg.id, 1, staleCall, recoveryDlg.status);
      const restored = await DialogPersistence.restoreDialog(recoveryDlg.id, recoveryDlg.status);
      assert(restored, 'expected restoreDialog to load stale unpaired call fixture');
      const restoredRecoveryDlg = new MainDialog(
        recoveryDlg.dlgStore,
        recoveryDlg.taskDocPath,
        recoveryDlg.id,
        recoveryDlg.agentId,
        {
          currentCourse: restored.currentCourse,
          messages: restored.messages,
          reminders: restored.reminders,
          contextHealth: restored.contextHealth,
        },
      );
      restoredRecoveryDlg.disableDiligencePush = true;

      await driveDialogStream(
        restoredRecoveryDlg,
        makeUserPrompt(
          'Retry after recovered unpaired call.',
          'kernel-driver-recover-unpaired-func-call',
        ),
        true,
      );

      const recoveredEvents = await DialogPersistence.loadCourseEvents(
        recoveryDlg.id,
        1,
        recoveryDlg.status,
      );
      const syntheticResult = recoveredEvents.find(
        (event) => event.type === 'func_result_record' && event.id === 'call_recovered_probe_stale',
      );
      assert(syntheticResult, 'expected stale unpaired func_call_record to be repaired');
      assert.match(
        syntheticResult.content,
        /kernel_driver_unpaired_tool_call_recovered/,
        'synthetic repair result should be loud in transcript context',
      );
      assert(
        recoveredEvents.some(
          (event) =>
            event.type === 'func_result_record' && event.id === 'call_recovered_probe_retry',
        ),
        'expected drive to continue after repairing stale unpaired call',
      );
    } finally {
      unregisterTool(RECOVERY_TOOL_NAME);
    }

    const abortToolStarted = deferred<void>();
    const releaseAbortTool = deferred<void>();
    const abortingTool: FuncTool = {
      type: 'func',
      name: 'abort_after_persist_probe',
      description: 'Test-only aborting function tool.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      argsValidation: 'passthrough',
      async call() {
        abortToolStarted.resolve();
        await releaseAbortTool.promise;
        return toolSuccess('should not be observed');
      },
    };
    registerTool(abortingTool);
    try {
      await writeStandardMinds(tmpRoot, { memberTools: ['abort_after_persist_probe'] });
      await writeMockDb(tmpRoot, [
        {
          message: 'Abort after persisting the tool call.',
          role: 'user',
          response: 'Calling abort probe.',
          funcCalls: [
            {
              id: 'call_abort_after_persist_probe',
              name: 'abort_after_persist_probe',
              arguments: {},
            },
          ],
        },
      ]);

      const abortDlg = await createMainDialog('tester');
      abortDlg.disableDiligencePush = true;
      const funcCallEventPromise = (async () => {
        const sub = dialogEventRegistry.createSubChan(abortDlg.id);
        try {
          for await (const event of sub.stream()) {
            if (
              event.type === 'func_call_requested_evt' &&
              event.funcId === 'call_abort_after_persist_probe'
            ) {
              return;
            }
          }
        } finally {
          sub.cancel();
        }
      })();
      const drivePromise = executeDriveRound({
        runtime: createKernelDriverRuntimeState(),
        driveArgs: [
          abortDlg,
          makeUserPrompt(
            'Abort after persisting the tool call.',
            'kernel-driver-abort-after-func-call-persist',
          ),
          true,
          { source: 'unspecified', reason: 'kernel_driver_abort_after_func_call_persist_test' },
        ],
        scheduleDrive: () => {},
        driveDialog: async () => {},
      });
      await withTimeout(funcCallEventPromise, 2_000, 'abort probe func_call_requested_evt');
      await withTimeout(abortToolStarted.promise, 2_000, 'abort probe tool start');
      const { requestInterruptDialog } = await import('../../main/dialog-display-state');
      await requestInterruptDialog(abortDlg.id, 'user_stop');
      releaseAbortTool.resolve();
      await drivePromise;

      const abortEvents = await DialogPersistence.loadCourseEvents(abortDlg.id, 1, 'running');
      const abortResult = abortEvents.find(
        (event) =>
          event.type === 'func_result_record' && event.id === 'call_abort_after_persist_probe',
      );
      assert(abortResult, 'interrupted tool call must still persist a paired func_result_record');
      assert.match(
        abortResult.content,
        /interrupted before completion/,
        'interrupted result should say the tool did not complete',
      );
    } finally {
      releaseAbortTool.resolve();
      unregisterTool('abort_after_persist_probe');
    }
  });

  console.log('kernel-driver func-call-persists-before-result: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver func-call-persists-before-result: FAIL\n${message}`);
  process.exit(1);
});
