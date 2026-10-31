import type {
  DialogLatestFile,
  SideDialogAssignmentFromAsker,
} from '@longrun-ai/kernel/types/storage';
import {
  toAskerCourseNumber,
  toCalleeGenerationSeqNumber,
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
  toDialogCourseNumber,
} from '@longrun-ai/kernel/types/storage';
import type { DialogsQuarantinedMessage } from '@longrun-ai/kernel/types/wire';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import yaml from 'yaml';
import { DialogID } from '../main/dialog';
import {
  getRunControlCountsSnapshot,
  reconcileDisplayStatesAfterRestart,
  refreshRunControlProjectionFromPersistenceFacts,
} from '../main/dialog-display-state';
import { globalDialogRegistry } from '../main/dialog-global-registry';
import {
  createEmptyDialogNextStepState,
  createEmptyDialogTellaskCallState,
  createEmptyDialogTellaskResultState,
} from '../main/dialog-latest-state';
import { DialogPersistence, setDialogsQuarantinedBroadcaster } from '../main/persistence';
import { recoverOpenGenerationAfterRestart } from '../main/recovery/open-generation-recovery';
import { setWorkLanguage } from '../main/runtime/work-language';
import { readGenerationManifest } from './helpers/open-generation-worker';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { waitFor, withTempRtws, writeStandardMinds } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-interruption-recovery-');
async function writeYaml(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, yaml.stringify(value));
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function rawCourse(root: string, self = root): Promise<Record<string, unknown>[]> {
  const dir =
    self === root
      ? path.join('.dialogs/run', root)
      : path.join('.dialogs/run', root, 'sideDialogs', self);
  return (await fs.readFile(path.join(dir, 'course-001.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => record(JSON.parse(line)));
}
async function rawLatest(root: string, self = root): Promise<Record<string, unknown>> {
  const dir =
    self === root
      ? path.join('.dialogs/run', root)
      : path.join('.dialogs/run', root, 'sideDialogs', self);
  return record(yaml.parse(await fs.readFile(path.join(dir, 'latest.yaml'), 'utf8')));
}
function workerArgs(phase: string): string[] {
  return [
    '--import',
    require.resolve('tsx'),
    path.resolve(__dirname, 'rtws-script-runner.ts'),
    path.resolve(__dirname, 'helpers/open-generation-worker.ts'),
    phase,
  ];
}
async function coldGenerationRecovery(rtws: string): Promise<void> {
  const seed = spawn(process.execPath, workerArgs('seed'), {
    cwd: rtws,
    env: { ...process.env, TSX_TSCONFIG_PATH: path.resolve(__dirname, 'tsconfig.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '',
    pending = '';
  let readyCount = 0;
  let readyResolve!: (pid: number) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<number>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  seed.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    pending += chunk.toString();
    while (pending.includes('\n')) {
      const index = pending.indexOf('\n'),
        line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      let packet: unknown;
      try {
        packet = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        packet !== null &&
        typeof packet === 'object' &&
        'probe' in packet &&
        packet.probe === 'generation-seed-ready' &&
        'pid' in packet &&
        typeof packet.pid === 'number'
      ) {
        readyCount += 1;
        readyResolve(packet.pid);
      }
    }
  });
  seed.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  seed.once('error', readyReject);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    seed.once('close', (code, signal) => {
      readyReject(
        new Error(`seed closed before readiness: ${code}/${signal}\n${stdout}\n${stderr}`),
      );
      resolve({ code, signal });
    });
  });
  const timer = setTimeout(
    () => readyReject(new Error(`seed did not reach its provider boundary\n${stdout}\n${stderr}`)),
    15000,
  );
  try {
    const pid = await ready;
    assert.equal(pid, seed.pid);
    assert.notEqual(pid, process.pid);
    const m = await readGenerationManifest();
    assert.equal(m.seedPid, pid);
    await waitFor(
      async () => {
        try {
          const root = await rawLatest(m.rootA),
            side = await rawLatest(m.rootB, m.sideB),
            caller = await rawLatest(m.rootB);
          return (
            caller.generating === false &&
            record(caller.generationRunState).kind === 'closed' &&
            root.generating === true &&
            record(root.generationRunState).kind === 'open' &&
            side.generating === true &&
            record(side.generationRunState).kind === 'open'
          );
        } catch (error: unknown) {
          if (
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            return false;
          throw error;
        }
      },
      4000,
      'both open generations to be physically written before process loss',
    );
    assert.equal(
      (await rawCourse(m.rootB)).filter(
        (event) => event.type === 'tellask_result_record' && event.callId === m.workCallId,
      ).length,
      0,
      'side reply has not already arrived before the crash',
    );
    assert.equal(
      (await rawCourse(m.rootB, m.sideB)).filter(
        (event) => event.type === 'func_result_record' && event.id === m.replyCallId,
      ).length,
      0,
    );
    assert.equal(
      seed.kill('SIGKILL'),
      true,
      'terminate only the owned seed process at the observed durable boundary',
    );
    assert.equal((await closed).signal, 'SIGKILL');
    clearTimeout(timer);
    assert.equal(readyCount, 1);
    const recovered = await promisify(execFile)(process.execPath, workerArgs('recover'), {
      cwd: rtws,
      env: { ...process.env, TSX_TSCONFIG_PATH: path.resolve(__dirname, 'tsconfig.json') },
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
    });
    process.stdout.write(recovered.stdout);
    process.stderr.write(recovered.stderr);
    const packets = recovered.stdout.split('\n').flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return value !== null &&
          typeof value === 'object' &&
          'probe' in value &&
          value.probe === 'generation-recovered'
          ? [value]
          : [];
      } catch {
        return [];
      }
    });
    assert.equal(packets.length, 1);
    const packet = packets[0];
    assert.ok(packet && 'pid' in packet && 'requests' in packet);
    assert.notEqual(packet.pid, pid);
    assert.notEqual(packet.pid, process.pid);
    assert.equal(packet.requests, 3);
    const rootEvents = await rawCourse(m.rootA),
      callerEvents = await rawCourse(m.rootB),
      sideEvents = await rawCourse(m.rootB, m.sideB);
    assert.equal(
      rootEvents.filter((event) => event.type === 'human_text_record' && event.content === m.inputA)
        .length,
      1,
    );
    assert.equal(
      rootEvents.filter((event) => event.type === 'agent_words_record' && event.content === m.ackA)
        .length,
      1,
    );
    assert.equal(
      callerEvents.filter(
        (event) => event.type === 'agent_words_record' && event.content === m.ackB,
      ).length,
      1,
    );
    const results = callerEvents.filter(
      (event) => event.type === 'tellask_result_record' && event.callId === m.workCallId,
    );
    assert.equal(results.length, 1);
    assert.ok(typeof results[0]?.content === 'string' && results[0].content.includes(m.replyBody));
    const outputs = sideEvents.filter(
      (event) => event.type === 'func_result_record' && event.id === m.replyCallId,
    );
    assert.equal(outputs.length, 1);
    assert.equal(
      sideEvents.filter(
        (event) =>
          event.type === 'tellask_reply_resolution_record' && event.callId === m.replyCallId,
      ).length,
      1,
    );
    for (const [root, self] of [
      [m.rootA, m.rootA],
      [m.rootB, m.sideB],
      [m.rootB, m.rootB],
    ]) {
      assert.ok(root && self);
      const latest = await rawLatest(root, self);
      assert.equal(latest.generating, false);
      assert.deepEqual(latest.displayState, { kind: 'idle_waiting_user' });
      assert.equal(latest.executionMarker, undefined);
      assert.equal(record(latest.generationRunState).kind, 'closed');
      assert.deepEqual(record(latest.nextStep).triggers, []);
    }
    const pendingWork = await DialogPersistence.loadActiveCalleeDispatches(
      new DialogID(m.rootA),
      'running',
    );
    assert.equal(pendingWork.length, 1);
    assert.equal(pendingWork[0]?.calleeDialogId, m.workerA);
    assert.deepEqual(
      await DialogPersistence.loadActiveCalleeDispatches(new DialogID(m.rootB), 'running'),
      [],
    );
    assert.ok(typeof outputs[0]?.content === 'string');
    evidence.record({
      id: 'cold-generation-side-ack',
      scenario:
        'An owned process is killed while a root and a side dialog are awaiting provider responses. A new process restores both; the side replies once and its real caller consumes the result.',
      businessValue:
        'Resume durable collaboration after actual process loss without treating a reply delivered before the crash as recovered work.',
      context: {
        language: 'en',
        seedTerminatedBy: 'SIGKILL',
        seedPid: pid,
        recoveryPid: typeof packet.pid === 'number' ? packet.pid : 'invalid',
        verifierPid: process.pid,
        deliveryCount: 1,
        localReplyResultCount: 1,
        replyBeforeCrash: false,
        scope:
          'Real driver, persistence, backend and owned-process termination; controlled provider. Not power loss, fsync or live-provider compliance.',
      },
      reviewQuestions: [
        'Does the actual acknowledgement accurately describe the observed single delivery without suggesting another reply or claiming task quality?',
      ],
      actualText: outputs[0].content,
    });
  } catch (error: unknown) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    throw error;
  } finally {
    clearTimeout(timer);
    if (seed.exitCode === null && seed.signalCode === null) seed.kill('SIGKILL');
    await closed;
  }
}

const timestamp = '2026-10-31 00:00:00';
async function seedRoot(id: string, patch: Partial<DialogLatestFile> = {}): Promise<void> {
  await writeYaml(path.join('.dialogs/run', id, 'dialog.yaml'), {
    id,
    agentId: 'tester',
    taskDocPath: 'test-scenario.tsk',
    createdAt: timestamp,
  });
  await writeYaml(path.join('.dialogs/run', id, 'latest.yaml'), {
    currentCourse: 1,
    lastModified: timestamp,
    status: 'active',
    nextStep: createEmptyDialogNextStepState(),
    tellaskCalls: createEmptyDialogTellaskCallState(),
    tellaskResults: createEmptyDialogTellaskResultState(),
    ...patch,
  } satisfies DialogLatestFile);
}
function assignment(root: string, callId: string): SideDialogAssignmentFromAsker {
  return {
    callName: 'tellask',
    mentionList: ['@worker'],
    tellaskContent: 'assignment-data',
    originMemberId: 'tester',
    askerDialogId: root,
    callId,
    callSiteCourse: toCallSiteCourseNo(1),
    callSiteGenseq: toCallSiteGenseqNo(1),
    collectiveTargets: ['worker'],
  };
}
async function seedSide(
  root: string,
  self: string,
  patch: Partial<DialogLatestFile>,
  completed: boolean,
): Promise<void> {
  const id = new DialogID(self, root),
    task = assignment(root, `call-${self}`);
  const directory = path.join('.dialogs/run', root, 'sideDialogs', self);
  await writeYaml(path.join(directory, 'dialog.yaml'), {
    id: self,
    agentId: 'worker',
    taskDocPath: 'test-scenario.tsk',
    createdAt: timestamp,
  });
  await DialogPersistence.saveSideDialogAskerStackState(id, {
    askerStack: [
      {
        kind: 'asker_dialog_stack_frame',
        askerDialogId: root,
        assignmentFromAsker: task,
        tellaskReplyObligation: {
          expectedReplyCallName: 'replyTellask',
          targetDialogId: root,
          targetCallId: task.callId,
          tellaskContent: task.tellaskContent,
        },
      },
    ],
  });
  await writeYaml(path.join(directory, 'latest.yaml'), {
    currentCourse: 1,
    lastModified: timestamp,
    status: 'active',
    nextStep: createEmptyDialogNextStepState(),
    tellaskCalls: createEmptyDialogTellaskCallState(),
    tellaskResults: createEmptyDialogTellaskResultState(),
    ...(completed
      ? {
          sideDialogFinalResponse: {
            callId: task.callId,
            responseCourse: toDialogCourseNumber(1),
            responseGenseq: toCalleeGenerationSeqNumber(3),
            askerDialogId: root,
            askerCourse: toAskerCourseNumber(1),
          },
        }
      : {}),
    ...patch,
  } satisfies DialogLatestFile);
  if (completed)
    await fs.writeFile(
      path.join(directory, 'course-001.jsonl'),
      `${JSON.stringify({ ts: timestamp, type: 'tellask_anchor_record', anchorRole: 'response', callId: task.callId, genseq: 3, rootCourse: 1, rootGenseq: 3, askerDialogId: root, askerCourse: 1, assignmentCourse: 1, assignmentGenseq: 1 })}\n`,
    );
}
async function finalizedVariants(root: string): Promise<string[]> {
  await seedRoot(root, { displayState: { kind: 'idle_waiting_user' } });
  const ids = [`${root}-generating`, `${root}-projection`, `${root}-human-projection`];
  for (const [index, self] of ids.entries()) {
    await seedSide(
      root,
      self,
      {
        generating: index === 0,
        nextStep:
          index === 0
            ? {
                nextSeq: 2,
                triggers: [
                  {
                    triggerId: 'stale-final-followup',
                    kind: 'followup',
                    sourceGeneration: {
                      course: toDialogCourseNumber(1),
                      genseq: toCallSiteGenseqNo(3),
                    },
                    reasons: [{ kind: 'runtime_guidance', msgId: 'guidance-data' }],
                    createdAt: timestamp,
                    seq: 1,
                  },
                ],
              }
            : createEmptyDialogNextStepState(),
        displayState:
          index === 2
            ? { kind: 'blocked', reason: { kind: 'needs_human_input' } }
            : { kind: 'stopped', reason: { kind: 'server_restart' }, continueEnabled: true },
        ...(index === 2
          ? {}
          : { executionMarker: { kind: 'interrupted', reason: { kind: 'server_restart' } } }),
      },
      true,
    );
    // Preserve the old histories: a finished turn followed by reminder sync, and anchor-only
    // histories whose generation finish was not recorded. Completion is the formal final fact.
    if (index === 0) {
      await fs.appendFile(
        path.join('.dialogs/run', root, 'sideDialogs', self, 'course-001.jsonl'),
        `${JSON.stringify({ ts: timestamp, type: 'gen_finish_record', genseq: 3, rootCourse: 1, rootGenseq: 3 })}\n${JSON.stringify({ ts: timestamp, type: 'reminders_reconciled_record', rootCourse: 1, rootGenseq: 3, reminders: [] })}\n`,
      );
    }
    // Public snapshot/restart actions must receive the stale state, not a pre-healed mutation.
    assert.equal((await rawLatest(root, self)).generating, index === 0);
  }
  return ids;
}
async function assertFinalized(root: string, ids: string[]): Promise<void> {
  for (const self of ids) {
    const latest = await DialogPersistence.loadDialogLatest(new DialogID(self, root), 'running');
    assert.ok(
      latest,
      'a completed side dialog remains in the running tree rather than being quarantined',
    );
    assert.equal(latest.generating, false);
    assert.deepEqual(latest.displayState, { kind: 'idle_waiting_user' });
    assert.deepEqual(latest.nextStep.triggers, []);
    assert.equal(latest.executionMarker, undefined);
    assert.equal(latest.sideDialogFinalResponse?.callId, `call-${self}`);
    assert.equal(
      await DialogPersistence.loadActiveTellaskReplyObligation(new DialogID(self, root), 'running'),
      undefined,
    );
  }
}
async function projectionRecovery(rtws: string): Promise<void> {
  await writeStandardMinds(rtws, { extraMembers: ['worker'], diligencePushMax: 0 });
  const snapshots = await finalizedVariants('snapshot-finalized');
  await getRunControlCountsSnapshot();
  await assertFinalized('snapshot-finalized', snapshots);
  // Independent fresh fixtures prevent snapshot healing from concealing a broken startup path.
  const startup = await finalizedVariants('startup-finalized');
  const notifications: DialogsQuarantinedMessage[] = [];
  setDialogsQuarantinedBroadcaster((message) => notifications.push(message));
  try {
    await seedRoot('human-wait', {
      generating: false,
      displayState: { kind: 'proceeding' },
      userWait: {
        kind: 'awaiting_user_answer',
        questionId: 'question-data',
        callId: 'ask-human-data',
        course: toDialogCourseNumber(1),
        askedAt: timestamp,
      },
    });
    await writeYaml('.dialogs/run/human-wait/q4h.yaml', {
      questions: [
        {
          id: 'question-data',
          tellaskContent: 'question-body-data',
          askedAt: timestamp,
          callId: 'ask-human-data',
          callSiteRef: { course: 1, messageIndex: 0, callSiteGenseq: 1 },
        },
      ],
      updatedAt: timestamp,
    });
    for (const id of ['malformed-stopped', 'malformed-open']) {
      await seedRoot(id, {
        generating: true,
        displayState: { kind: 'proceeding' },
        ...(id === 'malformed-stopped'
          ? {
              executionMarker: {
                kind: 'interrupted',
                reason: { kind: 'user_stop' },
              },
            }
          : {}),
      });
      await fs.writeFile(
        path.join('.dialogs/run', id, 'forensic.bin'),
        Buffer.from([0, 1, 2, 255]),
      );
    }
    await seedRoot('unfinished-side-root', {
      generating: false,
      displayState: { kind: 'idle_waiting_user' },
    });
    await seedSide(
      'unfinished-side-root',
      'unfinished-side',
      { generating: true, displayState: { kind: 'proceeding' } },
      false,
    );
    await fs.writeFile(
      '.dialogs/run/unfinished-side-root/forensic.bin',
      Buffer.from([0, 1, 2, 255]),
    );
    await seedRoot('irrelevant-detail', {
      generating: false,
      displayState: { kind: 'idle_waiting_user' },
    });
    await fs.writeFile('.dialogs/run/irrelevant-detail/q4h.yaml', 'questions: [');
    await seedRoot('missing-projection', { generating: false });
    const stop = { kind: 'system_stop', detail: 'upstream-stop-data' } as const;
    for (const id of ['stopped-with-background', 'stale-human-projection'])
      await seedRoot(id, {
        generating: false,
        displayState:
          id === 'stale-human-projection'
            ? { kind: 'blocked', reason: { kind: 'needs_human_input' } }
            : { kind: 'stopped', reason: stop, continueEnabled: true },
        executionMarker: { kind: 'interrupted', reason: stop },
      });
    await DialogPersistence.saveActiveCalleeDispatches(new DialogID('stopped-with-background'), [
      {
        calleeDialogId: 'background-data',
        createdAt: timestamp,
        batchId: 'batch-data',
        callName: 'tellask',
        mentionList: ['@worker'],
        tellaskContent: 'work-data',
        targetAgentId: 'worker',
        callId: 'background-call-data',
        callSiteCourse: toCallSiteCourseNo(1),
        callSiteGenseq: toCallSiteGenseqNo(1),
        callType: 'B',
        sessionSlug: 'session-data',
      },
    ]);
    await seedRoot('healthy-idle', {
      generating: false,
      displayState: { kind: 'idle_waiting_user' },
    });
    await seedRoot('pending-obligation', {
      generating: false,
      displayState: { kind: 'idle_waiting_user' },
    });
    const openState = {
      kind: 'open',
      course: toDialogCourseNumber(1),
      genseq: toCallSiteGenseqNo(1),
      phase: 'streaming',
      acceptedTriggerIds: [],
      openedAt: timestamp,
    } as const;
    await seedSide(
      'pending-obligation',
      'pending-side',
      {
        generating: true,
        generationRunState: { ...openState, acceptedTriggerIds: [] },
        displayState: {
          kind: 'stopped',
          reason: { kind: 'pending_reply_obligation' },
          continueEnabled: true,
        },
        executionMarker: { kind: 'interrupted', reason: { kind: 'pending_reply_obligation' } },
      },
      false,
    );
    const pendingId = new DialogID('pending-side', 'pending-obligation');
    const rawPending = await rawLatest('pending-obligation', 'pending-side');
    assert.deepEqual(rawPending.executionMarker, {
      kind: 'interrupted',
      reason: { kind: 'pending_reply_obligation' },
    });
    // The public wake writer consumes this supplied storage state without pre-healing latest.yaml.
    await DialogPersistence.syncWakeQueueForDialogLatest(
      pendingId,
      {
        currentCourse: 1,
        lastModified: timestamp,
        status: 'active',
        generating: true,
        generationRunState: { ...openState, acceptedTriggerIds: [] },
        nextStep: createEmptyDialogNextStepState(),
        tellaskCalls: createEmptyDialogTellaskCallState(),
        tellaskResults: createEmptyDialogTellaskResultState(),
      },
      'running',
    );
    assert.deepEqual(
      (await rawLatest('pending-obligation', 'pending-side')).executionMarker,
      rawPending.executionMarker,
      'wake synchronization does not pre-heal the restart input',
    );
    await reconcileDisplayStatesAfterRestart();
    await assertFinalized('startup-finalized', startup);
    const latest = (id: string) => DialogPersistence.loadDialogLatest(new DialogID(id), 'running');
    assert.deepEqual((await latest('human-wait'))?.displayState, {
      kind: 'blocked',
      reason: { kind: 'needs_human_input' },
    });
    assert.equal(
      (await DialogPersistence.loadQuestions4HumanState(new DialogID('human-wait'))).length,
      1,
    );
    for (const id of ['malformed-stopped', 'malformed-open', 'unfinished-side-root']) {
      await assert.rejects(fs.access(path.join('.dialogs/run', id)), { code: 'ENOENT' });
      assert.deepEqual(
        await fs.readFile(path.join('.dialogs/malformed', id, 'forensic.bin')),
        Buffer.from([0, 1, 2, 255]),
      );
      assert.equal(
        notifications.filter(
          (message) =>
            message.rootId === id &&
            message.reason === 'restart_reconciliation_missing_generation_run_state',
        ).length,
        1,
      );
    }
    assert.deepEqual((await latest('irrelevant-detail'))?.displayState, {
      kind: 'idle_waiting_user',
    });
    await assert.rejects(fs.access('.dialogs/malformed/irrelevant-detail'), { code: 'ENOENT' });
    assert.deepEqual((await latest('missing-projection'))?.displayState, {
      kind: 'idle_waiting_user',
    });
    for (const id of ['stopped-with-background', 'stale-human-projection']) {
      const healed = await refreshRunControlProjectionFromPersistenceFacts(
        new DialogID(id),
        'resume_dialog',
      );
      assert.deepEqual(healed?.displayState, {
        kind: 'stopped',
        reason: stop,
        continueEnabled: true,
      });
      assert.deepEqual(healed?.executionMarker, { kind: 'interrupted', reason: stop });
    }
    assert.deepEqual((await latest('healthy-idle'))?.displayState, { kind: 'idle_waiting_user' });
    assert.equal((await latest('healthy-idle'))?.executionMarker, undefined);
    const pending = await DialogPersistence.loadDialogLatest(pendingId);
    assert.equal(pending?.generating, true);
    assert.equal(pending?.generationRunState?.kind, 'open');
    assert.deepEqual(pending?.displayState, { kind: 'proceeding' });
    assert.equal(pending?.executionMarker, undefined);
    assert.ok(
      pending?.nextStep.triggers.some((trigger) => trigger.kind === 'open_generation_recovery'),
    );
    await recoverOpenGenerationAfterRestart();
    const pendingAfterRecovery = await DialogPersistence.loadDialogLatest(pendingId, 'running');
    assert.equal(pendingAfterRecovery?.generating, true);
    assert.equal(pendingAfterRecovery?.generationRunState?.kind, 'open');
    assert.equal(globalDialogRegistry.isRootDriveQueued('pending-obligation'), true);
    assert.ok(
      (
        await DialogPersistence.loadWakeQueueTargetDialogIds(
          new DialogID('pending-obligation'),
          'running',
        )
      ).some((id) => id.selfId === 'pending-side'),
    );
    globalDialogRegistry.unregister('pending-obligation');
    await seedRoot('stale-proceeding', { generating: false, displayState: { kind: 'proceeding' } });
    assert.deepEqual(
      (
        await refreshRunControlProjectionFromPersistenceFacts(
          new DialogID('stale-proceeding'),
          'resume_dialog',
        )
      )?.displayState,
      { kind: 'idle_waiting_user' },
    );
    assert.equal((await latest('stale-proceeding'))?.executionMarker, undefined);
    let error: unknown;
    try {
      await DialogPersistence.loadQuestions4HumanState(new DialogID('irrelevant-detail'));
    } catch (caught: unknown) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    await assert.rejects(fs.access('.dialogs/run/irrelevant-detail'), { code: 'ENOENT' });
    assert.equal(
      await fs.readFile('.dialogs/malformed/irrelevant-detail/q4h.yaml', 'utf8'),
      'questions: [',
    );
    evidence.record({
      id: 'malformed-human-question-detail',
      scenario:
        'Restart reconciliation ignores malformed question detail when no durable wait requires it; an actual question-detail consumer then refuses it and quarantines the dialog. A valid waiting question is still readable.',
      businessValue:
        'Keep unrelated run-control recovery available while refusing corrupt human-question payload when it is needed.',
      context: {
        language: 'en',
        idleBeforePayloadRead: true,
        validQuestionReadable: true,
        corruptPayloadRetainedInQuarantine: true,
        scope:
          'Real public persistence and run-control APIs on deliberately seeded files; no actual human-answer UI.',
      },
      reviewQuestions: [
        'Does the actual diagnostic accurately identify corrupt stored question data and the affected file without implying that a human answer was received?',
      ],
      actualText: error.message,
    });
  } finally {
    setDialogsQuarantinedBroadcaster(null);
  }
}
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    setWorkLanguage('en');
    await coldGenerationRecovery(rtws);
    await projectionRecovery(rtws);
    await evidence.write();
  });
  console.log('cold generation recovery and run-control projection boundaries: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
