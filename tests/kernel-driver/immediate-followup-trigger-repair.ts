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
  hasPendingNextStepTriggers,
  makeUserPrompt,
  waitForAllDialogsUnlocked,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

const TOOL_NAME = 'immediate_followup_trigger_repair_probe';

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} should be an object`);
  assert.notEqual(value, null, `${label} should not be null`);
  assert.equal(Array.isArray(value), false, `${label} should not be an array`);
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    const immediateTool: FuncTool = {
      type: 'func',
      name: TOOL_NAME,
      description: 'Test-only immediate follow-up trigger repair probe.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      argsValidation: 'passthrough',
      async call() {
        return toolSuccess('repair probe result');
      },
    };

    const originalUpsertNextStepTrigger = DialogPersistence.upsertNextStepTrigger;
    let sabotagedTriggerId: string | undefined;
    DialogPersistence.upsertNextStepTrigger = async (dialogId, trigger, status) => {
      await originalUpsertNextStepTrigger.call(DialogPersistence, dialogId, trigger, status);
      if (
        sabotagedTriggerId === undefined &&
        trigger.kind === 'followup' &&
        trigger.triggerId.startsWith('followup:')
      ) {
        sabotagedTriggerId = trigger.triggerId;
        await DialogPersistence.removeNextStepTriggers(
          dialogId,
          (existingTrigger) => existingTrigger.triggerId === trigger.triggerId,
          status,
        );
      }
    };

    let registeredTool = false;
    try {
      registerTool(immediateTool);
      registeredTool = true;
      await writeStandardMinds(tmpRoot, { memberTools: [TOOL_NAME] });
      await writeMockDb(tmpRoot, [
        {
          message: 'Run the repair probe and then keep going.',
          role: 'user',
          response: 'Calling repair probe.',
          funcCalls: [{ id: 'call-repair-probe', name: TOOL_NAME, arguments: {} }],
        },
        {
          message: 'repair probe result',
          role: 'tool',
          response: 'Recovered after repairing the follow-up trigger.',
        },
      ]);

      const dlg = await createMainDialog('tester');
      dlg.disableDiligencePush = true;

      await driveDialogStream(
        dlg,
        makeUserPrompt(
          'Run the repair probe and then keep going.',
          'immediate-followup-trigger-repair',
        ),
        true,
      );

      await waitForAllDialogsUnlocked(dlg, 3_000);

      assert.equal(
        sabotagedTriggerId,
        'followup:c1:g1',
        'test setup should delete the first immediate follow-up trigger write',
      );
      assert.ok(
        dlg.msgs.some(
          (msg) =>
            msg.type === 'saying_msg' &&
            msg.role === 'assistant' &&
            msg.content === 'Recovered after repairing the follow-up trigger.',
        ),
        'expected repair to preserve the immediate follow-up generation',
      );

      const latest = await DialogPersistence.loadDialogLatest(dlg.id, dlg.status);
      assert.ok(latest, 'expected latest dialog state to exist');
      assert.equal(
        hasPendingNextStepTriggers(latest),
        false,
        'repaired immediate follow-up trigger should be consumed by the next generation',
      );

      const debugDir = path.join(tmpRoot, '.dialogs', 'debug');
      const files = await fs.readdir(debugDir);
      const debugFiles = files.filter((file) =>
        file.startsWith('kernel-driver-missing-immediate-followup-trigger-'),
      );
      assert.equal(debugFiles.length, 1, 'expected one repair debug dump');

      const debugFile = debugFiles[0];
      assert.ok(debugFile, 'expected repair debug dump filename');
      const rawPayload = await fs.readFile(path.join(debugDir, debugFile), 'utf8');
      const payload: unknown = JSON.parse(rawPayload);
      assertRecord(payload, 'debug payload');
      assert.equal(payload.kind, 'kernel_driver_missing_immediate_followup_trigger_repaired');
      assert.equal(payload.repairOutcome, 'repaired');
      assert.equal(payload.checkPoint, 'before_immediate_post_tool_generation_continue');
      assert.equal(typeof payload.callstack, 'string');
      assert.match(
        String(payload.callstack),
        /kernel-driver missing immediate followup trigger repaired/u,
      );

      assertRecord(payload.dialog, 'debug payload dialog');
      assert.equal(payload.dialog.rootId, dlg.id.rootId);
      assert.equal(payload.dialog.selfId, dlg.id.selfId);

      assertRecord(payload.expectation, 'debug payload expectation');
      assert.deepEqual(payload.expectation.callIds, ['call-repair-probe']);
      assert.deepEqual(payload.expectation.callNames, [TOOL_NAME]);
    } finally {
      DialogPersistence.upsertNextStepTrigger = originalUpsertNextStepTrigger;
      if (registeredTool) {
        unregisterTool(TOOL_NAME);
      }
    }
  });

  console.log('kernel-driver immediate-followup-trigger-repair: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`kernel-driver immediate-followup-trigger-repair: FAIL\n${message}`);
  process.exit(1);
});
