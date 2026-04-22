import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  AskerDialogStackFrame,
  MainDialogMetadataFile,
  SideDialogMetadataFile,
  SideDialogResponseStateRecord,
} from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { DialogID } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-asker-stack-jsonl-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected JSON object');
  }
  return value as Record<string, unknown>;
}

async function loadStackRows(dialogId: DialogID): Promise<Record<string, unknown>[]> {
  const stackPath = DialogPersistence.getDialogAskerStackPath(dialogId, 'running');
  const raw = await fs.readFile(stackPath, 'utf-8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => asRecord(JSON.parse(line)));
}

async function main(): Promise<void> {
  await withTempCwd(async () => {
    const createdAt = formatUnifiedTimestamp(new Date('2026-04-21T00:00:00.000Z'));
    const mainId = new DialogID('main');
    const sideId = new DialogID('side', mainId.rootId);
    const mainMeta: MainDialogMetadataFile = {
      id: mainId.selfId,
      agentId: 'tester',
      taskDocPath: 'task.md',
      createdAt,
    };
    const initialAssignment: SideDialogMetadataFile['assignmentFromAsker'] = {
      callName: 'tellask',
      mentionList: ['@pangu'],
      tellaskContent: 'Initial assignment',
      originMemberId: 'tester',
      callerDialogId: mainId.selfId,
      callId: 'call-sub-1',
      collectiveTargets: ['pangu'],
    };
    const sideMeta: SideDialogMetadataFile = {
      id: sideId.selfId,
      agentId: 'pangu',
      taskDocPath: 'task.md',
      createdAt,
      askerDialogId: mainId.selfId,
      sessionSlug: 'sticky',
      assignmentFromAsker: initialAssignment,
    };

    await DialogPersistence.saveMainDialogMetadata(mainId, mainMeta, 'running');
    await DialogPersistence.ensureSideDialogDirectory(sideId, 'running');
    await DialogPersistence.saveSideDialogMetadata(sideId, sideMeta, 'running');

    const blankResponseIdRecord: SideDialogResponseStateRecord = {
      responseId: '   ',
      sideDialogId: sideId.selfId,
      response: 'bad response id',
      completedAt: createdAt,
      status: 'completed',
      callType: 'B',
      callName: 'tellask',
      mentionList: [],
      tellaskContent: 'Bad response id test',
      responderId: 'pangu',
      originMemberId: 'tester',
      callId: 'blank-response-id-call',
    };
    await assert.rejects(
      DialogPersistence.saveSideDialogResponses(mainId, [blankResponseIdRecord], 'running'),
      /empty responseId/,
    );

    const initialRows = await loadStackRows(sideId);
    assert.equal(initialRows.length, 1);
    assert.equal(asRecord(initialRows[0]['assignmentFromAsker'])['callId'], 'call-sub-1');

    await DialogPersistence.pushTellaskReplyObligation(
      sideId,
      {
        expectedReplyCallName: 'replyTellaskBack',
        targetDialogId: mainId.selfId,
        targetCallId: 'call-back-1',
        tellaskContent: 'Ask back to the main dialog.',
      },
      'running',
    );

    await DialogPersistence.updateSideDialogAssignment(
      sideId,
      {
        ...initialAssignment,
        tellaskContent: 'Updated assignment',
        callId: 'call-sub-2',
      },
      'running',
      { replacePendingCallId: 'call-sub-1' },
    );

    const replacedRows = await loadStackRows(sideId);
    assert.equal(replacedRows.length, 2);
    assert.equal(asRecord(replacedRows[0]['assignmentFromAsker'])['callId'], 'call-sub-2');
    assert.equal(asRecord(replacedRows[0]['tellaskReplyObligation'])['targetCallId'], 'call-sub-2');
    assert.equal(
      asRecord(replacedRows[1]['tellaskReplyObligation'])['targetCallId'],
      'call-back-1',
    );
    assert.ok(
      !JSON.stringify(replacedRows).includes('call-sub-1'),
      'replace pending must remove the old frame instead of retaining stale JSONL rows',
    );

    const activeUpdated = await DialogPersistence.loadActiveTellaskReplyObligation(
      sideId,
      'running',
    );
    assert.ok(activeUpdated);
    assert.equal(activeUpdated.targetCallId, 'call-back-1');

    await DialogPersistence.setActiveTellaskReplyObligation(sideId, undefined, 'running');
    const activeUpdatedAssignment = await DialogPersistence.loadActiveTellaskReplyObligation(
      sideId,
      'running',
    );
    assert.ok(activeUpdatedAssignment);
    assert.equal(activeUpdatedAssignment.targetCallId, 'call-sub-2');
    assert.equal((await loadStackRows(sideId)).length, 1);

    await DialogPersistence.setActiveTellaskReplyObligation(sideId, undefined, 'running');
    const assignmentOnlyStack = await DialogPersistence.loadSideDialogAskerStackState(
      sideId,
      'running',
    );
    assert.ok(assignmentOnlyStack);
    assert.equal(assignmentOnlyStack.askerStack.length, 1);
    const assignmentOnlyFrame = assignmentOnlyStack.askerStack[0];
    assert.ok(assignmentOnlyFrame);
    assert.equal(assignmentOnlyFrame.tellaskReplyObligation, undefined);
    assert.equal(assignmentOnlyFrame.assignmentFromAsker.callId, 'call-sub-2');

    const previousAskerAssignment: SideDialogMetadataFile['assignmentFromAsker'] = {
      ...initialAssignment,
      tellaskContent: 'Previous asker assignment',
      callerDialogId: mainId.selfId,
      callId: 'call-from-previous-asker',
    };
    const previousAskerFrame: AskerDialogStackFrame = {
      kind: 'asker_dialog_stack_frame',
      askerDialogId: mainId.selfId,
      assignmentFromAsker: previousAskerAssignment,
      tellaskReplyObligation: {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: mainId.selfId,
        targetCallId: previousAskerAssignment.callId,
        tellaskContent: previousAskerAssignment.tellaskContent,
      },
    };
    await DialogPersistence.saveDialogAskerStack(
      sideId,
      { askerStack: [previousAskerFrame] },
      'running',
    );
    await DialogPersistence.updateSideDialogAssignment(
      sideId,
      {
        ...previousAskerAssignment,
        tellaskContent: 'New asker assignment',
        callerDialogId: 'side-asker',
        callId: 'call-from-new-asker',
      },
      'running',
      {
        replacePendingCallId: previousAskerAssignment.callId,
        replacePendingAskerDialogId: previousAskerAssignment.callerDialogId,
      },
    );
    const crossAskerRows = await loadStackRows(sideId);
    assert.equal(crossAskerRows.length, 1);
    assert.equal(
      asRecord(crossAskerRows[0]['assignmentFromAsker'])['callerDialogId'],
      'side-asker',
    );
    assert.equal(
      asRecord(crossAskerRows[0]['assignmentFromAsker'])['callId'],
      'call-from-new-asker',
    );
    assert.ok(
      !JSON.stringify(crossAskerRows).includes(previousAskerAssignment.callId),
      'cross-asker replacement must remove the old asker frame',
    );

    const duplicateAssignment: SideDialogMetadataFile['assignmentFromAsker'] = {
      ...initialAssignment,
      tellaskContent: 'Duplicate pending assignment',
      callId: 'dup-call',
    };
    const duplicateFrame: AskerDialogStackFrame = {
      kind: 'asker_dialog_stack_frame',
      askerDialogId: mainId.selfId,
      assignmentFromAsker: duplicateAssignment,
      tellaskReplyObligation: {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: mainId.selfId,
        targetCallId: duplicateAssignment.callId,
        tellaskContent: duplicateAssignment.tellaskContent,
      },
    };
    await DialogPersistence.saveDialogAskerStack(
      sideId,
      { askerStack: [duplicateFrame, duplicateFrame] },
      'running',
    );
    await assert.rejects(
      DialogPersistence.updateSideDialogAssignment(
        sideId,
        {
          ...duplicateAssignment,
          tellaskContent: 'Replacement should fail loudly',
          callId: 'replacement-call',
        },
        'running',
        { replacePendingCallId: duplicateAssignment.callId },
      ),
      /duplicate old frames/,
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
