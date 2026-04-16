/**
 * latest.yaml write-back regression script
 *
 * Purpose: protect invariants of DialogPersistence.mutateDialogLatest():
 * - concurrent patches merge (no lost fields)
 * - mutator callbacks are linearized (no lost increments)
 * - write-back eventually flushes a correct snapshot to disk
 *
 * This script is intentionally small and self-contained; it runs against a temp rtws.
 */

import type { RootDialogMetadataFile } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { DialogID, RootDialog } from '../../main/dialog';
import { DialogPersistence, DiskFileDialogStore } from '../../main/persistence';

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for file: ${filePath}`);
      }
      await sleep(50);
    }
  }
}

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-latest-writeback-'));
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
  await withTempCwd(async (sandboxDir) => {
    const dialogId = new DialogID('61/5a/da8d0169');
    const metadata: RootDialogMetadataFile = {
      id: dialogId.selfId,
      agentId: 'tester',
      taskDocPath: 'plans/latest-writeback.tsk',
      createdAt: formatUnifiedTimestamp(new Date('2026-04-12T00:00:00.000Z')),
    };
    await DialogPersistence.saveRootDialogMetadata(dialogId, metadata, 'running');

    // Invariant 1: concurrent patch mutations must merge (no lost fields).
    await Promise.all([
      DialogPersistence.mutateDialogLatest(dialogId, () => ({
        kind: 'patch',
        patch: { messageCount: 1, status: 'active' },
      })),
      DialogPersistence.mutateDialogLatest(dialogId, () => ({
        kind: 'patch',
        patch: { functionCallCount: 2, status: 'active' },
      })),
    ]);

    const merged = await DialogPersistence.loadDialogLatest(dialogId);
    assert.ok(merged, 'Expected staged latest after mutation');
    assert.equal(merged.status, 'active');
    assert.equal(merged.messageCount, 1);
    assert.equal(merged.functionCallCount, 2);

    // Invariant 2: mutator callbacks observe a linearized previous state.
    // If this regresses, concurrent increments may collapse.
    const increments = 50;
    await Promise.all(
      Array.from({ length: increments }, () =>
        DialogPersistence.mutateDialogLatest(dialogId, (prev) => ({
          kind: 'patch',
          patch: { messageCount: (prev.messageCount ?? 0) + 1 },
        })),
      ),
    );

    const afterIncrements = await DialogPersistence.loadDialogLatest(dialogId);
    assert.ok(afterIncrements, 'Expected staged latest after increments');
    assert.equal(afterIncrements.messageCount, 1 + increments);

    // Invariant 3: write-back eventually flushes a correct snapshot to disk.
    // Wait long enough for at least one write-back cycle to complete.
    const latestPath = path.join(sandboxDir, '.dialogs', 'run', dialogId.selfId, 'latest.yaml');
    await waitForFile(latestPath, 2000);

    const content = await fs.readFile(latestPath, 'utf-8');
    const parsed: unknown = yaml.parse(content);
    assert.equal(typeof parsed, 'object');
    assert.ok(parsed !== null);

    const record = parsed as Record<string, unknown>;
    assert.equal(record['status'], 'active');
    assert.equal(record['messageCount'], 1 + increments);
    assert.equal(record['functionCallCount'], 2);

    // Invariant 4: generating dialogs must not persist a non-running displayState snapshot.
    await DialogPersistence.mutateDialogLatest(dialogId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 3,
        lastModified: formatUnifiedTimestamp(new Date('2026-04-12T00:01:00.000Z')),
        status: 'active',
        generating: true,
        displayState: { kind: 'idle_waiting_user' },
        executionMarker: { kind: 'interrupted', reason: { kind: 'pending_course_start' } },
      },
    }));
    const healedGenerating = await DialogPersistence.loadDialogLatest(dialogId);
    assert.ok(healedGenerating, 'Expected latest after generating/displayState healing');
    assert.equal(healedGenerating.generating, true);
    assert.deepEqual(healedGenerating.displayState, { kind: 'proceeding' });
    assert.equal(healedGenerating.executionMarker, undefined);

    // Invariant 5: dead state must remain louder than the generic generating/proceeding healing.
    await DialogPersistence.mutateDialogLatest(dialogId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 4,
        lastModified: formatUnifiedTimestamp(new Date('2026-04-12T00:02:00.000Z')),
        status: 'active',
        generating: true,
        displayState: { kind: 'dead', reason: { kind: 'declared_by_user' } },
        executionMarker: { kind: 'dead', reason: { kind: 'declared_by_user' } },
      },
    }));
    const preservedDead = await DialogPersistence.loadDialogLatest(dialogId);
    assert.ok(preservedDead, 'Expected latest after dead/generating mismatch write');
    assert.equal(preservedDead.generating, true);
    assert.deepEqual(preservedDead.displayState, {
      kind: 'dead',
      reason: { kind: 'declared_by_user' },
    });
    assert.deepEqual(preservedDead.executionMarker, {
      kind: 'dead',
      reason: { kind: 'declared_by_user' },
    });

    // Invariant 6: clearing a pending course-start prompt must not regress a live generating round
    // back to idle if a newer write has already reasserted proceeding.
    await DialogPersistence.mutateDialogLatest(dialogId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 5,
        lastModified: formatUnifiedTimestamp(new Date('2026-04-12T00:03:00.000Z')),
        status: 'active',
        generating: true,
        displayState: {
          kind: 'stopped',
          reason: { kind: 'pending_course_start' },
          continueEnabled: true,
        },
        executionMarker: { kind: 'interrupted', reason: { kind: 'pending_course_start' } },
        pendingCourseStartPrompt: {
          content: 'resume current round',
          msgId: 'pending-course-start-msg',
          grammar: 'markdown',
          origin: 'runtime',
        },
      },
    }));
    await DialogPersistence.clearPendingCourseStartPrompt(dialogId, 'pending-course-start-msg');
    const clearedPendingCourseStart = await DialogPersistence.loadDialogLatest(dialogId);
    assert.ok(clearedPendingCourseStart, 'Expected latest after clearing pending course-start');
    assert.equal(clearedPendingCourseStart.generating, true);
    assert.deepEqual(clearedPendingCourseStart.displayState, { kind: 'proceeding' });
    assert.equal(clearedPendingCourseStart.pendingCourseStartPrompt, undefined);
    assert.equal(clearedPendingCourseStart.executionMarker, undefined);

    // Invariant 7: startNewCourse during an active generation must only queue the pending prompt;
    // it must not regress the live round into pending_course_start before the generation finishes.
    const activeDialogId = new DialogID('71/6b/eb9d1270');
    const activeMetadata: RootDialogMetadataFile = {
      id: activeDialogId.selfId,
      agentId: 'tester',
      taskDocPath: 'plans/latest-writeback-active-course.tsk',
      createdAt: formatUnifiedTimestamp(new Date('2026-04-12T00:04:00.000Z')),
    };
    await DialogPersistence.saveRootDialogMetadata(activeDialogId, activeMetadata, 'running');
    await DialogPersistence.mutateDialogLatest(activeDialogId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 1,
        lastModified: formatUnifiedTimestamp(new Date('2026-04-12T00:04:01.000Z')),
        status: 'active',
        generating: false,
        displayState: { kind: 'proceeding' },
        messageCount: 0,
        functionCallCount: 0,
        subdialogCount: 0,
        disableDiligencePush: false,
        diligencePushRemainingBudget: 0,
      },
    }));
    const activeStore = new DiskFileDialogStore(activeDialogId);
    const activeDialog = new RootDialog(
      activeStore,
      'plans/latest-writeback-active-course.tsk',
      activeDialogId,
      'tester',
    );
    await activeDialog.notifyGeneratingStart('active-course-msg');
    await activeStore.startNewCourse(activeDialog, {
      content: 'continue in course two after current generation',
      msgId: 'pending-active-course-start-msg',
      grammar: 'markdown',
      origin: 'runtime',
      userLanguageCode: 'en',
    });
    const latestDuringActiveGeneration = await DialogPersistence.loadDialogLatest(activeDialogId);
    assert.ok(
      latestDuringActiveGeneration,
      'Expected latest after queueing a new course during active generation',
    );
    assert.equal(latestDuringActiveGeneration.generating, true);
    assert.deepEqual(latestDuringActiveGeneration.displayState, { kind: 'proceeding' });
    assert.equal(latestDuringActiveGeneration.executionMarker, undefined);
    assert.equal(
      latestDuringActiveGeneration.pendingCourseStartPrompt?.msgId,
      'pending-active-course-start-msg',
    );
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
