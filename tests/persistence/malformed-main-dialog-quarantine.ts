import type { DialogLatestFile } from '@longrun-ai/kernel/types/storage';
import type { DialogsQuarantinedMessage } from '@longrun-ai/kernel/types/wire';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { DialogID } from '../../main/dialog';
import { DialogPersistence, setDialogsQuarantinedBroadcaster } from '../../main/persistence';
import { DomindsPersistenceFileError } from '../../main/persistence-errors';

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-malformed-main-dialog-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn(sandboxDir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function writeYaml(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, yaml.stringify(value), 'utf-8');
}

async function seedMainDialog(args: {
  sandboxDir: string;
  dialogId: DialogID;
  statusDir: 'run' | 'done' | 'archive';
}): Promise<{ sourceRoot: string; malformedRoot: string }> {
  const sourceRoot = path.join(args.sandboxDir, '.dialogs', args.statusDir, args.dialogId.selfId);
  const malformedRoot = path.join(args.sandboxDir, '.dialogs', 'malformed', args.dialogId.selfId);
  await fs.mkdir(sourceRoot, { recursive: true });
  await writeYaml(path.join(sourceRoot, 'dialog.yaml'), {
    id: args.dialogId.selfId,
    agentId: 'devops',
    taskDocPath: 'tasks/demo.tsk',
    createdAt: '2026/04/10-02:40:29',
  });
  return { sourceRoot, malformedRoot };
}

async function assertQuarantined(args: {
  sourceRoot: string;
  malformedRoot: string;
}): Promise<void> {
  await assert.rejects(fs.access(args.sourceRoot), { code: 'ENOENT' });
  await fs.access(args.malformedRoot);
  const movedMetadata = await fs.readFile(path.join(args.malformedRoot, 'dialog.yaml'), 'utf-8');
  assert.match(movedMetadata, /taskDocPath/);
}

async function assertPersistenceFailure(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof DomindsPersistenceFileError,
    'expected DomindsPersistenceFileError',
  );
}

type DialogPersistencePrivate = typeof DialogPersistence & {
  getLatestWriteBackKey(dialogId: DialogID, status: 'running' | 'completed' | 'archived'): string;
  flushLatestWriteBack(key: string): Promise<void>;
  writeDialogLatestToDisk(
    dialogId: DialogID,
    latest: DialogLatestFile,
    status: 'running' | 'completed' | 'archived',
    cancellationToken?: unknown,
  ): Promise<void>;
};

async function main(): Promise<void> {
  await withTempCwd(async (sandboxDir) => {
    let capturedQuarantineMessage: DialogsQuarantinedMessage | null = null;
    setDialogsQuarantinedBroadcaster((msg) => {
      capturedQuarantineMessage = msg;
    });
    try {
      {
        const dialogId = new DialogID('1d/76/67a12c4c');
        const { sourceRoot, malformedRoot } = await seedMainDialog({
          sandboxDir,
          dialogId,
          statusDir: 'archive',
        });
        await fs.writeFile(path.join(sourceRoot, 'latest.yaml'), 'currentCourse: nope\n', 'utf-8');

        const initialIds = await DialogPersistence.listDialogs('archived');
        assert.deepEqual(initialIds, [dialogId.selfId]);

        await assertPersistenceFailure(DialogPersistence.loadDialogLatest(dialogId, 'archived'));
        await assertQuarantined({ sourceRoot, malformedRoot });
        assert.deepEqual(capturedQuarantineMessage, {
          type: 'dialogs_quarantined',
          status: 'quarantining',
          fromStatus: 'archived',
          rootId: dialogId.selfId,
          dialogId: dialogId.selfId,
          reason: 'loadDialogLatest',
          timestamp: capturedQuarantineMessage?.timestamp ?? '',
        });
        assert.match(capturedQuarantineMessage?.timestamp ?? '', /\d{4}/);

        const idsAfterQuarantine = await DialogPersistence.listDialogs('archived');
        assert.deepEqual(idsAfterQuarantine, []);
        const metadataAfterQuarantine = await DialogPersistence.loadMainDialogMetadata(
          dialogId,
          'archived',
        );
        assert.equal(metadataAfterQuarantine, null);
      }

      {
        const dialogId = new DialogID('3e/12/badq4h01');
        const { sourceRoot, malformedRoot } = await seedMainDialog({
          sandboxDir,
          dialogId,
          statusDir: 'run',
        });
        await writeYaml(path.join(sourceRoot, 'q4h.yaml'), {
          questions: [{ id: 123, tellaskContent: 'bad shape' }],
          updatedAt: '2026/04/10-02:40:29',
        });

        await assertPersistenceFailure(
          DialogPersistence.loadQuestions4HumanState(dialogId, 'running'),
        );
        await assertQuarantined({ sourceRoot, malformedRoot });
      }

      {
        const dialogId = new DialogID('7a/55/badreg01');
        const { sourceRoot, malformedRoot } = await seedMainDialog({
          sandboxDir,
          dialogId,
          statusDir: 'run',
        });
        await writeYaml(path.join(sourceRoot, 'registry.yaml'), {
          entries: [{ key: 'slot-1', sideDialogId: 42, agentId: 'builder' }],
        });

        await assertPersistenceFailure(
          DialogPersistence.loadSideDialogRegistry(dialogId, 'running'),
        );
        await assertQuarantined({ sourceRoot, malformedRoot });
      }

      {
        const dialogId = new DialogID('5b/23/mismatch1');
        const { sourceRoot, malformedRoot } = await seedMainDialog({
          sandboxDir,
          dialogId,
          statusDir: 'archive',
        });
        await writeYaml(path.join(sourceRoot, 'dialog.yaml'), {
          id: 'wrong-id',
          agentId: 'devops',
          taskDocPath: 'tasks/demo.tsk',
          createdAt: '2026/04/10-02:40:29',
        });

        const ids = await DialogPersistence.listDialogs('archived');
        assert.deepEqual(ids, []);
        await assertQuarantined({ sourceRoot, malformedRoot });
      }

      {
        const dialogId = new DialogID('6d/77/badresp1');
        const { sourceRoot, malformedRoot } = await seedMainDialog({
          sandboxDir,
          dialogId,
          statusDir: 'run',
        });
        await fs.writeFile(
          path.join(sourceRoot, 'sideDialog-responses.processing.json'),
          JSON.stringify([{ responseId: 1 }]),
          'utf-8',
        );

        await assertPersistenceFailure(
          DialogPersistence.takeSideDialogResponses(dialogId, 'running'),
        );
        await assertQuarantined({ sourceRoot, malformedRoot });
      }

      {
        const dialogId = new DialogID('8e/11/cancel01');
        const { sourceRoot, malformedRoot } = await seedMainDialog({
          sandboxDir,
          dialogId,
          statusDir: 'run',
        });
        const internals = DialogPersistence as unknown as DialogPersistencePrivate;
        const originalWriteDialogLatestToDisk =
          internals.writeDialogLatestToDisk.bind(DialogPersistence);
        let releaseWriteBlock: (() => void) | undefined;
        const writeBlock = new Promise<void>((resolve) => {
          releaseWriteBlock = resolve;
        });
        let signalWriteStarted: (() => void) | undefined;
        const writeStarted = new Promise<void>((resolve) => {
          signalWriteStarted = resolve;
        });

        internals.writeDialogLatestToDisk = async (
          blockedDialogId,
          latest,
          status,
          cancellationToken,
        ): Promise<void> => {
          signalWriteStarted?.();
          await writeBlock;
          return originalWriteDialogLatestToDisk(
            blockedDialogId,
            latest,
            status,
            cancellationToken,
          );
        };

        try {
          await DialogPersistence.mutateDialogLatest(
            dialogId,
            () => ({ kind: 'patch', patch: { needsDrive: true } }),
            'running',
          );
          const latestWriteBackKey = internals.getLatestWriteBackKey(dialogId, 'running');
          const flushPromise = internals.flushLatestWriteBack(latestWriteBackKey);
          await writeStarted;

          await writeYaml(path.join(sourceRoot, 'q4h.yaml'), {
            questions: [{ id: 123, tellaskContent: 'bad shape' }],
            updatedAt: '2026/04/10-02:40:29',
          });
          await assertPersistenceFailure(
            DialogPersistence.loadQuestions4HumanState(dialogId, 'running'),
          );

          releaseWriteBlock?.();
          await flushPromise;
        } finally {
          internals.writeDialogLatestToDisk = originalWriteDialogLatestToDisk;
        }

        await assertQuarantined({ sourceRoot, malformedRoot });
      }
    } finally {
      setDialogsQuarantinedBroadcaster(null);
    }
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
