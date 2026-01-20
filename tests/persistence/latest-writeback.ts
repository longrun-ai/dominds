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

import { DialogID } from 'dominds/dialog';
import { DialogPersistence } from 'dominds/persistence';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';

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
