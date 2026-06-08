import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { MainDialogMetadataFile } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { DialogID, MainDialog } from '../../main/dialog';
import {
  createEmptyDialogNextStepState,
  createEmptyDialogTellaskCallState,
  createEmptyDialogTellaskResultState,
} from '../../main/dialog-latest-state';
import { DialogPersistence, DiskFileDialogStore } from '../../main/persistence';
import { handleWebSocketMessage } from '../../main/server/websocket-handler';
import { materializeReminder } from '../../main/tool';

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-reminders-status-path-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  await withTempCwd(async () => {
    const dialogId = new DialogID('aa/bb/remstatus');
    const metadata: MainDialogMetadataFile = {
      id: dialogId.selfId,
      agentId: 'tester',
      taskDocPath: 'plans/reminders-status-path.tsk',
      createdAt: formatUnifiedTimestamp(new Date('2026-05-29T00:00:00.000Z')),
    };
    await DialogPersistence.saveMainDialogMetadata(dialogId, metadata, 'completed');
    await DialogPersistence.mutateDialogLatest(
      dialogId,
      () => ({
        kind: 'replace',
        next: {
          currentCourse: 1,
          lastModified: formatUnifiedTimestamp(new Date('2026-05-29T00:00:01.000Z')),
          status: 'active',
          nextStep: createEmptyDialogNextStepState(),
          tellaskCalls: createEmptyDialogTellaskCallState(),
          tellaskResults: createEmptyDialogTellaskResultState(),
        },
      }),
      'completed',
    );

    const dialog = new MainDialog(
      new DiskFileDialogStore(dialogId),
      metadata.taskDocPath,
      dialogId,
      metadata.agentId,
    );
    dialog.setPersistenceStatus('completed');
    dialog.reminders.push(
      materializeReminder({
        content: 'Completed dialog reminder',
        scope: 'dialog',
        renderMode: 'markdown',
      }),
    );

    await dialog.processReminderUpdates();

    const completedReminderPath = path.join(
      DialogPersistence.getDialogEventsPath(dialogId, 'completed'),
      'reminders.json',
    );
    const runningReminderPath = path.join(
      DialogPersistence.getDialogEventsPath(dialogId, 'running'),
      'reminders.json',
    );
    assert.equal(await pathExists(completedReminderPath), true);
    assert.equal(await pathExists(runningReminderPath), false);

    const restored = await DialogPersistence.loadReminderState(dialogId, 'completed');
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.content, 'Completed dialog reminder');

    const sent: unknown[] = [];
    const ws = {
      readyState: 1,
      send(message: string) {
        sent.push(JSON.parse(message) as unknown);
      },
    } as unknown as Parameters<typeof handleWebSocketMessage>[0];
    const packet = {
      type: 'display_dialog',
      dialog: {
        selfId: dialogId.selfId,
        rootId: dialogId.rootId,
        status: 'running',
      },
    } as Parameters<typeof handleWebSocketMessage>[1];

    await handleWebSocketMessage(ws, packet);

    const ready = sent.find((message) => isRecord(message) && message['type'] === 'dialog_ready');
    assert.ok(ready, 'stale running display_dialog should resolve to a dialog_ready response');
    assert.ok(isRecord(ready));
    assert.ok(isRecord(ready['dialog']));
    assert.equal(ready['dialog']['status'], 'completed');
    assert.equal(await pathExists(runningReminderPath), false);
  });
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
