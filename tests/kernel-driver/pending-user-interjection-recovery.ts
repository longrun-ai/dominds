import assert from 'node:assert/strict';

import type {
  AgentWordsRecord,
  AnswerToHumanItem,
  HumanTextRecord,
} from '@longrun-ai/kernel/types/storage';
import { toCallSiteGenseqNo, toDialogCourseNumber } from '@longrun-ai/kernel/types/storage';
import { hasDurableDriveWork } from '../../main/dialog-drive-work';
import { DialogPersistence } from '../../main/persistence';

import { createMainDialog, withTempRtws, writeStandardMinds } from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    await writeStandardMinds(tmpRoot);

    const dlg = await createMainDialog('tester');
    const userRecord: HumanTextRecord = {
      ts: '2026-05-21T00:00:00.000Z',
      type: 'human_text_record',
      genseq: 1,
      msgId: 'pending-user-interjection-recovery-user',
      content: 'Please answer this after using a tool.',
      grammar: 'markdown',
      origin: 'user',
    };
    const preToolVisibleRecord: AgentWordsRecord = {
      ts: '2026-05-21T00:00:01.000Z',
      type: 'agent_words_record',
      genseq: 1,
      content: 'I will inspect that first.',
    };

    await DialogPersistence.appendEvent(dlg.id, 1, userRecord, dlg.status);
    await DialogPersistence.appendEvent(dlg.id, 1, preToolVisibleRecord, dlg.status);
    await DialogPersistence.appendEvent(
      dlg.id,
      1,
      {
        ts: '2026-05-21T00:00:02.000Z',
        type: 'func_call_record',
        genseq: 1,
        id: 'pending-user-interjection-recovery-call',
        name: 'env_get',
        rawArgumentsText: '{"key":"DOMINDS_TEST_PENDING_USER_INTERJECTION"}',
      },
      dlg.status,
    );

    await DialogPersistence.mutateDialogLatest(
      dlg.id,
      () => ({
        kind: 'patch',
        patch: {
          pendingUserInterjectionReply: {
            msgId: userRecord.msgId,
            course: toDialogCourseNumber(1),
            genseq: toCallSiteGenseqNo(1),
          },
        },
      }),
      dlg.status,
    );

    const pendingAfterToolCall = await DialogPersistence.loadDialogLatest(dlg.id, dlg.status);
    assert.equal(
      pendingAfterToolCall?.pendingUserInterjectionReply?.msgId,
      userRecord.msgId,
      'pre-tool visible saying must not clear pending user interjection reply',
    );
    assert.equal(
      hasDurableDriveWork(pendingAfterToolCall),
      false,
      'pending user interjection reply is a footer/business fact and must not be durable drive work',
    );

    await DialogPersistence.appendEvent(
      dlg.id,
      1,
      {
        ts: '2026-05-21T00:00:03.000Z',
        type: 'func_result_record',
        genseq: 1,
        id: 'pending-user-interjection-recovery-call',
        name: 'env_get',
        content: '(unset)',
      },
      dlg.status,
    );
    await DialogPersistence.appendEvent(
      dlg.id,
      1,
      {
        ts: '2026-05-21T00:00:04.000Z',
        type: 'agent_words_record',
        genseq: 2,
        content: 'Here is the answer after the tool result.',
      },
      dlg.status,
    );

    const recoveredAfterVisibleReply = await DialogPersistence.loadDialogLatest(dlg.id, dlg.status);
    assert.equal(
      recoveredAfterVisibleReply?.pendingUserInterjectionReply,
      undefined,
      'course JSONL recovery should clear stale latest pending state after a post-tool visible reply',
    );

    const recoveredAnswers = await DialogPersistence.loadAnswersToHumanState(dlg.id, dlg.status);
    assert.equal(
      recoveredAnswers.length,
      1,
      'course JSONL recovery should synthesize one A2H record for the visible interjection answer',
    );
    assert.equal(
      recoveredAnswers[0]?.content,
      'Here is the answer after the tool result.',
      'recovered A2H content should match the post-tool visible assistant answer',
    );

    const ordinaryDlg = await createMainDialog('tester');
    await DialogPersistence.appendEvent(
      ordinaryDlg.id,
      1,
      {
        ts: '2026-05-21T00:01:00.000Z',
        type: 'human_text_record',
        genseq: 1,
        msgId: 'ordinary-user-chat',
        content: '普通追问，不是用户插话。',
        grammar: 'markdown',
        origin: 'user',
      },
      ordinaryDlg.status,
    );
    await DialogPersistence.appendEvent(
      ordinaryDlg.id,
      1,
      {
        ts: '2026-05-21T00:01:01.000Z',
        type: 'agent_words_record',
        genseq: 1,
        content: '普通回答不应进入 A2H。',
      },
      ordinaryDlg.status,
    );
    const ordinaryLatest = await DialogPersistence.loadDialogLatest(
      ordinaryDlg.id,
      ordinaryDlg.status,
    );
    assert.equal(
      ordinaryLatest?.pendingUserInterjectionReply,
      undefined,
      'ordinary user chat should not synthesize a pending interjection marker during recovery',
    );
    const ordinaryAnswers = await DialogPersistence.loadAnswersToHumanState(
      ordinaryDlg.id,
      ordinaryDlg.status,
    );
    assert.equal(
      ordinaryAnswers.length,
      0,
      'ordinary user chat should not synthesize A2H during course JSONL recovery',
    );

    const a2hSettledDlg = await createMainDialog('tester');
    await DialogPersistence.mutateDialogLatest(
      a2hSettledDlg.id,
      () => ({
        kind: 'patch',
        patch: {
          pendingUserInterjectionReply: {
            msgId: 'a2h-settled-user-interjection',
            course: toDialogCourseNumber(1),
            genseq: toCallSiteGenseqNo(1),
          },
        },
      }),
      a2hSettledDlg.status,
    );
    await DialogPersistence.appendAnswerToHumanState(
      a2hSettledDlg.id,
      {
        id: 'a2h-existing-answer-after-pending',
        content: 'Structured answer already written before latest cleanup.',
        answeredAt: '2026-05-21T00:01:30.000Z',
        answerRef: {
          course: toDialogCourseNumber(1),
          genseq: toCallSiteGenseqNo(1),
        },
      },
      a2hSettledDlg.status,
    );
    const a2hSettledLatest = await DialogPersistence.loadDialogLatest(
      a2hSettledDlg.id,
      a2hSettledDlg.status,
    );
    assert.equal(
      a2hSettledLatest?.pendingUserInterjectionReply,
      undefined,
      'recovery should clear pending interjection when A2H was already recorded after the pending user turn',
    );

    const archivedAnswer: AnswerToHumanItem = {
      id: 'a2h-archived-ack-regression',
      content: 'Archived answer awaiting ack.',
      answeredAt: '2026-05-21T00:02:00.000Z',
      answerRef: {
        course: toDialogCourseNumber(1),
        genseq: toCallSiteGenseqNo(2),
      },
    };
    await DialogPersistence.appendAnswerToHumanState(dlg.id, archivedAnswer, dlg.status);
    await DialogPersistence.moveDialogStatus(dlg.id, 'running', 'archived');
    const runningAnswers = await DialogPersistence.loadAllA2HState();
    assert.equal(
      runningAnswers.some((answer) => answer.id === archivedAnswer.id),
      false,
      'global A2H state should only scan running dialogs after the source dialog is archived',
    );
    const archivedAnswersBeforeAck = await DialogPersistence.loadAnswersToHumanState(
      dlg.id,
      'archived',
    );
    assert.equal(
      archivedAnswersBeforeAck.length,
      2,
      'archived dialog should retain all A2H answers until they are acknowledged',
    );
    for (const answer of archivedAnswersBeforeAck) {
      const archivedAck = await DialogPersistence.acknowledgeAnswerToHumanState(
        dlg.id,
        answer.id,
        'archived',
      );
      assert.equal(
        archivedAck.found,
        true,
        `A2H Ack should work against archived dialog state for ${answer.id}`,
      );
    }
    const archivedAnswersAfterAck = await DialogPersistence.loadAnswersToHumanState(
      dlg.id,
      'archived',
    );
    assert.equal(archivedAnswersAfterAck.length, 0, 'archived A2H should be removed after Ack');
  });

  console.log('kernel-driver pending-user-interjection-recovery: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver pending-user-interjection-recovery: FAIL\n${message}`);
  process.exit(1);
});
