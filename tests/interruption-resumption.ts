import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import { DialogID } from '../main/dialog';
import {
  getRunControlCountsSnapshot,
  reconcileDisplayStatesAfterRestart,
  refreshRunControlProjectionFromPersistenceFacts,
} from '../main/dialog-display-state';
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

    // Dialog A: was proceeding when server crashed => becomes stopped (resumable) after reconcile.
    const aRoot = 'dlg-a';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', aRoot, 'dialog.yaml'), { id: aRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', aRoot, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: true,
      displayState: { kind: 'proceeding' },
    });

    // Dialog B: was proceeding, but now has pending Q4H => becomes blocked after reconcile.
    const bRoot = 'dlg-b';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', bRoot, 'dialog.yaml'), { id: bRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', bRoot, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: true,
      displayState: { kind: 'proceeding' },
    });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', bRoot, 'q4h.yaml'), {
      questions: [
        {
          id: 'q1',
          tellaskContent: 'Answer me',
          askedAt: new Date().toISOString(),
          callId: 'call-q1',
          callSiteRef: { course: 1, messageIndex: 0 },
        },
      ],
      updatedAt: new Date().toISOString(),
    });

    // Dialog C: malformed q4h should quarantine only itself instead of aborting the whole rebuild.
    const cRoot = 'dlg-c';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', cRoot, 'dialog.yaml'), { id: cRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', cRoot, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: true,
      displayState: { kind: 'proceeding' },
    });
    await fs.writeFile(
      path.join(tmpRoot, '.dialogs', 'run', cRoot, 'q4h.yaml'),
      'questions: [',
      'utf-8',
    );

    // Dialog D: healthy idle dialog without displayState should still be backfilled after C quarantines.
    const dRoot = 'dlg-d';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', dRoot, 'dialog.yaml'), { id: dRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', dRoot, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: false,
    });

    // Dialog E: stale stopped projection should self-heal to blocked when pending sideDialogs exist.
    const eRoot = 'dlg-e';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', eRoot, 'dialog.yaml'), { id: eRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', eRoot, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: false,
      displayState: {
        kind: 'stopped',
        reason: { kind: 'system_stop', detail: 'upstream failed' },
        continueEnabled: true,
      },
      executionMarker: {
        kind: 'interrupted',
        reason: { kind: 'system_stop', detail: 'upstream failed' },
      },
    });
    await fs.writeFile(
      path.join(tmpRoot, '.dialogs', 'run', eRoot, 'pending-sideDialogs.json'),
      JSON.stringify(
        [
          {
            sideDialogId: 'sub-e',
            createdAt: new Date().toISOString(),
            callName: 'tellask',
            mentionList: ['@worker'],
            tellaskContent: 'Keep going',
            targetAgentId: 'worker',
            callId: 'call-sub-e',
            callingCourse: 1,
            callingGenseq: 1,
            callType: 'B',
            sessionSlug: 'session-e',
          },
        ],
        null,
        2,
      ),
      'utf-8',
    );

    // Dialog F: stale blocked projection should self-heal back to stopped when interruption remains
    // but the underlying blockers are already gone.
    const fRoot = 'dlg-f';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', fRoot, 'dialog.yaml'), { id: fRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', fRoot, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: false,
      displayState: { kind: 'blocked', reason: { kind: 'waiting_for_sideDialogs' } },
      executionMarker: {
        kind: 'interrupted',
        reason: { kind: 'system_stop', detail: 'upstream failed' },
      },
    });

    // Dialog G: a proceeding dialog left behind by restart reconcile becomes a resumable
    // server-restart interruption and should be counted as resumable.
    const gRoot = 'dlg-g';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', gRoot, 'dialog.yaml'), { id: gRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', gRoot, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: false,
      displayState: { kind: 'proceeding' },
    });

    await reconcileDisplayStatesAfterRestart();

    const latestA = await DialogPersistence.loadDialogLatest(new DialogID(aRoot), 'running');
    assert.ok(latestA, 'latest.yaml for dlg-a should exist');
    assert.equal(latestA.generating, false);
    assert.ok(latestA.displayState);
    assert.equal(latestA.displayState.kind, 'stopped');
    assert.equal(latestA.displayState.reason.kind, 'server_restart');
    assert.equal(latestA.displayState.continueEnabled, true);

    const latestB = await DialogPersistence.loadDialogLatest(new DialogID(bRoot), 'running');
    assert.ok(latestB, 'latest.yaml for dlg-b should exist');
    assert.equal(latestB.generating, false);
    assert.ok(latestB.displayState);
    assert.equal(latestB.displayState.kind, 'blocked');
    assert.equal(latestB.displayState.reason.kind, 'needs_human_input');

    assert.equal(await DialogPersistence.loadDialogLatest(new DialogID(cRoot), 'running'), null);
    await fs.access(path.join(tmpRoot, '.dialogs', 'malformed', cRoot));

    const latestD = await DialogPersistence.loadDialogLatest(new DialogID(dRoot), 'running');
    assert.ok(latestD, 'latest.yaml for dlg-d should exist');
    assert.ok(latestD.displayState);
    assert.equal(latestD.displayState.kind, 'idle_waiting_user');

    const countsBeforeManualHealing = await getRunControlCountsSnapshot();
    assert.equal(countsBeforeManualHealing.proceeding, 0);
    assert.equal(countsBeforeManualHealing.resumable, 3);

    const healedE = await refreshRunControlProjectionFromPersistenceFacts(
      new DialogID(eRoot),
      'resume_dialog',
    );
    assert.ok(healedE, 'latest.yaml for dlg-e should exist');
    assert.ok(healedE.displayState);
    assert.equal(healedE.displayState.kind, 'blocked');
    assert.equal(healedE.displayState.reason.kind, 'waiting_for_sideDialogs');
    assert.equal(healedE.executionMarker, undefined);

    const healedF = await refreshRunControlProjectionFromPersistenceFacts(
      new DialogID(fRoot),
      'resume_dialog',
    );
    assert.ok(healedF, 'latest.yaml for dlg-f should exist');
    assert.ok(healedF.displayState);
    assert.equal(healedF.displayState.kind, 'stopped');
    assert.equal(healedF.displayState.reason.kind, 'system_stop');
    assert.equal(healedF.displayState.continueEnabled, true);
    assert.equal(healedF.executionMarker?.kind, 'interrupted');

    const latestG = await DialogPersistence.loadDialogLatest(new DialogID(gRoot), 'running');
    assert.ok(latestG, 'latest.yaml for dlg-g should exist');
    assert.ok(latestG.displayState);
    assert.equal(latestG.displayState.kind, 'stopped');
    assert.equal(latestG.displayState.reason.kind, 'server_restart');
    assert.equal(latestG.executionMarker?.kind, 'interrupted');

    const hRoot = 'dlg-h';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', hRoot, 'dialog.yaml'), { id: hRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', hRoot, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: false,
      displayState: { kind: 'proceeding' },
    });

    const healedH = await refreshRunControlProjectionFromPersistenceFacts(
      new DialogID(hRoot),
      'resume_dialog',
    );
    assert.ok(healedH, 'latest.yaml for dlg-h should exist');
    assert.ok(healedH.displayState);
    assert.equal(healedH.displayState.kind, 'idle_waiting_user');
    assert.equal(healedH.executionMarker, undefined);

    // Let buffered latest.yaml write-backs drain before we restore cwd and remove the temp rtws.
    await new Promise((resolve) => setTimeout(resolve, 700));

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
