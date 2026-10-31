import type { DialogLatestFile } from '@longrun-ai/kernel/types/storage';
import { toDialogCourseNumber } from '@longrun-ai/kernel/types/storage';
import type { DialogsQuarantinedMessage } from '@longrun-ai/kernel/types/wire';
import assert from 'node:assert/strict';
import * as fsNode from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { DialogID, MainDialog } from '../../main/dialog';
import {
  DialogPersistence,
  DiskFileDialogStore,
  setDialogsQuarantinedBroadcaster,
} from '../../main/persistence';
import {
  DomindsPersistenceFileError,
  type DomindsPersistenceFileSource,
} from '../../main/persistence-errors';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { withTempRtws } from '../kernel-driver/helpers';

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
  await fs.writeFile(path.join(sourceRoot, 'forensic-data.bin'), Buffer.from([0, 1, 2, 255]));
  return { sourceRoot, malformedRoot };
}

async function assertQuarantined(args: {
  sourceRoot: string;
  malformedRoot: string;
}): Promise<void> {
  await assert.rejects(fs.access(args.sourceRoot), { code: 'ENOENT' });
  await fs.access(args.malformedRoot);
  const movedMetadata = await fs.readFile(path.join(args.malformedRoot, 'dialog.yaml'), 'utf-8');
  const metadata: unknown = yaml.parse(movedMetadata);
  assert.ok(isRecord(metadata));
  assert.equal(metadata.taskDocPath, 'tasks/demo.tsk');
  assert.equal(metadata.agentId, 'devops');
  assert.equal(metadata.createdAt, '2026/04/10-02:40:29');
  assert.deepEqual(
    await fs.readFile(path.join(args.malformedRoot, 'forensic-data.bin')),
    Buffer.from([0, 1, 2, 255]),
  );
}

async function assertPersistenceFailure(
  promise: Promise<unknown>,
  source: DomindsPersistenceFileSource,
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => {
      assert.ok(error instanceof DomindsPersistenceFileError);
      assert.equal(error.source, source);
      return true;
    },
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
        tellaskContent: 'registry-restore-input-data',
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
        tellaskContent: 'registry-restore-input-data',
      },
    })}\n`,
    'utf-8',
  );
  await fs.writeFile(path.join(sideRoot, 'course-001.jsonl'), '', 'utf-8');
}

const evidence = semanticEvidenceCollector('dominds-quarantine-diagnostics-');
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function expectWritableAfterFailedMove(
  dialogId: DialogID,
  sourceRoot: string,
): Promise<void> {
  await seedLatestYaml(sourceRoot, dialogId);
  const state = await DialogPersistence.mutateDialogLatest(dialogId, () => ({
    kind: 'patch',
    patch: { messageCount: 17 },
  }));
  assert.equal(state.messageCount, 17);
}

async function main(): Promise<void> {
  await withTempRtws(async (sandboxDir) => {
    const capturedQuarantineMessage: { value: DialogsQuarantinedMessage | null } = { value: null };
    setDialogsQuarantinedBroadcaster((msg) => {
      capturedQuarantineMessage.value = msg;
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

        await assertPersistenceFailure(
          DialogPersistence.loadDialogLatest(dialogId, 'archived'),
          'dialog_latest',
        );
        await assertQuarantined({ sourceRoot, malformedRoot });
        assert.equal(
          await fs.readFile(path.join(malformedRoot, 'latest.yaml'), 'utf8'),
          'currentCourse: nope\n',
        );
        assert.ok(capturedQuarantineMessage.value);
        assert.deepEqual(capturedQuarantineMessage.value, {
          type: 'dialogs_quarantined',
          status: 'quarantining',
          fromStatus: 'archived',
          rootId: dialogId.selfId,
          dialogId: dialogId.selfId,
          reason: 'loadDialogLatest',
          timestamp: capturedQuarantineMessage.value.timestamp,
        });
        assert.equal(typeof capturedQuarantineMessage.value.timestamp, 'string');
        assert.ok(Number.isFinite(Date.parse(capturedQuarantineMessage.value.timestamp)));

        const idsAfterQuarantine = await DialogPersistence.listDialogs('archived');
        assert.deepEqual(idsAfterQuarantine, []);
        const metadataAfterQuarantine = await DialogPersistence.loadMainDialogMetadata(
          dialogId,
          'archived',
        );
        assert.equal(metadataAfterQuarantine, null);
      }

      {
        capturedQuarantineMessage.value = null;
        const dialogId = new DialogID('2b/19/rename01');
        const { sourceRoot, malformedRoot } = await seedMainDialog({
          sandboxDir,
          dialogId,
          statusDir: 'run',
        });
        await fs.writeFile(path.join(sourceRoot, 'latest.yaml'), 'currentCourse: nope\n', 'utf-8');

        const originalRename = fsNode.promises.rename;
        let singleRenameAttempts = 0;
        const eperm = new Error('simulated Windows rename lock') as Error & { code: string };
        eperm.code = 'EPERM';
        fsNode.promises.rename = async (source, destination): Promise<void> => {
          if (source === sourceRoot) {
            singleRenameAttempts += 1;
            throw eperm;
          }
          return originalRename(source, destination);
        };

        let latestError: unknown;
        try {
          latestError = await DialogPersistence.loadDialogLatest(dialogId, 'running').then(
            () => null,
            (error: unknown) => error,
          );
        } finally {
          fsNode.promises.rename = originalRename;
        }
        assert.ok(latestError instanceof DomindsPersistenceFileError);

        await fs.access(sourceRoot);
        await assert.rejects(fs.access(malformedRoot), { code: 'ENOENT' });
        assert.equal(
          capturedQuarantineMessage.value,
          null,
          'quarantine broadcast must only fire after the malformed dialog is actually moved',
        );
        const attemptsPerMove = singleRenameAttempts;
        assert.ok(attemptsPerMove > 0);
        await expectWritableAfterFailedMove(dialogId, sourceRoot);
        let runtimeError = '';
        fsNode.promises.rename = async (source, destination): Promise<void> => {
          if (source === sourceRoot) {
            singleRenameAttempts += 1;
            throw eperm;
          }
          return originalRename(source, destination);
        };
        try {
          await assert.rejects(
            DialogPersistence.quarantineMalformedRuntimeState(
              dialogId,
              'running',
              'test_runtime_state_quarantine_rename_failure',
              'runtime state quarantine should fail loudly when the malformed directory cannot move',
            ),
            (error: unknown) => {
              assert.ok(error instanceof Error);
              runtimeError = error.message;
              return true;
            },
          );
        } finally {
          fsNode.promises.rename = originalRename;
        }
        await fs.access(sourceRoot);
        assert.equal(
          capturedQuarantineMessage.value,
          null,
          'runtime-state quarantine failure must not broadcast a quarantine that did not move',
        );
        await expectWritableAfterFailedMove(dialogId, sourceRoot);

        capturedQuarantineMessage.value = null;
        const concurrentDialogId = new DialogID('2b/19/rename02');
        const { sourceRoot: concurrentSourceRoot, malformedRoot: concurrentMalformedRoot } =
          await seedMainDialog({
            sandboxDir,
            dialogId: concurrentDialogId,
            statusDir: 'run',
          });
        await fs.writeFile(
          path.join(concurrentSourceRoot, 'latest.yaml'),
          'currentCourse: nope\n',
          'utf-8',
        );

        let releaseRename: (() => void) | undefined;
        const renameMayFinish = new Promise<void>((resolve) => {
          releaseRename = resolve;
        });
        let signalRenameStarted: (() => void) | undefined;
        const renameStarted = new Promise<void>((resolve) => {
          signalRenameStarted = resolve;
        });
        let concurrentRenameAttempts = 0;
        fsNode.promises.rename = async (source, destination): Promise<void> => {
          if (source === concurrentSourceRoot) {
            concurrentRenameAttempts += 1;
            signalRenameStarted?.();
            await renameMayFinish;
            throw eperm;
          }
          return originalRename(source, destination);
        };
        let concurrentError = '';
        try {
          const latestPromise = DialogPersistence.loadDialogLatest(
            concurrentDialogId,
            'running',
          ).then(
            () => null,
            (error: unknown) => error,
          );
          await renameStarted;
          const runtimeQuarantinePromise = DialogPersistence.quarantineMalformedRuntimeState(
            concurrentDialogId,
            'running',
            'test_concurrent_runtime_state_quarantine_rename_failure',
            'concurrent runtime state quarantine should observe the active quarantine result',
          ).then(
            () => null,
            (error: unknown) => error,
          );

          releaseRename?.();
          const latestConcurrentError = await latestPromise;
          const runtimeConcurrentError = await runtimeQuarantinePromise;
          assert.ok(latestConcurrentError instanceof DomindsPersistenceFileError);
          assert.ok(runtimeConcurrentError instanceof Error);
          concurrentError = runtimeConcurrentError.message;
        } finally {
          releaseRename?.();
          fsNode.promises.rename = originalRename;
        }
        await fs.access(concurrentSourceRoot);
        await assert.rejects(fs.access(concurrentMalformedRoot), { code: 'ENOENT' });
        assert.equal(
          capturedQuarantineMessage.value,
          null,
          'concurrent quarantine failure must not broadcast a quarantine that did not move',
        );
        assert.equal(
          concurrentRenameAttempts,
          attemptsPerMove,
          'concurrent callers share one failed move, including the same retry behavior',
        );
        await expectWritableAfterFailedMove(concurrentDialogId, concurrentSourceRoot);
        evidence.record({
          id: 'failed-moves',
          scenario:
            'A malformed-state read and explicit runtime quarantine encounter an injected EPERM at the actual directory rename. Source directories remain, no quarantine broadcast occurs, and repaired latest state can be mutated. Concurrent callers share the same failed move.',
          businessValue:
            'Explain a failed quarantine without claiming that data moved, and keep recovery possible after filesystem contention.',
          context: {
            sourceDirectoriesRetained: true,
            noQuarantineBroadcast: true,
            subsequentMutationSucceeded: true,
            concurrentCallersSharedMove: true,
            scope:
              'Real persistence with faults only on selected filesystem renames; not actual Windows behavior or full driver restart.',
          },
          reviewQuestions: [
            'Do the actual errors distinguish malformed data from a failed quarantine move without falsely reporting that quarantine succeeded?',
          ],
          actualText: JSON.stringify(
            {
              malformedRead:
                latestError instanceof Error ? latestError.message : String(latestError),
              runtime: runtimeError,
              concurrent: concurrentError,
            },
            null,
            2,
          ),
        });
      }

      {
        capturedQuarantineMessage.value = null;
        const transientRootDialogId = new DialogID('2b/19/transient01');
        await seedMainDialog({
          sandboxDir,
          dialogId: transientRootDialogId,
          statusDir: 'run',
        });
        const originalReaddir = fsNode.promises.readdir.bind(fsNode.promises);
        let remainingTransientFailures = 3;
        const transientEnoent = new Error('simulated disappearing directory') as Error & {
          code: string;
        };
        transientEnoent.code = 'ENOENT';
        fsNode.promises.readdir = (async (...args: Parameters<typeof fsNode.promises.readdir>) => {
          if (remainingTransientFailures > 0) {
            remainingTransientFailures -= 1;
            throw transientEnoent;
          }
          return await originalReaddir(...args);
        }) as typeof fsNode.promises.readdir;
        try {
          assert.deepEqual(await DialogPersistence.listDialogs('running'), []);
          assert.deepEqual(await DialogPersistence.listMainDialogIds('running'), []);
          assert.deepEqual(await DialogPersistence.listAllDialogIds('running'), []);
        } finally {
          fsNode.promises.readdir = originalReaddir as typeof fsNode.promises.readdir;
        }
        assert.equal(
          capturedQuarantineMessage.value,
          null,
          'transient ENOENT during directory scans must not quarantine dialogs',
        );
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
          'questions4human_state',
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
          'sideDialog_registry',
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
        const movedMetadata: unknown = yaml.parse(
          await fs.readFile(path.join(malformedRoot, 'dialog.yaml'), 'utf8'),
        );
        assert.ok(isRecord(movedMetadata));
        assert.equal(movedMetadata.id, 'wrong-id');
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
          'sideDialog_responses',
        );
        await assertQuarantined({ sourceRoot, malformedRoot });
      }

      const registryRestoreFixtures: readonly {
        dialogId: DialogID;
        status: 'running' | 'completed';
        statusDir: 'run' | 'done';
      }[] = [
        { dialogId: new DialogID('4c/61/cycle01'), status: 'running' as const, statusDir: 'run' },
        {
          dialogId: new DialogID('4c/61/cycledone'),
          status: 'completed' as const,
          statusDir: 'done',
        },
      ];
      for (const fixture of registryRestoreFixtures) {
        const dialogId = fixture.dialogId;
        const { sourceRoot } = await seedMainDialog({
          sandboxDir,
          dialogId,
          statusDir: fixture.statusDir,
        });
        await seedLatestYaml(sourceRoot, dialogId, fixture.status);
        const healthySelfId = `${dialogId.selfId}-healthy`;
        const healthyEntry = {
          key: 'tester!healthy',
          sideDialogId: healthySelfId,
          agentId: 'tester',
          sessionSlug: 'healthy',
        };
        await seedSideDialogWithAsker({
          rootPath: sourceRoot,
          selfId: healthySelfId,
          agentId: 'tester',
          sessionSlug: 'healthy',
          askerDialogId: dialogId.selfId,
          callId: 'healthy-call',
        });
        await writeYaml(path.join(sourceRoot, 'registry.yaml'), {
          entries: [
            healthyEntry,
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
          mainDialog.getRegisteredSideDialogs().map((dialog) => dialog.id.selfId),
          [healthySelfId],
          'cyclic Type-B entries should not prevent the root from loading',
        );
        const prunedRegistry = yaml.parse(
          await fs.readFile(path.join(sourceRoot, 'registry.yaml'), 'utf-8'),
        ) as { entries?: unknown[] };
        assert.deepEqual(prunedRegistry.entries, [healthyEntry]);
        assert.equal(mainDialog.lookupDialog('4c/61/cycle-a'), undefined);
        assert.equal(mainDialog.lookupDialog('4c/61/cycle-b'), undefined);
        assert.equal(mainDialog.lookupSideDialog('tester', 'healthy')?.id.selfId, healthySelfId);
      }

      {
        const dialogId = new DialogID('4c/61/mismatchreg');
        const { sourceRoot } = await seedMainDialog({
          sandboxDir,
          dialogId,
          statusDir: 'run',
        });
        await seedLatestYaml(sourceRoot, dialogId);
        const healthySelfId = `${dialogId.selfId}-healthy`;
        const healthyEntry = {
          key: 'tester!healthy',
          sideDialogId: healthySelfId,
          agentId: 'tester',
          sessionSlug: 'healthy',
        };
        await seedSideDialogWithAsker({
          rootPath: sourceRoot,
          selfId: healthySelfId,
          agentId: 'tester',
          sessionSlug: 'healthy',
          askerDialogId: dialogId.selfId,
          callId: 'healthy-call',
        });
        await writeYaml(path.join(sourceRoot, 'registry.yaml'), {
          entries: [
            healthyEntry,
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
          mainDialog.getRegisteredSideDialogs().map((dialog) => dialog.id.selfId),
          [healthySelfId],
          'mismatched Type-B entries should not leave partially registered sideDialogs',
        );
        const prunedRegistry = yaml.parse(
          await fs.readFile(path.join(sourceRoot, 'registry.yaml'), 'utf-8'),
        ) as { entries?: unknown[] };
        assert.deepEqual(prunedRegistry.entries, [healthyEntry]);
        assert.equal(mainDialog.lookupDialog('4c/61/mismatched-side'), undefined);
        assert.equal(mainDialog.lookupSideDialog('builder', 'actual-session'), undefined);
        assert.equal(mainDialog.lookupSideDialog('tester', 'healthy')?.id.selfId, healthySelfId);
      }

      {
        const dialogId = new DialogID('8e/11/cancel01');
        const { sourceRoot, malformedRoot } = await seedMainDialog({
          sandboxDir,
          dialogId,
          statusDir: 'run',
        });
        await seedLatestYaml(sourceRoot, dialogId);
        const originalWrite = fsNode.promises.writeFile;
        let releaseWriteBlock: (() => void) | undefined;
        const writeBlock = new Promise<void>((resolve) => {
          releaseWriteBlock = resolve;
        });
        let signalWriteStarted: (() => void) | undefined;
        const writeStarted = new Promise<void>((resolve) => {
          signalWriteStarted = resolve;
        });
        let signalWriteSettled: (() => void) | undefined;
        const writeSettled = new Promise<void>((resolve) => {
          signalWriteSettled = resolve;
        });
        fsNode.promises.writeFile = async (file, data, options): Promise<void> => {
          let payload: unknown;
          if (
            typeof file === 'string' &&
            path.dirname(file) === sourceRoot &&
            typeof data === 'string'
          ) {
            try {
              payload = yaml.parse(data);
            } catch {
              /* Other formats are outside this controlled write. */
            }
          }
          const nextStep = isRecord(payload) ? payload.nextStep : undefined;
          const targetsBlockedPrompt =
            isRecord(nextStep) &&
            Array.isArray(nextStep.triggers) &&
            nextStep.triggers.some(
              (trigger: unknown) =>
                isRecord(trigger) && trigger.triggerId === 'queued-prompt:test_writeback_blocker',
            );
          if (!targetsBlockedPrompt) return originalWrite(file, data, options);
          signalWriteStarted?.();
          await writeBlock;
          try {
            return await originalWrite(file, data, options);
          } finally {
            signalWriteSettled?.();
          }
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
          await writeStarted;

          await writeYaml(path.join(sourceRoot, 'q4h.yaml'), {
            questions: [{ id: 123, tellaskContent: 'bad shape' }],
            updatedAt: '2026/04/10-02:40:29',
          });
          await assertPersistenceFailure(
            DialogPersistence.loadQuestions4HumanState(dialogId, 'running'),
            'questions4human_state',
          );

          releaseWriteBlock?.();
          await writeSettled;
        } finally {
          releaseWriteBlock?.();
          fsNode.promises.writeFile = originalWrite;
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

        let missingLatestError = '';
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
          (error: unknown) => {
            assert.ok(error instanceof Error);
            missingLatestError = error.message;
            return true;
          },
        );
        await assertQuarantined({ sourceRoot, malformedRoot });
        evidence.record({
          id: 'missing-latest',
          scenario:
            'A noninitial next-step update has metadata but no latest snapshot. It is refused and the original dialog is moved to malformed storage.',
          businessValue:
            'Avoid inventing replacement runtime state when a durable continuation snapshot is missing, while explaining the failed update.',
          context: {
            sourceDirectoryGone: true,
            metadataRetainedInMalformed: true,
            missingLatestSnapshot: true,
            scope: 'Direct public persistence operation on real disk, not a live driver recovery.',
          },
          reviewQuestions: [
            'Does the actual diagnostic identify the missing initial latest state and the refused mutation without claiming a successful new continuation?',
          ],
          actualText: missingLatestError,
        });
      }
    } finally {
      setDialogsQuarantinedBroadcaster(null);
    }
  });
  await evidence.write();
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
