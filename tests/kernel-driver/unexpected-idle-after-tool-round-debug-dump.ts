import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { DialogPersistence } from '../../main/persistence';
import type { FuncTool } from '../../main/tool';
import { toolSuccess } from '../../main/tool';
import { registerTool, unregisterTool } from '../../main/tools/registry';

import {
  createMainDialog,
  makeDriveOptions,
  makeUserPrompt,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

const TOOL_NAME = 'unexpected_idle_debug_deferred_probe';

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} should be an object`);
  assert.notEqual(value, null, `${label} should not be null`);
  assert.equal(Array.isArray(value), false, `${label} should not be an array`);
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    const deferredTool: FuncTool = {
      type: 'func',
      name: TOOL_NAME,
      description: 'Test-only deferred follow-up probe.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      argsValidation: 'passthrough',
      followupMode: 'deferred',
      async call() {
        return toolSuccess('deferred probe result');
      },
    };

    registerTool(deferredTool);
    try {
      await writeStandardMinds(tmpRoot, { memberTools: [TOOL_NAME] });
      await writeMockDb(tmpRoot, [
        {
          message: 'Run the deferred probe while carrying a business continuation.',
          role: 'user',
          response: 'Calling deferred probe.',
          funcCalls: [{ id: 'call-deferred-debug-probe', name: TOOL_NAME, arguments: {} }],
        },
      ]);

      const dlg = await createMainDialog('tester');
      dlg.disableDiligencePush = true;

      await driveDialogStream(
        dlg,
        makeUserPrompt(
          'Run the deferred probe while carrying a business continuation.',
          'unexpected-idle-debug-probe',
        ),
        true,
        makeDriveOptions({
          suppressDiligencePush: true,
          source: 'kernel_driver_business_continuation',
          reason: 'unexpected_idle_debug_probe',
          businessContinuation: {
            kind: 'requested_work_reply',
            callerDialogId: dlg.id.rootId,
            batchId: 'unexpected-idle-debug-batch',
            callSiteCourse: 1,
            callSiteGenseq: 1,
            sideDialogId: dlg.id.selfId,
            callType: 'B',
            callId: 'unexpected-idle-debug-call',
          },
        }),
      );

      const latest = await DialogPersistence.loadDialogLatest(dlg.id, dlg.status);
      assert.ok(latest, 'expected latest dialog state to exist');
      assert.equal(latest.displayState?.kind, 'idle_waiting_user');
      assert.equal(
        latest.nextStep.triggers.length,
        0,
        'test setup should leave no nextStep trigger',
      );

      const debugDir = path.join(tmpRoot, '.dialogs', 'debug');
      const files = await fs.readdir(debugDir);
      const debugFiles = files.filter((file) =>
        file.startsWith('kernel-driver-unexpected-idle-after-tool-round-'),
      );
      assert.equal(debugFiles.length, 1, 'expected one unexpected-idle debug dump');

      const rawPayload = await fs.readFile(path.join(debugDir, debugFiles[0] ?? ''), 'utf8');
      const payload: unknown = JSON.parse(rawPayload);
      assertRecord(payload, 'debug payload');
      assert.equal(payload.kind, 'kernel_driver_unexpected_idle_after_tool_round');
      assert.equal(typeof payload.callstack, 'string');
      assert.match(String(payload.callstack), /kernel-driver unexpected idle after tool round/u);

      assertRecord(payload.dialog, 'debug payload dialog');
      assert.equal(payload.dialog.rootId, dlg.id.rootId);
      assert.equal(payload.dialog.selfId, dlg.id.selfId);

      assertRecord(payload.diagnostics, 'debug payload diagnostics');
      assert.equal(payload.diagnostics.lastBusinessContinuation.kind, 'requested_work_reply');
      assert.equal(payload.diagnostics.decision.stopReason, 'no_post_tool_continuation');
      assert.deepEqual(payload.diagnostics.callIds, ['call-deferred-debug-probe']);
      assert.deepEqual(payload.diagnostics.callNames, [TOOL_NAME]);

      assertRecord(payload.latest, 'debug payload latest');
      assertRecord(payload.finalDisplayState, 'debug payload finalDisplayState');
      assert.equal(payload.finalDisplayState.kind, 'idle_waiting_user');

      const normalDlg = await createMainDialog('tester');
      normalDlg.disableDiligencePush = true;
      await writeMockDb(tmpRoot, [
        {
          message: 'Run the ordinary deferred probe.',
          role: 'user',
          response: 'Calling ordinary deferred probe.',
          funcCalls: [{ id: 'call-normal-deferred-probe', name: TOOL_NAME, arguments: {} }],
        },
      ]);

      await driveDialogStream(
        normalDlg,
        makeUserPrompt('Run the ordinary deferred probe.', 'ordinary-deferred-probe'),
        true,
        makeDriveOptions({
          suppressDiligencePush: true,
        }),
      );

      const filesAfterNormalDeferred = await fs.readdir(debugDir);
      const debugFilesAfterNormalDeferred = filesAfterNormalDeferred.filter((file) =>
        file.startsWith('kernel-driver-unexpected-idle-after-tool-round-'),
      );
      assert.equal(
        debugFilesAfterNormalDeferred.length,
        1,
        'ordinary deferred tool stops should not emit unexpected-idle dumps',
      );
    } finally {
      unregisterTool(TOOL_NAME);
    }
  });

  console.log('kernel-driver unexpected-idle-after-tool-round-debug-dump: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver unexpected-idle-after-tool-round-debug-dump: FAIL\n${message}`);
  process.exit(1);
});
