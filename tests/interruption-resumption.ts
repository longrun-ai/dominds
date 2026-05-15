import type { SideDialogAssignmentFromAsker } from '@longrun-ai/kernel/types/storage';
import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import { installRecordingGlobalDialogEventBroadcaster } from '../main/bootstrap/global-dialog-event-broadcaster';
import { DialogID } from '../main/dialog';
import {
  getRunControlCountsSnapshot,
  reconcileDisplayStatesAfterRestart,
  refreshRunControlProjectionFromPersistenceFacts,
} from '../main/dialog-display-state';
import { globalDialogRegistry } from '../main/dialog-global-registry';
import { driveDialogStream } from '../main/llm/kernel-driver';
import { driveQueuedDialogsOnce } from '../main/llm/kernel-driver/loop';
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

async function writeSideDialogAskerStack(args: {
  sideDialogId: DialogID;
  assignment: SideDialogAssignmentFromAsker;
}): Promise<void> {
  await DialogPersistence.saveSideDialogAskerStackState(
    args.sideDialogId,
    {
      askerStack: [
        {
          kind: 'asker_dialog_stack_frame',
          askerDialogId: args.assignment.askerDialogId,
          assignmentFromAsker: args.assignment,
          tellaskReplyObligation: {
            expectedReplyCallName:
              args.assignment.callName === 'tellask' ? 'replyTellask' : 'replyTellaskSessionless',
            targetDialogId: args.assignment.askerDialogId,
            targetCallId: args.assignment.callId,
            tellaskContent: args.assignment.tellaskContent,
          },
        },
      ],
    },
    'running',
  );
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
        generationRunState: {
          kind: 'open',
          course: 1,
          genseq: 1,
          phase: 'streaming',
          acceptedTriggerIds: [],
          openedAt: new Date().toISOString(),
        },
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
        batchId: `dispatch:${aRoot}:${aRoot}:c1:g1`,
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
      userWait: {
        kind: 'awaiting_user_answer',
        questionId: 'q1',
        callId: 'call-q1',
        course: 1,
        askedAt: new Date().toISOString(),
      },
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

    // Dialog I: generating=true without generationRunState is malformed even when an explicit
    // non-restart interruption marker is present; runtime must not scan history to guess.
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

    // Dialog L: generating=true alone is only a projection. Without generationRunState,
    // restart recovery must quarantine instead of auto-driving or scanning history to guess.
    const lRoot = 'dlg-l';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', lRoot, 'dialog.yaml'), { id: lRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', lRoot, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: true,
      displayState: { kind: 'proceeding' },
    });

    // Dialog C: malformed q4h detail must not affect run-control recovery once userWait is the
    // durable suspension fact. Q4H detail consumers still fail loudly when they need the payload.
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

    // Dialog E: stale stopped projection should keep the explicit interruption when only
    // background callee dialogs remain pending.
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
            batchId: `dispatch:${eRoot}:${eRoot}:c1:g1`,
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

    // Dialog F: stale Q4H projection should self-heal back to stopped when interruption remains
    // but the underlying Q4H suspension is already gone.
    const fRoot = 'dlg-f';
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', fRoot, 'dialog.yaml'), { id: fRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', fRoot, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: false,
      displayState: { kind: 'blocked', reason: { kind: 'needs_human_input' } },
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

    // Dialog J: sideDialogs already delivered their final responses, but latest.yaml still has
    // stale run-control flags/projections. Restart reconciliation must heal the stale queue instead
    // of presenting a false "interrupted by server restart" state.
    const jRoot = 'dlg-j';
    const jSide = 'side-j';
    const jProjectionOnlySide = 'side-j-projection-only';
    const jQ4hProjectionSide = 'side-j-q4h-projection';
    const jSideAssignment: SideDialogAssignmentFromAsker = {
      callName: 'tellask',
      mentionList: ['@pangu'],
      tellaskContent: 'Finalize stale generated side dialog J.',
      originMemberId: 'tester',
      askerDialogId: jRoot,
      callId: 'call-side-j',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      collectiveTargets: ['pangu'],
    };
    const jProjectionOnlyAssignment: SideDialogAssignmentFromAsker = {
      callName: 'tellask',
      mentionList: ['@pangu'],
      tellaskContent: 'Finalize stale projection-only side dialog J.',
      originMemberId: 'tester',
      askerDialogId: jRoot,
      callId: 'call-side-j-projection-only',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      collectiveTargets: ['pangu'],
    };
    const jQ4hProjectionAssignment: SideDialogAssignmentFromAsker = {
      callName: 'tellask',
      mentionList: ['@pangu'],
      tellaskContent: 'Finalize stale q4h-projection side dialog J.',
      originMemberId: 'tester',
      askerDialogId: jRoot,
      callId: 'call-side-j-q4h-projection',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      collectiveTargets: ['pangu'],
    };
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', jRoot, 'dialog.yaml'), { id: jRoot });
    await writeYaml(path.join(tmpRoot, '.dialogs', 'run', jRoot, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: false,
      displayState: { kind: 'idle_waiting_user' },
    });
    const jSideDir = path.join(tmpRoot, '.dialogs', 'run', jRoot, 'sideDialogs', jSide);
    await writeYaml(path.join(jSideDir, 'dialog.yaml'), { id: jSide });
    await writeSideDialogAskerStack({
      sideDialogId: new DialogID(jSide, jRoot),
      assignment: jSideAssignment,
    });
    await writeYaml(path.join(jSideDir, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: true,
      needsDrive: true,
      displayState: {
        kind: 'stopped',
        reason: { kind: 'server_restart' },
        continueEnabled: true,
      },
      executionMarker: {
        kind: 'interrupted',
        reason: { kind: 'server_restart' },
      },
      sideDialogFinalResponse: {
        callId: 'call-side-j',
        responseCourse: 1,
        responseGenseq: 3,
        askerDialogId: jRoot,
        askerCourse: 1,
      },
    });
    await fs.writeFile(
      path.join(jSideDir, 'course-001.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        type: 'tellask_anchor_record',
        anchorRole: 'response',
        callId: 'call-side-j',
        genseq: 3,
        rootCourse: 1,
        rootGenseq: 3,
        askerDialogId: jRoot,
        askerCourse: 1,
        assignmentCourse: 1,
        assignmentGenseq: 1,
      })}\n${JSON.stringify({
        ts: new Date().toISOString(),
        type: 'gen_finish_record',
        genseq: 3,
        rootCourse: 1,
        rootGenseq: 3,
      })}\n${JSON.stringify({
        ts: new Date().toISOString(),
        type: 'reminders_reconciled_record',
        rootCourse: 1,
        rootGenseq: 3,
        reminders: [],
      })}\n`,
      'utf-8',
    );
    const jProjectionOnlySideDir = path.join(
      tmpRoot,
      '.dialogs',
      'run',
      jRoot,
      'sideDialogs',
      jProjectionOnlySide,
    );
    await writeYaml(path.join(jProjectionOnlySideDir, 'dialog.yaml'), { id: jProjectionOnlySide });
    await writeSideDialogAskerStack({
      sideDialogId: new DialogID(jProjectionOnlySide, jRoot),
      assignment: jProjectionOnlyAssignment,
    });
    await writeYaml(path.join(jProjectionOnlySideDir, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: false,
      needsDrive: false,
      displayState: {
        kind: 'stopped',
        reason: { kind: 'server_restart' },
        continueEnabled: true,
      },
      executionMarker: {
        kind: 'interrupted',
        reason: { kind: 'server_restart' },
      },
      sideDialogFinalResponse: {
        callId: 'call-side-j-projection-only',
        responseCourse: 1,
        responseGenseq: 3,
        askerDialogId: jRoot,
        askerCourse: 1,
      },
    });
    await fs.writeFile(
      path.join(jProjectionOnlySideDir, 'course-001.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        type: 'tellask_anchor_record',
        anchorRole: 'response',
        callId: 'call-side-j-projection-only',
        genseq: 3,
        rootCourse: 1,
        rootGenseq: 3,
        askerDialogId: jRoot,
        askerCourse: 1,
        assignmentCourse: 1,
        assignmentGenseq: 1,
      })}\n`,
      'utf-8',
    );
    const jQ4hProjectionSideDir = path.join(
      tmpRoot,
      '.dialogs',
      'run',
      jRoot,
      'sideDialogs',
      jQ4hProjectionSide,
    );
    await writeYaml(path.join(jQ4hProjectionSideDir, 'dialog.yaml'), {
      id: jQ4hProjectionSide,
    });
    await writeSideDialogAskerStack({
      sideDialogId: new DialogID(jQ4hProjectionSide, jRoot),
      assignment: jQ4hProjectionAssignment,
    });
    await writeYaml(path.join(jQ4hProjectionSideDir, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: new Date().toISOString(),
      status: 'active',
      generating: false,
      needsDrive: false,
      displayState: { kind: 'blocked', reason: { kind: 'needs_human_input' } },
      sideDialogFinalResponse: {
        callId: 'call-side-j-q4h-projection',
        responseCourse: 1,
        responseGenseq: 3,
        askerDialogId: jRoot,
        askerCourse: 1,
      },
    });
    await fs.writeFile(
      path.join(jQ4hProjectionSideDir, 'course-001.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        type: 'tellask_anchor_record',
        anchorRole: 'response',
        callId: 'call-side-j-q4h-projection',
        genseq: 3,
        rootCourse: 1,
        rootGenseq: 3,
        askerDialogId: jRoot,
        askerCourse: 1,
        assignmentCourse: 1,
        assignmentGenseq: 1,
      })}\n`,
      'utf-8',
    );

    // Dialog K: pending_reply_obligation is an auto-resumable interrupted marker like
    // pending_runtime_prompt. Restart reconciliation must preserve the in-flight drive and clear the
    // marker instead of turning it into a manual server_restart stop.
    const kRoot = 'dlg-k';
    const kSide = 'side-k';
    const kRootId = new DialogID(kRoot);
    const kSideId = new DialogID(kSide, kRoot);
    const kSideDir = path.join(tmpRoot, '.dialogs', 'run', kRoot, 'sideDialogs', kSide);
    const kCreatedAt = new Date().toISOString();
    const kAssignment: SideDialogAssignmentFromAsker = {
      callName: 'tellask',
      mentionList: ['@pangu'],
      tellaskContent: 'Recover pending reply obligation after restart',
      originMemberId: 'tester',
      askerDialogId: kRoot,
      callId: 'call-side-k',
      callSiteCourse: 1,
      callSiteGenseq: 1,
      collectiveTargets: ['pangu'],
    };
    await DialogPersistence.saveMainDialogMetadata(
      kRootId,
      {
        id: kRoot,
        agentId: 'tester',
        taskDocPath: 'plans/interruption-resumption-k.tsk',
        createdAt: kCreatedAt,
      },
      'running',
    );
    await DialogPersistence.mutateDialogLatest(kRootId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 1,
        lastModified: kCreatedAt,
        status: 'active',
        generating: false,
        displayState: { kind: 'idle_waiting_user' },
      },
    }));
    await DialogPersistence.ensureSideDialogDirectory(kSideId, 'running');
    await DialogPersistence.saveSideDialogMetadata(
      kSideId,
      {
        id: kSide,
        agentId: 'pangu',
        taskDocPath: 'plans/interruption-resumption-k.tsk',
        createdAt: kCreatedAt,
      },
      'running',
    );
    await DialogPersistence.saveSideDialogAskerStackState(
      kSideId,
      {
        askerStack: [
          {
            kind: 'asker_dialog_stack_frame',
            askerDialogId: kRoot,
            assignmentFromAsker: kAssignment,
            tellaskReplyObligation: {
              expectedReplyCallName: 'replyTellask',
              targetDialogId: kRoot,
              targetCallId: kAssignment.callId,
              tellaskContent: kAssignment.tellaskContent,
            },
          },
        ],
      },
      'running',
    );
    await writeYaml(path.join(kSideDir, 'latest.yaml'), {
      currentCourse: 1,
      lastModified: kCreatedAt,
      status: 'active',
      generating: true,
      generationRunState: {
        kind: 'open',
        course: 1,
        genseq: 1,
        phase: 'streaming',
        acceptedTriggerIds: [],
        openedAt: kCreatedAt,
      },
      displayState: {
        kind: 'stopped',
        reason: { kind: 'pending_reply_obligation' },
        continueEnabled: true,
      },
      executionMarker: {
        kind: 'interrupted',
        reason: { kind: 'pending_reply_obligation' },
      },
    });

    await getRunControlCountsSnapshot();
    const latestJAfterSnapshot = await DialogPersistence.loadDialogLatest(
      new DialogID(jSide, jRoot),
      'running',
    );
    assert.deepEqual(
      latestJAfterSnapshot?.displayState,
      { kind: 'idle_waiting_user' },
      'run-control snapshot should heal finalized stale sideDialogs before counting proceeding dialogs',
    );
    const latestJProjectionOnlyAfterSnapshot = await DialogPersistence.loadDialogLatest(
      new DialogID(jProjectionOnlySide, jRoot),
      'running',
    );
    assert.deepEqual(
      latestJProjectionOnlyAfterSnapshot?.displayState,
      { kind: 'idle_waiting_user' },
      'run-control snapshot should heal finalized projection-only sideDialogs before counting resumable dialogs',
    );

    await reconcileDisplayStatesAfterRestart();

    const latestA = await DialogPersistence.loadDialogLatest(new DialogID(aRoot), 'running');
    assert.ok(latestA, 'latest.yaml for dlg-a should exist');
    assert.equal(latestA.generating, true);
    assert.equal(latestA.needsDrive, true);
    assert.ok(latestA.displayState);
    assert.equal(latestA.displayState.kind, 'proceeding');
    assert.equal(latestA.executionMarker, undefined);
    assert.equal(globalDialogRegistry.get(aRoot), undefined);

    const latestK = await DialogPersistence.loadDialogLatest(new DialogID(kSide, kRoot), 'running');
    assert.ok(latestK, 'latest.yaml for dlg-k sideDialog should exist');
    assert.equal(
      latestK.generating,
      true,
      'pending_reply_obligation interrupted generation should remain recoverable after restart',
    );
    assert.equal(
      latestK.needsDrive,
      true,
      'pending_reply_obligation interrupted generation should be queued for recovery',
    );
    assert.deepEqual(latestK.displayState, { kind: 'proceeding' });
    assert.equal(latestK.executionMarker, undefined);

    await recoverProceedingDrivesAfterRestart();
    const recoveredA = globalDialogRegistry.get(aRoot);
    assert.ok(recoveredA, 'restart recovery should restore dlg-a root');
    assert.equal(
      globalDialogRegistry.isMarkedNeedingDrive(aRoot),
      true,
      'restart recovery should enqueue dlg-a for backend drive',
    );
    await driveQueuedDialogsOnce();
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
    assert.deepEqual(latestAAfterDrive?.displayState, { kind: 'idle_waiting_user' });

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
    await waitForAllDialogsUnlocked(sideRoot, 3_000);
    await waitFor(
      () => globalDialogRegistry.isMarkedNeedingDrive(kRoot) === false,
      3_000,
      'pending-reply-obligation sideDialog restart recovery should drain before cwd restore',
    );

    const latestB = await DialogPersistence.loadDialogLatest(new DialogID(bRoot), 'running');
    assert.ok(latestB, 'latest.yaml for dlg-b should exist');
    assert.equal(latestB.generating, false);
    assert.ok(latestB.displayState);
    assert.equal(latestB.displayState.kind, 'blocked');
    assert.equal(latestB.displayState.reason.kind, 'needs_human_input');

    await assert.rejects(fs.access(path.join(tmpRoot, '.dialogs', 'run', iRoot)));
    await fs.access(path.join(tmpRoot, '.dialogs', 'malformed', iRoot));

    await assert.rejects(fs.access(path.join(tmpRoot, '.dialogs', 'run', lRoot)));
    await fs.access(path.join(tmpRoot, '.dialogs', 'malformed', lRoot));

    const latestC = await DialogPersistence.loadDialogLatest(new DialogID(cRoot), 'running');
    assert.ok(latestC, 'latest.yaml for dlg-c should remain readable');
    assert.equal(latestC.displayState?.kind, 'stopped');
    assert.equal(latestC.displayState?.reason.kind, 'server_restart');
    await assert.rejects(fs.access(path.join(tmpRoot, '.dialogs', 'malformed', cRoot)));

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
    assert.equal(healedE.displayState.kind, 'stopped');
    assert.equal(healedE.displayState.reason.kind, 'system_stop');
    assert.equal(healedE.displayState.continueEnabled, true);
    assert.equal(healedE.executionMarker?.kind, 'interrupted');

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

    const latestJ = await DialogPersistence.loadDialogLatest(new DialogID(jSide, jRoot), 'running');
    assert.ok(latestJ, 'latest.yaml for dlg-j sideDialog should exist');
    assert.equal(
      latestJ.generating,
      false,
      'restart reconciliation should clear stale sideDialog generating after final response anchor',
    );
    assert.equal(
      latestJ.needsDrive,
      false,
      'restart reconciliation should clear stale sideDialog needsDrive after final response anchor',
    );
    assert.deepEqual(
      latestJ.displayState,
      { kind: 'idle_waiting_user' },
      'stale sideDialog needsDrive must not become a false server_restart interruption',
    );
    assert.equal(latestJ.executionMarker, undefined);
    const latestJProjectionOnly = await DialogPersistence.loadDialogLatest(
      new DialogID(jProjectionOnlySide, jRoot),
      'running',
    );
    assert.ok(
      latestJProjectionOnly,
      'latest.yaml for dlg-j projection-only sideDialog should exist',
    );
    assert.equal(
      latestJProjectionOnly.needsDrive,
      false,
      'restart reconciliation should not requeue projection-only stale sideDialog state',
    );
    assert.deepEqual(
      latestJProjectionOnly.displayState,
      { kind: 'idle_waiting_user' },
      'stale sideDialog interruption projection should clear even when needsDrive is already false',
    );
    assert.equal(latestJProjectionOnly.executionMarker, undefined);

    const latestJQ4hProjection = await DialogPersistence.loadDialogLatest(
      new DialogID(jQ4hProjectionSide, jRoot),
      'running',
    );
    assert.ok(latestJQ4hProjection, 'latest.yaml for dlg-j q4h-projection sideDialog should exist');
    assert.deepEqual(
      latestJQ4hProjection.displayState,
      { kind: 'idle_waiting_user' },
      'finalized sideDialog should not retain stale Q4H projection after restart',
    );

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
