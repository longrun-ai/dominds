import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { MainDialogMetadataFile } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { DialogID } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-move-dialog-status-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn(sandboxDir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await withTempCwd(async () => {
    const dialogId = new DialogID('aa/bb/move001');
    const createdAt = formatUnifiedTimestamp(new Date('2026-04-11T00:00:00.000Z'));
    const metadata: MainDialogMetadataFile = {
      id: dialogId.selfId,
      agentId: 'tester',
      taskDocPath: 'plans/move.tsk',
      createdAt,
    };

    await DialogPersistence.saveMainDialogMetadata(dialogId, metadata, 'running');
    await DialogPersistence.saveMainDialogMetadata(dialogId, metadata, 'completed');

    const sourcePath = DialogPersistence.getMainDialogPath(dialogId, 'running');
    const destinationPath = DialogPersistence.getMainDialogPath(dialogId, 'completed');

    await assert.rejects(
      DialogPersistence.moveDialogStatus(dialogId, 'running', 'completed'),
      /destination already exists/i,
    );

    await fs.access(sourcePath);
    await fs.access(destinationPath);
  });
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
