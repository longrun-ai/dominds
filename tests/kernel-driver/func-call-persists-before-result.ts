import assert from 'node:assert/strict';

import { dialogEventRegistry } from '../../main/evt-registry';
import { driveDialogStream } from '../../main/llm/kernel-driver';
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
  });

  console.log('kernel-driver func-call-persists-before-result: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver func-call-persists-before-result: FAIL\n${message}`);
  process.exit(1);
});
