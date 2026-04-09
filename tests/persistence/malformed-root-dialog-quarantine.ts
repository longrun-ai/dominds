import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { DialogID } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-malformed-root-dialog-'));
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
    const dialogId = new DialogID('1d/76/67a12c4c');
    const sourceRoot = path.join(sandboxDir, '.dialogs', 'archive', dialogId.selfId);
    const malformedRoot = path.join(sandboxDir, '.dialogs', 'malformed', dialogId.selfId);

    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(
      path.join(sourceRoot, 'dialog.yaml'),
      yaml.stringify({
        id: dialogId.selfId,
        agentId: 'devops',
        taskDocPath: 'tasks/demo.tsk',
        createdAt: '2026/04/10-02:40:29',
      }),
      'utf-8',
    );
    await fs.writeFile(path.join(sourceRoot, 'latest.yaml'), 'currentCourse: nope\n', 'utf-8');

    const initialIds = await DialogPersistence.listDialogs('archived');
    assert.deepEqual(initialIds, [dialogId.selfId]);

    const latest = await DialogPersistence.loadDialogLatest(dialogId, 'archived');
    assert.equal(latest, null, 'malformed root latest should be quarantined and treated as absent');

    await assert.rejects(fs.access(sourceRoot), { code: 'ENOENT' });
    await fs.access(malformedRoot);

    const movedMetadata = await fs.readFile(path.join(malformedRoot, 'dialog.yaml'), 'utf-8');
    assert.match(movedMetadata, /67a12c4c/);

    const idsAfterQuarantine = await DialogPersistence.listDialogs('archived');
    assert.deepEqual(idsAfterQuarantine, []);
    const metaAfterQuarantine = await DialogPersistence.loadRootDialogMetadata(
      dialogId,
      'archived',
    );
    assert.equal(metaAfterQuarantine, null);
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
