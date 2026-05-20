import type { DialogLatestFile } from '@longrun-ai/kernel/types/storage';
import { toDialogCourseNumber } from '@longrun-ai/kernel/types/storage';
import type { DialogsQuarantinedMessage } from '@longrun-ai/kernel/types/wire';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { DialogID, MainDialog } from '../../main/dialog';
import {
  DialogPersistence,
  DiskFileDialogStore,
  setDialogsQuarantinedBroadcaster,
} from '../../main/persistence';
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

async function seedLatestYaml(
  sourceRoot: string,
  dialogId: DialogID,
  status: 'running' | 'completed' | 'archived' = 'running',
): Promise<void> {
  await writeYaml(path.join(sourceRoot, 'latest.yaml'), {
    currentCourse: 1,
    lastModified: '2026/04/10-02:40:29',
    status: 'active',
    nextStep: {
      nextSeq: 1,
      triggers: [],
    },
    tellaskCalls: {
      calls: [],
    },
    tellaskResults: {
      results: [],
    },
    displayState: {
      kind: 'idle_waiting_user',
    },
  } satisfies DialogLatestFile);
  const loaded = await DialogPersistence.loadDialogLatest(dialogId, status);
  assert.ok(loaded, 'seeded latest.yaml should be valid');
}

async function seedSideDialogWithAsker(args: {
  rootPath: string;
  selfId: string;
  agentId: string;
  sessionSlug: string;
  askerDialogId: string;
  callId: string;
}): Promise<void> {
  const sideRoot = path.join(args.rootPath, 'sideDialogs', args.selfId);
  await writeYaml(path.join(sideRoot, 'dialog.yaml'), {
    id: args.selfId,
    agentId: args.agentId,
    taskDocPath: 'tasks/side.tsk',
    createdAt: '2026/04/10-02:40:29',
    sessionSlug: args.sessionSlug,
  });
  await writeYaml(path.join(sideRoot, 'latest.yaml'), {
    currentCourse: 1,
    lastModified: '2026/04/10-02:40:29',
    status: 'active',
    nextStep: { nextSeq: 1, triggers: [] },
    tellaskCalls: { calls: [] },
    tellaskResults: { results: [] },
    displayState: { kind: 'idle_waiting_user' },
  } satisfies DialogLatestFile);
  await fs.writeFile(
    path.join(sideRoot, 'asker-stack.jsonl'),
    `${JSON.stringify({
      kind: 'asker_dialog_stack_frame',
      askerDialogId: args.askerDialogId,
      assignmentFromAsker: {
        callName: 'tellask',
        mentionList: [`@${args.agentId}`],
        tellaskContent: 'cyclic registry restore fixture',
        originMemberId: args.agentId,
        askerDialogId: args.askerDialogId,
        callId: args.callId,
        callSiteCourse: 1,
        callSiteGenseq: 1,
        collectiveTargets: [args.agentId],
      },
      tellaskReplyObligation: {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: args.askerDialogId,
        targetCallId: args.callId,
        tellaskContent: 'cyclic registry restore fixture',
      },
    })}\n`,
    'utf-8',
  );
  await fs.writeFile(path.join(sideRoot, 'course-001.jsonl'), '', 'utf-8');
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

      for (const fixture of [
        { dialogId: new DialogID('4c/61/cycle01'), status: 'running' as const, statusDir: 'run' },
        {
          dialogId: new DialogID('4c/61/cycledone'),
          status: 'completed' as const,
          statusDir: 'done',
        },
      ]) {
        const dialogId = fixture.dialogId;
        const { sourceRoot } = await seedMainDialog({
          sandboxDir,
          dialogId,
          statusDir: fixture.statusDir,
        });
        await seedLatestYaml(sourceRoot, dialogId, fixture.status);
        await writeYaml(path.join(sourceRoot, 'registry.yaml'), {
          entries: [
            {
              key: 'builder!cycle-a',
              sideDialogId: '4c/61/cycle-a',
              agentId: 'builder',
              sessionSlug: 'cycle-a',
            },
            {
              key: 'mentor!cycle-b',
              sideDialogId: '4c/61/cycle-b',
              agentId: 'mentor',
              sessionSlug: 'cycle-b',
            },
          ],
        });
        await seedSideDialogWithAsker({
          rootPath: sourceRoot,
          selfId: '4c/61/cycle-a',
          agentId: 'builder',
          sessionSlug: 'cycle-a',
          askerDialogId: '4c/61/cycle-b',
          callId: 'tool_cycle_a',
        });
        await seedSideDialogWithAsker({
          rootPath: sourceRoot,
          selfId: '4c/61/cycle-b',
          agentId: 'mentor',
          sessionSlug: 'cycle-b',
          askerDialogId: '4c/61/cycle-a',
          callId: 'tool_cycle_b',
        });

        const mainDialog = new MainDialog(
          new DiskFileDialogStore(dialogId),
          'tasks/demo.tsk',
          dialogId,
          'devops',
        );
        mainDialog.setPersistenceStatus(fixture.status);
        await mainDialog.loadSideDialogRegistry();
        assert.deepEqual(
          mainDialog.getRegisteredSideDialogs(),
          [],
          'cyclic Type-B entries should not prevent the root from loading',
        );
        const prunedRegistry = yaml.parse(
          await fs.readFile(path.join(sourceRoot, 'registry.yaml'), 'utf-8'),
        ) as { entries?: unknown[] };
        assert.deepEqual(prunedRegistry.entries, []);
      }

      {
        const dialogId = new DialogID('4c/61/mismatchreg');
        const { sourceRoot } = await seedMainDialog({
          sandboxDir,
          dialogId,
          statusDir: 'run',
        });
        await seedLatestYaml(sourceRoot, dialogId);
        await writeYaml(path.join(sourceRoot, 'registry.yaml'), {
          entries: [
            {
              key: 'builder!expected-session',
              sideDialogId: '4c/61/mismatched-side',
              agentId: 'builder',
              sessionSlug: 'expected-session',
            },
          ],
        });
        await seedSideDialogWithAsker({
          rootPath: sourceRoot,
          selfId: '4c/61/mismatched-side',
          agentId: 'builder',
          sessionSlug: 'actual-session',
          askerDialogId: dialogId.selfId,
          callId: 'tool_mismatched_registry',
        });

        const mainDialog = new MainDialog(
          new DiskFileDialogStore(dialogId),
          'tasks/demo.tsk',
          dialogId,
          'devops',
        );
        await mainDialog.loadSideDialogRegistry();
        assert.deepEqual(
          mainDialog.getRegisteredSideDialogs(),
          [],
          'mismatched Type-B entries should not leave partially registered sideDialogs',
        );
        const prunedRegistry = yaml.parse(
          await fs.readFile(path.join(sourceRoot, 'registry.yaml'), 'utf-8'),
        ) as { entries?: unknown[] };
        assert.deepEqual(prunedRegistry.entries, []);
      }

      {
        const dialogId = new DialogID('8e/11/cancel01');
        const { sourceRoot, malformedRoot } = await seedMainDialog({
          sandboxDir,
          dialogId,
          statusDir: 'run',
        });
        await seedLatestYaml(sourceRoot, dialogId);
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
            () => ({
              kind: 'patch',
              patch: {
                nextStep: {
                  nextSeq: 2,
                  triggers: [
                    {
                      triggerId: 'queued-prompt:test_writeback_blocker',
                      kind: 'queued_prompt',
                      promptId: 'test_writeback_blocker',
                      course: toDialogCourseNumber(1),
                      createdAt: new Date().toISOString(),
                      seq: 1,
                    },
                  ],
                },
                tellaskCalls: {
                  calls: [],
                },
                tellaskResults: {
                  results: [],
                },
              },
            }),
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

      {
        const dialogId = new DialogID('9f/22/missinglatest01');
        const { sourceRoot, malformedRoot } = await seedMainDialog({
          sandboxDir,
          dialogId,
          statusDir: 'run',
        });

        await assert.rejects(
          DialogPersistence.upsertNextStepTrigger(
            dialogId,
            {
              triggerId: 'queued-prompt:test_missing_latest_patch_quarantine',
              kind: 'queued_prompt',
              promptId: 'test_missing_latest_patch_quarantine',
              course: toDialogCourseNumber(1),
            },
            'running',
          ),
          /Missing latest\.yaml for non-initial latest mutation/,
        );
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
