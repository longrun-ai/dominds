import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import { DialogID } from '../main/dialog';
import { reconcileRunStatesAfterRestart } from '../main/dialog-run-state';
import { DialogPersistence } from '../main/persistence';

async function writeYaml(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, yaml.stringify(value), 'utf-8');
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-interrupt-'));

  try {
    process.chdir(tmpRoot);
    DialogPersistence.setWorkspaceRoot(tmpRoot);

    // Dialog A: was proceeding when server crashed => becomes interrupted (resumable) after reconcile.
    const aRoot = 'dlg-a';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', aRoot, 'dialog.yaml'), { id: aRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', aRoot, 'latest.yaml'), {
      currentRound: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: true,
      runState: { kind: 'proceeding' },
    });

    // Dialog B: was proceeding, but now has pending Q4H => becomes blocked after reconcile.
    const bRoot = 'dlg-b';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', bRoot, 'dialog.yaml'), { id: bRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', bRoot, 'latest.yaml'), {
      currentRound: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: true,
      runState: { kind: 'proceeding' },
    });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', bRoot, 'q4h.yaml'), {
      questions: [
        {
          id: 'q1',
          headLine: 'Need input',
          bodyContent: 'Answer me',
          askedAt: new Date().toISOString(),
          callSiteRef: { round: 1, messageIndex: 0 },
        },
      ],
      updatedAt: new Date().toISOString(),
    });

    await reconcileRunStatesAfterRestart();

    const latestA = await DialogPersistence.loadDialogLatest(new DialogID(aRoot), 'running');
    assert.ok(latestA, 'latest.yaml for dlg-a should exist');
    assert.equal(latestA.generating, false);
    assert.ok(latestA.runState);
    assert.equal(latestA.runState.kind, 'interrupted');
    assert.equal(latestA.runState.reason.kind, 'server_restart');

    const latestB = await DialogPersistence.loadDialogLatest(new DialogID(bRoot), 'running');
    assert.ok(latestB, 'latest.yaml for dlg-b should exist');
    assert.equal(latestB.generating, false);
    assert.ok(latestB.runState);
    assert.equal(latestB.runState.kind, 'blocked');
    assert.equal(latestB.runState.reason.kind, 'needs_human_input');

    console.log('✅ interruption-resumption reconcile smoke test passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('❌ interruption-resumption test failed', err);
  process.exit(1);
});
