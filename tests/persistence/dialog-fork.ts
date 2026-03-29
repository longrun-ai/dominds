import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  DialogLatestFile,
  PendingSubdialogsReconciledRecord,
  RemindersReconciledRecord,
  RootDialogMetadataFile,
  SubdialogCreatedRecord,
  SubdialogMetadataFile,
} from '@longrun-ai/kernel/types/storage';
import { toRootGenerationAnchor } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { DialogID } from '../../main/dialog';
import { forkRootDialogTreeAtGeneration } from '../../main/dialog-fork';
import { DialogPersistence } from '../../main/persistence';

async function withTempCwd<T>(fn: (sandboxDir: string) => Promise<T>): Promise<T> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-dialog-fork-'));
  const previousCwd = process.cwd();
  process.chdir(sandboxDir);
  try {
    return await fn(sandboxDir);
  } finally {
    process.chdir(previousCwd);
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

async function writeLatest(dialogId: DialogID, currentCourse: number): Promise<void> {
  const latest: DialogLatestFile = {
    currentCourse,
    lastModified: formatUnifiedTimestamp(new Date()),
    status: 'active',
    displayState: { kind: 'idle_waiting_user' },
  };
  await DialogPersistence.mutateDialogLatest(dialogId, () => ({ kind: 'replace', next: latest }));
}

async function main(): Promise<void> {
  await withTempCwd(async () => {
    const rootId = new DialogID('11/22/rootfork');
    const subId = new DialogID('11/22/subfork', rootId.rootId);
    const nestedSubId = new DialogID('11/22/nestedfork', rootId.rootId);
    const createdAt = formatUnifiedTimestamp(new Date('2026-03-09T01:00:00.000Z'));

    const rootMeta: RootDialogMetadataFile = {
      id: rootId.selfId,
      agentId: 'rtws',
      taskDocPath: 'plans/demo.tsk',
      createdAt,
    };
    await DialogPersistence.saveDialogMetadata(rootId, rootMeta);
    await writeLatest(rootId, 1);

    const subMeta: SubdialogMetadataFile = {
      id: subId.selfId,
      agentId: 'scribe',
      taskDocPath: 'plans/demo.tsk',
      createdAt,
      supdialogId: rootId.selfId,
      assignmentFromSup: {
        callName: 'tellaskSessionless',
        mentionList: ['@scribe'],
        tellaskContent: 'Investigate',
        originMemberId: 'rtws',
        callerDialogId: rootId.selfId,
        callId: 'call-sub-1',
      },
    };
    await DialogPersistence.saveDialogMetadata(subId, subMeta);
    await writeLatest(subId, 1);

    const nestedSubMeta: SubdialogMetadataFile = {
      id: nestedSubId.selfId,
      agentId: 'critic',
      taskDocPath: 'plans/demo.tsk',
      createdAt,
      supdialogId: subId.selfId,
      assignmentFromSup: {
        callName: 'freshBootsReasoning',
        tellaskContent: 'Challenge the parent sideline.',
        originMemberId: 'scribe',
        callerDialogId: subId.selfId,
        callId: 'call-nested-1',
        effectiveFbrEffort: 1,
      },
    };
    await DialogPersistence.saveDialogMetadata(nestedSubId, nestedSubMeta);
    await writeLatest(nestedSubId, 1);

    await DialogPersistence.appendEvent(rootId, 1, {
      ts: createdAt,
      type: 'gen_start_record',
      genseq: 1,
    });
    await DialogPersistence.appendEvent(rootId, 1, {
      ts: createdAt,
      type: 'human_text_record',
      genseq: 1,
      msgId: 'msg-1',
      content: 'first prompt',
      grammar: 'markdown',
      origin: 'user',
    });
    await DialogPersistence.appendEvent(rootId, 1, {
      ts: createdAt,
      type: 'agent_words_record',
      genseq: 1,
      content: 'first answer',
    });
    const subCreatedRecord: SubdialogCreatedRecord = {
      ts: createdAt,
      type: 'subdialog_created_record',
      ...toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 1 }),
      subdialogId: subId.selfId,
      supdialogId: rootId.selfId,
      agentId: 'scribe',
      taskDocPath: 'plans/demo.tsk',
      createdAt,
      assignmentFromSup: {
        callName: 'tellaskSessionless',
        mentionList: ['@scribe'],
        tellaskContent: 'Investigate',
        originMemberId: 'rtws',
        callerDialogId: rootId.selfId,
        callId: 'call-sub-1',
      },
    };
    await DialogPersistence.appendEvent(rootId, 1, subCreatedRecord);
    const preSecondReminderRecord: RemindersReconciledRecord = {
      ts: createdAt,
      type: 'reminders_reconciled_record',
      ...toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 1 }),
      reminders: [
        {
          content: 'alpha',
          createdAt,
          priority: 'medium',
        },
      ],
    };
    await DialogPersistence.appendEvent(rootId, 1, preSecondReminderRecord);
    await DialogPersistence.appendEvent(rootId, 1, {
      ts: createdAt,
      type: 'gen_finish_record',
      genseq: 1,
    });

    await DialogPersistence.appendEvent(subId, 1, {
      ts: createdAt,
      type: 'agent_words_record',
      genseq: 1,
      content: 'subdialog baseline',
      ...toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 1 }),
    });
    await DialogPersistence.appendEvent(subId, 1, {
      ts: createdAt,
      type: 'subdialog_created_record',
      ...toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 1 }),
      subdialogId: nestedSubId.selfId,
      supdialogId: subId.selfId,
      agentId: 'critic',
      taskDocPath: 'plans/demo.tsk',
      createdAt,
      assignmentFromSup: {
        callName: 'freshBootsReasoning',
        tellaskContent: 'Challenge the parent sideline.',
        originMemberId: 'scribe',
        callerDialogId: subId.selfId,
        callId: 'call-nested-1',
        effectiveFbrEffort: 1,
      },
    });

    const secondTs = formatUnifiedTimestamp(new Date('2026-03-09T01:01:00.000Z'));
    await DialogPersistence.appendEvent(rootId, 1, {
      ts: secondTs,
      type: 'gen_start_record',
      genseq: 2,
    });
    await DialogPersistence.appendEvent(rootId, 1, {
      ts: secondTs,
      type: 'agent_words_record',
      genseq: 2,
      content: 'second answer',
    });
    const postSecondReminderRecord: RemindersReconciledRecord = {
      ts: secondTs,
      type: 'reminders_reconciled_record',
      ...toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 2 }),
      reminders: [
        {
          content: 'beta',
          createdAt: secondTs,
          priority: 'medium',
        },
      ],
    };
    await DialogPersistence.appendEvent(rootId, 1, postSecondReminderRecord);
    const postSecondPendingRecord: PendingSubdialogsReconciledRecord = {
      ts: secondTs,
      type: 'pending_subdialogs_reconciled_record',
      ...toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 2 }),
      pendingSubdialogs: [
        {
          subdialogId: subId.selfId,
          createdAt: secondTs,
          callName: 'tellaskSessionless',
          mentionList: ['@scribe'],
          tellaskContent: 'Investigate',
          targetAgentId: 'scribe',
          callId: 'call-sub-1',
          callType: 'B',
        },
      ],
    };
    await DialogPersistence.appendEvent(rootId, 1, postSecondPendingRecord);
    await DialogPersistence.appendEvent(rootId, 1, {
      ts: secondTs,
      type: 'gen_finish_record',
      genseq: 2,
    });
    await DialogPersistence.appendEvent(subId, 1, {
      ts: secondTs,
      type: 'agent_words_record',
      genseq: 2,
      content: 'subdialog future answer',
      ...toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 2 }),
    });
    await DialogPersistence.appendEvent(nestedSubId, 1, {
      ts: secondTs,
      type: 'agent_words_record',
      genseq: 1,
      content: 'nested future answer',
      ...toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 2 }),
    });

    await DialogPersistence._saveReminderState(rootId, [{ content: 'beta' }]);
    await DialogPersistence._saveReminderState(subId, [{ content: 'sub reminder' }]);

    const forkBeforeSecond = await forkRootDialogTreeAtGeneration({
      sourceRootId: rootId.selfId,
      sourceStatus: 'running',
      course: 1,
      genseq: 2,
    });
    assert.equal(forkBeforeSecond.action.kind, 'auto_continue');

    const forkedRootId = new DialogID(forkBeforeSecond.rootId);
    const forkedEvents = await DialogPersistence.readCourseEvents(forkedRootId, 1, 'running');
    assert.equal(
      forkedEvents.some((event) => event.type === 'agent_words_record' && event.genseq === 2),
      false,
      'forked root must exclude selected bubble events',
    );
    assert.equal(
      forkedEvents.some((event) => event.type === 'subdialog_created_record'),
      true,
      'forked root must include baseline subdialog-created records',
    );
    assert.equal(
      forkedEvents.some(
        (event) =>
          event.type === 'subdialog_created_record' && event.subdialogId === nestedSubId.selfId,
      ),
      false,
      'forked root must not hoist nested subdialog-created records out of their actual parent sideline',
    );
    const forkedCreatedRecord = forkedEvents.find(
      (event): event is SubdialogCreatedRecord => event.type === 'subdialog_created_record',
    );
    assert.ok(forkedCreatedRecord, 'forked root must persist baseline subdialog-created record');
    assert.equal(
      forkedCreatedRecord.supdialogId,
      forkedRootId.selfId,
      'forked baseline record must point to the new root as supdialog',
    );
    assert.equal(
      forkedCreatedRecord.assignmentFromSup.callerDialogId,
      forkedRootId.selfId,
      'forked baseline record must point to the new root as caller dialog',
    );

    const forkedReminders = await DialogPersistence.loadReminderState(forkedRootId, 'running');
    assert.deepEqual(
      forkedReminders.map((item) => item.content),
      ['alpha'],
      'forked root reminder state should roll back to pre-target snapshot',
    );

    const forkedLatest = await DialogPersistence.loadDialogLatest(forkedRootId, 'running');
    assert.equal(forkedLatest?.displayState?.kind, 'interrupted');

    const forkedSubMeta = await DialogPersistence.loadDialogMetadata(
      new DialogID(subId.selfId, forkedRootId.selfId),
      'running',
    );
    assert.ok(forkedSubMeta, 'forked subdialog metadata must exist');
    assert.equal(
      forkedSubMeta.supdialogId,
      forkedRootId.selfId,
      'forked subdialog metadata must point to the new root as supdialog',
    );
    assert.equal(
      forkedSubMeta.assignmentFromSup.callerDialogId,
      forkedRootId.selfId,
      'forked subdialog assignment must point to the new root as caller dialog',
    );
    const forkedSubEvents = await DialogPersistence.readCourseEvents(
      new DialogID(subId.selfId, forkedRootId.selfId),
      1,
      'running',
    );
    const forkedNestedCreatedRecord = forkedSubEvents.find(
      (event): event is SubdialogCreatedRecord =>
        event.type === 'subdialog_created_record' && event.subdialogId === nestedSubId.selfId,
    );
    assert.ok(
      forkedNestedCreatedRecord,
      'forked parent subdialog must keep baseline nested subdialog-created record on its own course',
    );
    assert.equal(
      forkedNestedCreatedRecord?.supdialogId,
      subId.selfId,
      'forked nested baseline record must keep the parent sideline as supdialog',
    );
    assert.equal(
      forkedNestedCreatedRecord?.assignmentFromSup.callerDialogId,
      subId.selfId,
      'forked nested baseline record must keep the parent sideline as caller dialog',
    );
    assert.equal(
      forkedSubEvents.some(
        (event) =>
          event.type === 'agent_words_record' && event.content === 'subdialog future answer',
      ),
      false,
      'forked subdialog must exclude transcript after cutoff root genseq',
    );

    const forkedNestedMeta = await DialogPersistence.loadDialogMetadata(
      new DialogID(nestedSubId.selfId, forkedRootId.selfId),
      'running',
    );
    assert.ok(forkedNestedMeta, 'forked nested subdialog metadata must exist');
    assert.equal(
      forkedNestedMeta.supdialogId,
      subId.selfId,
      'forked nested subdialog metadata must keep the parent sideline as supdialog',
    );
    assert.equal(
      forkedNestedMeta.assignmentFromSup.callerDialogId,
      subId.selfId,
      'forked nested subdialog assignment must keep the parent sideline as caller dialog',
    );

    const forkBeforeFirst = await forkRootDialogTreeAtGeneration({
      sourceRootId: rootId.selfId,
      sourceStatus: 'running',
      course: 1,
      genseq: 1,
    });
    assert.deepEqual(forkBeforeFirst.action, {
      kind: 'draft_user_text',
      userText: 'first prompt',
    });
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
