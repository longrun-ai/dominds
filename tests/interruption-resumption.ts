import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import { installRecordingGlobalDialogEventBroadcaster } from '../main/bootstrap/global-dialog-event-broadcaster';
import { DialogID } from '../main/dialog';
import {
  reconcileDisplayStatesAfterRestart,
  refreshRunControlProjectionFromPersistenceFacts,
} from '../main/dialog-display-state';
import { globalDialogRegistry } from '../main/dialog-global-registry';
import { driveDialogStream } from '../main/llm/kernel-driver';
import { runBackendDriver } from '../main/llm/kernel-driver/loop';
import { DialogPersistence } from '../main/persistence';
import { recoverProceedingDrivesAfterRestart } from '../main/recovery/proceeding-drive';
import { formatAssignmentFromAskerDialog } from '../main/runtime/inter-dialog-format';
import { getWorkLanguage } from '../main/runtime/work-language';
import {
  createMainDialog,
  lastAssistantSaying,
  makeDriveOptions,
  makeUserPrompt,
  waitFor,
  waitForAllDialogsUnlocked,
  wrapPromptWithExpectedReplyTool,
  writeMockDb,
  writeStandardMinds,
} from './kernel-driver/helpers';

async function writeYaml(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, yaml.stringify(value), 'utf-8');
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-interrupt-'));

  try {
    process.chdir(tmpRoot);
    installRecordingGlobalDialogEventBroadcaster({ label: 'interruption-resumption' });
    await writeStandardMinds(tmpRoot, { includePangu: true });

    // Dialog A: was actively generating when server crashed => remains proceeding and is queued
    // for automatic backend drive after restart.
    const rootA = await createMainDialog('tester');
    rootA.disableDiligencePush = true;
    const aRoot = rootA.id.rootId;
    await DialogPersistence.mutateDialogLatest(rootA.id, () => ({
      kind: 'patch',
      patch: {
        generating: true,
        displayState: { kind: 'proceeding' },
        disableDiligencePush: true,
      },
    }));
    await fs.writeFile(
      path.join(tmpRoot, '.dialogs', 'run', aRoot, 'course-001.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        type: 'gen_start_record',
        genseq: 1,
        rootCourse: 1,
        rootGenseq: 1,
      })}\n${JSON.stringify({
        ts: new Date().toISOString(),
        type: 'human_text_record',
        genseq: 1,
        content: 'Continue the already-started generation after restart.',
        msgId: 'prompt-a',
        grammar: 'markdown',
        origin: 'user',
        userLanguageCode: 'en',
        rootCourse: 1,
        rootGenseq: 1,
      })}\n`,
      'utf-8',
    );
    await DialogPersistence.savePendingSideDialogs(new DialogID(aRoot), [
      {
        sideDialogId: 'sub-a',
        createdAt: new Date().toISOString(),
        callName: 'tellask',
        mentionList: ['@worker'],
        tellaskContent: 'Still pending while the root generation was in flight',
        targetAgentId: 'worker',
        callId: 'call-sub-a',
        callSiteCourse: 1,
        callSiteGenseq: 1,
        callType: 'B',
        sessionSlug: 'session-a',
      },
    ]);
    globalDialogRegistry.unregister(aRoot);
    const sideRoot = await createMainDialog('tester');
    sideRoot.disableDiligencePush = true;
    const sideTrigger = 'Create side dialog for restart recovery.';
    const sideTellaskBody = 'Finish from a side dialog after restart.';
    const sideSessionSlug = 'side-restart-recovery';
    const language = getWorkLanguage();
    const sidePrompt = wrapPromptWithExpectedReplyTool({
      prompt: formatAssignmentFromAskerDialog({
        callName: 'tellask',
        fromAgentId: 'tester',
        toAgentId: 'pangu',
        mentionList: ['@pangu'],
        tellaskContent: sideTellaskBody,
        language,
        sessionSlug: sideSessionSlug,
        collectiveTargets: ['pangu'],
      }),
      expectedReplyToolName: 'replyTellask',
      language,
    });
    await writeMockDb(tmpRoot, [
      {
        message: 'Continue the already-started generation after restart.',
        role: 'user',
        response: 'Restart recovery drove the in-progress root generation.',
      },
      {
        message: sideTrigger,
        role: 'user',
        response: 'Creating side dialog.',
        funcCalls: [
          {
            id: 'side-restart-call',
            name: 'tellask',
            arguments: {
              targetAgentId: 'pangu',
              sessionSlug: sideSessionSlug,
              tellaskContent: sideTellaskBody,
            },
          },
        ],
      },
      {
        message: sidePrompt,
        role: 'user',
        response: 'Side dialog recovered and replies after restart.',
        funcCalls: [
          {
            id: 'side-restart-reply',
            name: 'replyTellask',
            arguments: {
              replyContent: 'Side dialog recovered and replies after restart.',
            },
          },
        ],
      },
    ]);
    await driveDialogStream(
      sideRoot,
      makeUserPrompt(sideTrigger, 'side-trigger', { userLanguageCode: language }),
      true,
      makeDriveOptions(),
    );
    await waitForAllDialogsUnlocked(sideRoot, 3_000);
    const sideDialog = sideRoot
      .getAllDialogs()
      .find((dialog) => dialog.id.selfId !== dialog.id.rootId);
    assert.ok(sideDialog, 'expected side dialog to be created before restart simulation');
    await DialogPersistence.mutateDialogLatest(sideDialog.id, () => ({
      kind: 'patch',
      patch: {
        generating: true,
        displayState: { kind: 'proceeding' },
      },
    }));
    globalDialogRegistry.unregister(sideRoot.id.rootId);

    // Dialog B: was proceeding, but not actively generating. It is still reconciled from durable
    // blocker facts rather than auto-driven.
    const bRoot = 'dlg-b';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', bRoot, 'dialog.yaml'), { id: bRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', bRoot, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: false,
      needsDrive: true,
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

    // Dialog I: generating=true is not enough for automatic recovery when an explicit
    // non-restart interruption marker says the drive must be manually resumed.
    const iRoot = 'dlg-i';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', iRoot, 'dialog.yaml'), { id: iRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', iRoot, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: true,
      displayState: { kind: 'proceeding' },
      executionMarker: {
        kind: 'interrupted',
        reason: { kind: 'user_stop', detail: 'operator paused before restart' },
      },
    });

    // Dialog C: malformed q4h should quarantine only itself instead of aborting the whole rebuild.
    const cRoot = 'dlg-c';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', cRoot, 'dialog.yaml'), { id: cRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', cRoot, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: false,
      needsDrive: true,
      displayState: { kind: 'idle_waiting_user' },
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
            callSiteCourse: 1,
            callSiteGenseq: 1,
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

    // Dialog G: a stale queued drive with no active generation/proceeding projection becomes a
    // resumable server-restart interruption and should be counted as resumable.
    const gRoot = 'dlg-g';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', gRoot, 'dialog.yaml'), { id: gRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', gRoot, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: false,
      needsDrive: true,
      displayState: { kind: 'idle_waiting_user' },
    });

    await reconcileDisplayStatesAfterRestart();

    const latestA = await DialogPersistence.loadDialogLatest(new DialogID(aRoot), 'running');
    assert.ok(latestA, 'latest.yaml for dlg-a should exist');
    assert.equal(latestA.generating, true);
    assert.equal(latestA.needsDrive, true);
    assert.ok(latestA.displayState);
    assert.equal(latestA.displayState.kind, 'proceeding');
    assert.equal(latestA.executionMarker, undefined);
    assert.equal(globalDialogRegistry.get(aRoot), undefined);

    await recoverProceedingDrivesAfterRestart();
    const recoveredA = globalDialogRegistry.get(aRoot);
    assert.ok(recoveredA, 'restart recovery should restore dlg-a root');
    assert.equal(
      globalDialogRegistry.isMarkedNeedingDrive(aRoot),
      true,
      'restart recovery should enqueue dlg-a for backend drive',
    );
    void runBackendDriver();
    await waitFor(
      async () =>
        lastAssistantSaying(recoveredA) ===
        'Restart recovery drove the in-progress root generation.',
      3_000,
      'backend loop to resume in-progress generation even while pending sideDialogs remain',
    );
    await waitForAllDialogsUnlocked(recoveredA, 3_000);
    const latestAAfterDrive = await DialogPersistence.loadDialogLatest(
      new DialogID(aRoot),
      'running',
    );
    assert.equal(latestAAfterDrive?.generating, false);
    assert.equal(latestAAfterDrive?.displayState?.kind, 'blocked');

    await waitFor(
      async () =>
        sideRoot.msgs.some(
          (msg) =>
            msg.type === 'tellask_result_msg' &&
            msg.content.includes('Side dialog recovered and replies after restart.'),
        ),
      3_000,
      'restart recovery to directly resume in-progress sideDialog generation',
    );
    assert.ok(
      sideRoot.msgs.some(
        (msg) =>
          msg.type === 'tellask_result_msg' &&
          msg.content.includes('side-restart-call') &&
          msg.content.includes('Side dialog recovered and replies after restart.'),
      ),
      'sideDialog restart recovery should deliver replyTellask back to root',
    );

    const latestB = await DialogPersistence.loadDialogLatest(new DialogID(bRoot), 'running');
    assert.ok(latestB, 'latest.yaml for dlg-b should exist');
    assert.equal(latestB.generating, false);
    assert.ok(latestB.displayState);
    assert.equal(latestB.displayState.kind, 'blocked');
    assert.equal(latestB.displayState.reason.kind, 'needs_human_input');

    const latestI = await DialogPersistence.loadDialogLatest(new DialogID(iRoot), 'running');
    assert.ok(latestI, 'latest.yaml for dlg-i should exist');
    assert.equal(latestI.generating, false);
    assert.ok(latestI.displayState);
    assert.equal(latestI.displayState.kind, 'stopped');
    assert.equal(latestI.displayState.reason.kind, 'user_stop');
    assert.equal(latestI.executionMarker?.kind, 'interrupted');
    assert.equal(latestI.executionMarker.reason.kind, 'user_stop');

    assert.equal(await DialogPersistence.loadDialogLatest(new DialogID(cRoot), 'running'), null);
    await fs.access(path.join(tmpRoot, '.dialogs', 'malformed', cRoot));

    const latestD = await DialogPersistence.loadDialogLatest(new DialogID(dRoot), 'running');
    assert.ok(latestD, 'latest.yaml for dlg-d should exist');
    assert.ok(latestD.displayState);
    assert.equal(latestD.displayState.kind, 'idle_waiting_user');

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
