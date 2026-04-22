import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  DialogLatestFile,
  MainDialogMetadataFile,
  PendingSideDialogsReconciledRecord,
  RemindersReconciledRecord,
  SideDialogCreatedRecord,
  SideDialogMetadataFile,
} from '@longrun-ai/kernel/types/storage';
import { toRootGenerationAnchor } from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { DialogID } from '../../main/dialog';
import { forkMainDialogTreeAtGeneration } from '../../main/dialog-fork';
import { DialogPersistence } from '../../main/persistence';
import { materializeReminder } from '../../main/tool';

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

    const rootMeta: MainDialogMetadataFile = {
      id: rootId.selfId,
      agentId: 'rtws',
      taskDocPath: 'plans/demo.tsk',
      createdAt,
    };
    await DialogPersistence.saveDialogMetadata(rootId, rootMeta);
    await writeLatest(rootId, 1);
    await DialogPersistence.pushTellaskReplyObligation(rootId, {
      expectedReplyCallName: 'replyTellaskBack',
      targetCallId: 'root-askback-call',
      targetDialogId: rootId.selfId,
      tellaskContent: 'Resolve the active root ask-back.',
    });

    const subMeta: SideDialogMetadataFile = {
      id: subId.selfId,
      agentId: 'scribe',
      taskDocPath: 'plans/demo.tsk',
      createdAt,
      askerDialogId: rootId.selfId,
      assignmentFromAsker: {
        callName: 'tellaskSessionless',
        mentionList: ['@scribe'],
        tellaskContent: 'Investigate',
        originMemberId: 'rtws',
        callerDialogId: rootId.selfId,
        callId: 'call-sub-1',
      },
    };
    await DialogPersistence.ensureSideDialogDirectory(subId, 'running');
    await DialogPersistence.saveDialogMetadata(subId, subMeta);
    await writeLatest(subId, 1);

    const nestedSubMeta: SideDialogMetadataFile = {
      id: nestedSubId.selfId,
      agentId: 'critic',
      taskDocPath: 'plans/demo.tsk',
      createdAt,
      askerDialogId: subId.selfId,
      assignmentFromAsker: {
        callName: 'freshBootsReasoning',
        tellaskContent: 'Challenge the parent side dialog.',
        originMemberId: 'scribe',
        callerDialogId: subId.selfId,
        callId: 'call-nested-1',
        effectiveFbrEffort: 1,
      },
    };
    await DialogPersistence.ensureSideDialogDirectory(nestedSubId, 'running');
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
    const subCreatedRecord: SideDialogCreatedRecord = {
      ts: createdAt,
      type: 'sideDialog_created_record',
      ...toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 1 }),
      sideDialogId: subId.selfId,
      askerDialogId: rootId.selfId,
      agentId: 'scribe',
      taskDocPath: 'plans/demo.tsk',
      createdAt,
      assignmentFromAsker: {
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
          id: 'alpha-reminder',
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
      content: 'sideDialog baseline',
      ...toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 1 }),
    });
    await DialogPersistence.appendEvent(subId, 1, {
      ts: createdAt,
      type: 'sideDialog_created_record',
      ...toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 1 }),
      sideDialogId: nestedSubId.selfId,
      askerDialogId: subId.selfId,
      agentId: 'critic',
      taskDocPath: 'plans/demo.tsk',
      createdAt,
      assignmentFromAsker: {
        callName: 'freshBootsReasoning',
        tellaskContent: 'Challenge the parent side dialog.',
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
          id: 'beta-reminder',
          content: 'beta',
          createdAt: secondTs,
          priority: 'medium',
        },
      ],
    };
    await DialogPersistence.appendEvent(rootId, 1, postSecondReminderRecord);
    const postSecondPendingRecord: PendingSideDialogsReconciledRecord = {
      ts: secondTs,
      type: 'pending_sideDialogs_reconciled_record',
      ...toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 2 }),
      pendingSideDialogs: [
        {
          sideDialogId: subId.selfId,
          createdAt: secondTs,
          callName: 'tellaskSessionless',
          mentionList: ['@scribe'],
          tellaskContent: 'Investigate',
          targetAgentId: 'scribe',
          callId: 'call-sub-1',
          callingCourse: 1,
          callingGenseq: 1,
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
      content: 'sideDialog future answer',
      ...toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 2 }),
    });
    await DialogPersistence.appendEvent(nestedSubId, 1, {
      ts: secondTs,
      type: 'agent_words_record',
      genseq: 1,
      content: 'nested future answer',
      ...toRootGenerationAnchor({ rootCourse: 1, rootGenseq: 2 }),
    });

    await DialogPersistence._saveReminderState(rootId, [
      materializeReminder({ id: 'beta-reminder', content: 'beta' }),
    ]);
    await DialogPersistence._saveReminderState(subId, [
      materializeReminder({ id: 'sub-reminder', content: 'sub reminder' }),
    ]);

    const forkBeforeSecond = await forkMainDialogTreeAtGeneration({
      sourceRootId: rootId.selfId,
      sourceStatus: 'running',
      course: 1,
      genseq: 2,
    });
    assert.equal(forkBeforeSecond.action.kind, 'auto_continue');

    const forkedRootId = new DialogID(forkBeforeSecond.rootId);
    const forkedRootAskerStack = await DialogPersistence.loadDialogAskerStack(
      forkedRootId,
      'running',
    );
    assert.deepEqual(
      forkedRootAskerStack.askerStack,
      [
        {
          kind: 'asker_dialog_stack_frame',
          askerDialogId: forkedRootId.selfId,
          tellaskReplyObligation: {
            expectedReplyCallName: 'replyTellaskBack',
            targetCallId: 'root-askback-call',
            targetDialogId: forkedRootId.selfId,
            tellaskContent: 'Resolve the active root ask-back.',
          },
        },
      ],
      'forked main dialog must preserve active main reply obligation stack and rewrite the main target',
    );
    const forkedEvents = await DialogPersistence.readCourseEvents(forkedRootId, 1, 'running');
    assert.equal(
      forkedEvents.some((event) => event.type === 'agent_words_record' && event.genseq === 2),
      false,
      'forked main dialog must exclude selected bubble events',
    );
    assert.equal(
      forkedEvents.some((event) => event.type === 'sideDialog_created_record'),
      true,
      'forked main dialog must include baseline sideDialog-created records',
    );
    assert.equal(
      forkedEvents.some(
        (event) =>
          event.type === 'sideDialog_created_record' && event.sideDialogId === nestedSubId.selfId,
      ),
      false,
      'forked main dialog must not hoist nested sideDialog-created records out of their actual parent side dialog',
    );
    const forkedCreatedRecord = forkedEvents.find(
      (event): event is SideDialogCreatedRecord => event.type === 'sideDialog_created_record',
    );
    assert.ok(
      forkedCreatedRecord,
      'forked main dialog must persist baseline sideDialog-created record',
    );
    assert.equal(
      forkedCreatedRecord.askerDialogId,
      forkedRootId.selfId,
      'forked baseline record must point to the new main dialog as askerDialog',
    );
    assert.equal(
      forkedCreatedRecord.assignmentFromAsker.callerDialogId,
      forkedRootId.selfId,
      'forked baseline record must point to the new main dialog as requester',
    );

    const forkedReminders = await DialogPersistence.loadReminderState(forkedRootId, 'running');
    assert.deepEqual(
      forkedReminders.map((item) => item.content),
      ['alpha'],
      'forked main dialog reminder state should roll back to pre-target snapshot',
    );

    const forkedLatest = await DialogPersistence.loadDialogLatest(forkedRootId, 'running');
    assert.deepEqual(forkedLatest?.displayState, {
      kind: 'stopped',
      reason: { kind: 'fork_continue_ready' },
      continueEnabled: true,
    });

    const forkedSubMeta = await DialogPersistence.loadDialogMetadata(
      new DialogID(subId.selfId, forkedRootId.selfId),
      'running',
    );
    assert.ok(forkedSubMeta, 'forked sideDialog metadata must exist');
    assert.equal(
      forkedSubMeta.askerDialogId,
      forkedRootId.selfId,
      'forked sideDialog metadata must point to the new root as askerDialog',
    );
    assert.equal(
      forkedSubMeta.assignmentFromAsker.callerDialogId,
      forkedRootId.selfId,
      'forked sideDialog assignment must point to the new main dialog requester',
    );
    const forkedSubEvents = await DialogPersistence.readCourseEvents(
      new DialogID(subId.selfId, forkedRootId.selfId),
      1,
      'running',
    );
    const forkedNestedCreatedRecord = forkedSubEvents.find(
      (event): event is SideDialogCreatedRecord =>
        event.type === 'sideDialog_created_record' && event.sideDialogId === nestedSubId.selfId,
    );
    assert.ok(
      forkedNestedCreatedRecord,
      'forked parent sideDialog must keep baseline nested sideDialog-created record on its own course',
    );
    assert.equal(
      forkedNestedCreatedRecord?.askerDialogId,
      subId.selfId,
      'forked nested baseline record must keep the parent side dialog as askerDialog',
    );
    assert.equal(
      forkedNestedCreatedRecord?.assignmentFromAsker.callerDialogId,
      subId.selfId,
      'forked nested baseline record must keep the requesting side dialog',
    );
    assert.equal(
      forkedSubEvents.some(
        (event) =>
          event.type === 'agent_words_record' && event.content === 'sideDialog future answer',
      ),
      false,
      'forked sideDialog must exclude transcript after cutoff root genseq',
    );

    const forkedNestedMeta = await DialogPersistence.loadDialogMetadata(
      new DialogID(nestedSubId.selfId, forkedRootId.selfId),
      'running',
    );
    assert.ok(forkedNestedMeta, 'forked nested sideDialog metadata must exist');
    assert.equal(
      forkedNestedMeta.askerDialogId,
      subId.selfId,
      'forked nested sideDialog metadata must keep the parent side dialog as askerDialog',
    );
    assert.equal(
      forkedNestedMeta.assignmentFromAsker.callerDialogId,
      subId.selfId,
      'forked nested sideDialog assignment must keep the requesting side dialog',
    );

    const forkBeforeFirst = await forkMainDialogTreeAtGeneration({
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
