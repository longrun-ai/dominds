import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import YAML from 'yaml';
import {
  createEmptyDialogNextStepState,
  createEmptyDialogTellaskCallState,
  createEmptyDialogTellaskResultState,
} from '../../main/dialog-latest-state';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { withTempRtws } from '../kernel-driver/helpers';

import type {
  AskerDialogStackFrame,
  MainDialogMetadataFile,
  SideDialogAssignmentFromAsker,
  SideDialogMetadataFile,
  SideDialogResponseStateRecord,
} from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { DialogID } from '../../main/dialog';
import { DialogPersistence } from '../../main/persistence';

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected JSON object');
  }
  return value as Record<string, unknown>;
}

async function loadStackRows(dialogId: DialogID): Promise<Record<string, unknown>[]> {
  const stackPath = path.join(
    DialogPersistence.getSideDialogPath(dialogId, 'running'),
    'asker-stack.jsonl',
  );
  const raw = await fs.readFile(stackPath, 'utf-8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => asRecord(JSON.parse(line)));
}

const evidence = semanticEvidenceCollector('dominds-persistence-asker-stack-');
async function main(): Promise<void> {
  await withTempRtws(async () => {
    const createdAt = formatUnifiedTimestamp(new Date('2026-04-21T00:00:00.000Z'));
    const mainId = new DialogID('main');
    const sideId = new DialogID('side', mainId.rootId);
    const mainMeta: MainDialogMetadataFile = {
      id: mainId.selfId,
      agentId: 'tester',
      taskDocPath: 'plans/asker-stack.tsk',
      createdAt,
    };
    const initialAssignment: SideDialogAssignmentFromAsker = {
      callName: 'tellask',
      mentionList: ['@pangu'],
      tellaskContent: 'Initial assignment',
      originMemberId: 'tester',
      askerDialogId: mainId.selfId,
      callId: 'call-sub-1',
      collectiveTargets: ['pangu'],
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
    };
    const sideMeta: SideDialogMetadataFile = {
      id: sideId.selfId,
      agentId: 'pangu',
      taskDocPath: 'plans/asker-stack.tsk',
      createdAt,
      sessionSlug: 'sticky',
    };
    const initialFrame: AskerDialogStackFrame = {
      kind: 'asker_dialog_stack_frame',
      askerDialogId: mainId.selfId,
      assignmentFromAsker: initialAssignment,
      tellaskReplyObligation: {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: mainId.selfId,
        targetCallId: initialAssignment.callId,
        tellaskContent: initialAssignment.tellaskContent,
      },
    };

    await DialogPersistence.saveMainDialogMetadata(mainId, mainMeta, 'running');
    await DialogPersistence.ensureSideDialogDirectory(sideId, 'running');
    await DialogPersistence.saveSideDialogAskerStackState(
      sideId,
      { askerStack: [initialFrame] },
      'running',
    );
    await DialogPersistence.saveSideDialogMetadata(sideId, sideMeta, 'running');
    for (const id of [mainId, sideId]) {
      await DialogPersistence.mutateDialogLatest(id, () => ({
        kind: 'replace',
        next: {
          currentCourse: 1,
          lastModified: createdAt,
          status: 'active',
          nextStep: createEmptyDialogNextStepState(),
          tellaskCalls: createEmptyDialogTellaskCallState(),
          tellaskResults: createEmptyDialogTellaskResultState(),
        },
      }));
    }
    const sideMetadataYaml = await fs.readFile(
      path.join(DialogPersistence.getSideDialogPath(sideId, 'running'), 'dialog.yaml'),
      'utf-8',
    );
    const savedMetadata = asRecord(YAML.parse(sideMetadataYaml));
    assert.equal(savedMetadata.askerDialogId, undefined);
    assert.equal(savedMetadata.assignmentFromAsker, undefined);
    await assert.rejects(
      DialogPersistence.loadSideDialogAssignmentFromAsker(mainId, 'running'),
      Error,
    );
    const wrongId = new DialogID('different-side', mainId.rootId);
    await assert.rejects(
      DialogPersistence.saveSideDialogMetadata(wrongId, sideMeta, 'running'),
      Error,
    );
    await assert.rejects(fs.stat(DialogPersistence.getSideDialogPath(wrongId, 'running')), {
      code: 'ENOENT',
    });
    assert.equal(
      await fs.readFile(
        path.join(DialogPersistence.getSideDialogPath(sideId, 'running'), 'dialog.yaml'),
        'utf8',
      ),
      sideMetadataYaml,
    );

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
      DialogPersistence.saveSideDialogResponses(
        mainId,
        [blankResponseIdRecord],
        undefined,
        'running',
      ),
      Error,
    );

    assert.deepEqual(await DialogPersistence.loadSideDialogResponses(mainId, 'running'), []);
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
    assert.ok(assignmentOnlyFrame.assignmentFromAsker);
    assert.equal(assignmentOnlyFrame.assignmentFromAsker.callId, 'call-sub-2');

    const previousAskerAssignment: SideDialogAssignmentFromAsker = {
      ...initialAssignment,
      tellaskContent: 'Previous asker assignment',
      askerDialogId: mainId.selfId,
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
        askerDialogId: 'side-asker',
        callId: 'call-from-new-asker',
      },
      'running',
      {
        replacePendingCallId: previousAskerAssignment.callId,
        replacePendingAskerDialogId: previousAskerAssignment.askerDialogId,
      },
    );
    const crossAskerRows = await loadStackRows(sideId);
    assert.equal(crossAskerRows.length, 1);
    assert.equal(asRecord(crossAskerRows[0]['assignmentFromAsker'])['askerDialogId'], 'side-asker');
    assert.equal(
      asRecord(crossAskerRows[0]['assignmentFromAsker'])['callId'],
      'call-from-new-asker',
    );
    assert.equal(crossAskerRows[0]['askerDialogId'], 'side-asker');
    const crossObligation = asRecord(crossAskerRows[0]['tellaskReplyObligation']);
    assert.equal(crossObligation['targetCallId'], 'call-from-new-asker');
    assert.equal(crossObligation['targetDialogId'], 'side-asker');
    assert.equal(crossObligation['tellaskContent'], 'New asker assignment');
    const duplicateAssignment: SideDialogAssignmentFromAsker = {
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
    const beforeDuplicate = await loadStackRows(sideId);
    let actualError = '';
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
      (error: unknown) => {
        assert.ok(error instanceof Error);
        actualError = error.message;
        return true;
      },
    );
    assert.deepEqual(await loadStackRows(sideId), beforeDuplicate);
    evidence.record({
      id: 'duplicate-pending',
      scenario:
        'A pending assignment is replaced while a newer ask-back remains on top, and can be replaced across requesters. A later deliberately duplicated old frame makes replacement fail before any JSONL rows change.',
      businessValue:
        'Prevent an ambiguous update from dropping a requester or reply obligation and diagnose the refused replacement.',
      context: {
        oldMatchingFrames: 2,
        rowsUnchangedAfterRefusal: true,
        priorCrossRequesterReplacementSucceeded: true,
        scope:
          'Direct persisted JSONL stack operations; no model, delivery scheduling or process-restart claim.',
      },
      reviewQuestions: [
        'Does the actual error identify the duplicate-frame ambiguity and the affected dialog without implying that a replacement was committed?',
      ],
      actualText: actualError,
    });
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
