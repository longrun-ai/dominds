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
      0,
      'course JSONL recovery should not synthesize A2H when a direct visible answer has no later automatic drive',
    );

    const autoContinueDlg = await createMainDialog('tester');
    await DialogPersistence.appendEvent(
      autoContinueDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:10.000Z',
        type: 'human_text_record',
        genseq: 1,
        msgId: 'pending-user-interjection-auto-continue-user',
        content: 'Please answer and continue automatically.',
        grammar: 'markdown',
        origin: 'user',
      },
      autoContinueDlg.status,
    );
    await DialogPersistence.appendEvent(
      autoContinueDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:11.000Z',
        type: 'agent_words_record',
        genseq: 1,
        content: 'Here is the visible answer before automatic continuation.',
      },
      autoContinueDlg.status,
    );
    await DialogPersistence.appendEvent(
      autoContinueDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:12.000Z',
        type: 'gen_start_record',
        genseq: 2,
      },
      autoContinueDlg.status,
    );
    await DialogPersistence.appendEvent(
      autoContinueDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:13.000Z',
        type: 'agent_words_record',
        genseq: 2,
        content: 'Automatic continuation output should not replace the first visible answer.',
      },
      autoContinueDlg.status,
    );
    await DialogPersistence.mutateDialogLatest(
      autoContinueDlg.id,
      () => ({
        kind: 'patch',
        patch: {
          pendingUserInterjectionReply: {
            msgId: 'pending-user-interjection-auto-continue-user',
            course: toDialogCourseNumber(1),
            genseq: toCallSiteGenseqNo(1),
          },
        },
      }),
      autoContinueDlg.status,
    );
    const autoContinueLatest = await DialogPersistence.loadDialogLatest(
      autoContinueDlg.id,
      autoContinueDlg.status,
    );
    assert.equal(
      autoContinueLatest?.pendingUserInterjectionReply,
      undefined,
      'course JSONL recovery should clear stale latest pending state after an auto-continued visible reply',
    );
    const autoContinueAnswers = await DialogPersistence.loadAnswersToHumanState(
      autoContinueDlg.id,
      autoContinueDlg.status,
    );
    assert.equal(
      autoContinueAnswers.length,
      1,
      'course JSONL recovery should synthesize A2H when a visible interjection answer is followed by automatic drive',
    );
    assert.equal(
      autoContinueAnswers[0]?.content,
      'Here is the visible answer before automatic continuation.',
      'recovered A2H content should match the pre-continuation visible assistant answer',
    );

    const runtimeGuideAutoContinueDlg = await createMainDialog('tester');
    await DialogPersistence.appendEvent(
      runtimeGuideAutoContinueDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:15.000Z',
        type: 'human_text_record',
        genseq: 1,
        msgId: 'pending-user-interjection-before-runtime-guide',
        content: 'Please answer before the runtime guide auto continuation.',
        grammar: 'markdown',
        origin: 'user',
      },
      runtimeGuideAutoContinueDlg.status,
    );
    await DialogPersistence.appendEvent(
      runtimeGuideAutoContinueDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:16.000Z',
        type: 'agent_words_record',
        genseq: 1,
        content: 'Direct answer before a prompt-bound runtime guide continuation.',
      },
      runtimeGuideAutoContinueDlg.status,
    );
    await DialogPersistence.appendEvent(
      runtimeGuideAutoContinueDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:17.000Z',
        type: 'gen_start_record',
        genseq: 2,
        msgId: 'runtime-guide-auto-continuation',
      },
      runtimeGuideAutoContinueDlg.status,
    );
    await DialogPersistence.appendEvent(
      runtimeGuideAutoContinueDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:18.000Z',
        type: 'runtime_guide_record',
        genseq: 2,
        content: 'Runtime guide continuation evidence.',
      },
      runtimeGuideAutoContinueDlg.status,
    );
    await DialogPersistence.mutateDialogLatest(
      runtimeGuideAutoContinueDlg.id,
      () => ({
        kind: 'patch',
        patch: {
          pendingUserInterjectionReply: {
            msgId: 'pending-user-interjection-before-runtime-guide',
            course: toDialogCourseNumber(1),
            genseq: toCallSiteGenseqNo(1),
          },
        },
      }),
      runtimeGuideAutoContinueDlg.status,
    );
    await DialogPersistence.loadDialogLatest(
      runtimeGuideAutoContinueDlg.id,
      runtimeGuideAutoContinueDlg.status,
    );
    const runtimeGuideAutoContinueAnswers = await DialogPersistence.loadAnswersToHumanState(
      runtimeGuideAutoContinueDlg.id,
      runtimeGuideAutoContinueDlg.status,
    );
    assert.equal(
      runtimeGuideAutoContinueAnswers.length,
      1,
      'course JSONL recovery should synthesize one A2H from prompt-bound runtime guide continuation evidence',
    );
    assert.equal(
      runtimeGuideAutoContinueAnswers[0]?.content,
      'Direct answer before a prompt-bound runtime guide continuation.',
      'course JSONL recovery should treat prompt-bound runtime guide records as automatic continuation evidence',
    );

    const toolAutoContinueDlg = await createMainDialog('tester');
    await DialogPersistence.appendEvent(
      toolAutoContinueDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:18.100Z',
        type: 'human_text_record',
        genseq: 1,
        msgId: 'pending-user-interjection-before-auto-tool',
        content: 'Please answer before the automatic tool continuation.',
        grammar: 'markdown',
        origin: 'user',
      },
      toolAutoContinueDlg.status,
    );
    await DialogPersistence.appendEvent(
      toolAutoContinueDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:18.200Z',
        type: 'agent_words_record',
        genseq: 1,
        content: 'Direct answer before an automatic tool continuation.',
      },
      toolAutoContinueDlg.status,
    );
    await DialogPersistence.appendEvent(
      toolAutoContinueDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:18.300Z',
        type: 'gen_start_record',
        genseq: 2,
      },
      toolAutoContinueDlg.status,
    );
    await DialogPersistence.appendEvent(
      toolAutoContinueDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:18.400Z',
        type: 'func_call_record',
        genseq: 2,
        id: 'auto-tool-after-visible-answer',
        name: 'env_get',
        rawArgumentsText: '{"key":"DOMINDS_TEST_AUTO_TOOL"}',
      },
      toolAutoContinueDlg.status,
    );
    await DialogPersistence.mutateDialogLatest(
      toolAutoContinueDlg.id,
      () => ({
        kind: 'patch',
        patch: {
          pendingUserInterjectionReply: {
            msgId: 'pending-user-interjection-before-auto-tool',
            course: toDialogCourseNumber(1),
            genseq: toCallSiteGenseqNo(1),
          },
        },
      }),
      toolAutoContinueDlg.status,
    );
    const toolAutoContinueLatest = await DialogPersistence.loadDialogLatest(
      toolAutoContinueDlg.id,
      toolAutoContinueDlg.status,
    );
    assert.equal(
      toolAutoContinueLatest?.pendingUserInterjectionReply,
      undefined,
      'course JSONL recovery should clear pending when automatic continuation starts with a tool call',
    );
    const toolAutoContinueAnswers = await DialogPersistence.loadAnswersToHumanState(
      toolAutoContinueDlg.id,
      toolAutoContinueDlg.status,
    );
    assert.equal(
      toolAutoContinueAnswers.length,
      1,
      'course JSONL recovery should synthesize one A2H when automatic continuation starts with a tool call',
    );
    assert.equal(
      toolAutoContinueAnswers[0]?.content,
      'Direct answer before an automatic tool continuation.',
      'course JSONL recovery should synthesize A2H when automatic continuation starts with a tool call',
    );

    const manualNextDriveCrashDlg = await createMainDialog('tester');
    await DialogPersistence.appendEvent(
      manualNextDriveCrashDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:20.000Z',
        type: 'human_text_record',
        genseq: 1,
        msgId: 'pending-user-interjection-before-manual-crash',
        content: 'Please answer before I send another message.',
        grammar: 'markdown',
        origin: 'user',
      },
      manualNextDriveCrashDlg.status,
    );
    await DialogPersistence.appendEvent(
      manualNextDriveCrashDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:21.000Z',
        type: 'agent_words_record',
        genseq: 1,
        content: 'Direct answer before the next manual drive starts.',
      },
      manualNextDriveCrashDlg.status,
    );
    await DialogPersistence.appendEvent(
      manualNextDriveCrashDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:22.000Z',
        type: 'gen_start_record',
        genseq: 2,
        msgId: 'next-manual-user-message-not-yet-persisted',
      },
      manualNextDriveCrashDlg.status,
    );
    await DialogPersistence.mutateDialogLatest(
      manualNextDriveCrashDlg.id,
      () => ({
        kind: 'patch',
        patch: {
          pendingUserInterjectionReply: {
            msgId: 'pending-user-interjection-before-manual-crash',
            course: toDialogCourseNumber(1),
            genseq: toCallSiteGenseqNo(1),
          },
        },
      }),
      manualNextDriveCrashDlg.status,
    );
    const manualNextDriveCrashLatest = await DialogPersistence.loadDialogLatest(
      manualNextDriveCrashDlg.id,
      manualNextDriveCrashDlg.status,
    );
    assert.equal(
      manualNextDriveCrashLatest?.pendingUserInterjectionReply,
      undefined,
      'course JSONL recovery should clear stale pending state for a visible answer before a prompt-bound next gen_start',
    );
    const manualNextDriveCrashAnswers = await DialogPersistence.loadAnswersToHumanState(
      manualNextDriveCrashDlg.id,
      manualNextDriveCrashDlg.status,
    );
    assert.equal(
      manualNextDriveCrashAnswers.length,
      0,
      'course JSONL recovery should not treat a prompt-bound next gen_start as automatic drive before its prompt record is persisted',
    );

    const q4hAnswerAfterVisibleDlg = await createMainDialog('tester');
    await DialogPersistence.appendEvent(
      q4hAnswerAfterVisibleDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:30.000Z',
        type: 'human_text_record',
        genseq: 1,
        msgId: 'pending-user-interjection-before-q4h-answer',
        content: 'Please answer before I answer the pending Q4H.',
        grammar: 'markdown',
        origin: 'user',
      },
      q4hAnswerAfterVisibleDlg.status,
    );
    await DialogPersistence.appendEvent(
      q4hAnswerAfterVisibleDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:31.000Z',
        type: 'agent_words_record',
        genseq: 1,
        content: 'Direct answer before the Q4H answer continuation.',
      },
      q4hAnswerAfterVisibleDlg.status,
    );
    await DialogPersistence.appendEvent(
      q4hAnswerAfterVisibleDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:32.000Z',
        type: 'gen_start_record',
        genseq: 2,
        msgId: 'q4h-answer-msg',
      },
      q4hAnswerAfterVisibleDlg.status,
    );
    await DialogPersistence.appendEvent(
      q4hAnswerAfterVisibleDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:33.000Z',
        type: 'human_text_record',
        genseq: 2,
        msgId: 'q4h-answer-msg',
        content: 'Here is the Q4H answer.',
        grammar: 'markdown',
        origin: 'user',
        q4hAnswerCallId: 'q4h-call-after-visible-answer',
      },
      q4hAnswerAfterVisibleDlg.status,
    );
    await DialogPersistence.appendEvent(
      q4hAnswerAfterVisibleDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:34.000Z',
        type: 'agent_words_record',
        genseq: 2,
        content: 'Follow-up after the Q4H answer should not make the old direct answer A2H.',
      },
      q4hAnswerAfterVisibleDlg.status,
    );
    await DialogPersistence.appendEvent(
      q4hAnswerAfterVisibleDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:35.000Z',
        type: 'gen_start_record',
        genseq: 3,
      },
      q4hAnswerAfterVisibleDlg.status,
    );
    await DialogPersistence.appendEvent(
      q4hAnswerAfterVisibleDlg.id,
      1,
      {
        ts: '2026-05-21T00:00:36.000Z',
        type: 'agent_words_record',
        genseq: 3,
        content:
          'Automatic continuation after Q4H should still not attach to the old direct answer.',
      },
      q4hAnswerAfterVisibleDlg.status,
    );
    await DialogPersistence.mutateDialogLatest(
      q4hAnswerAfterVisibleDlg.id,
      () => ({
        kind: 'patch',
        patch: {
          pendingUserInterjectionReply: {
            msgId: 'pending-user-interjection-before-q4h-answer',
            course: toDialogCourseNumber(1),
            genseq: toCallSiteGenseqNo(1),
          },
        },
      }),
      q4hAnswerAfterVisibleDlg.status,
    );
    await DialogPersistence.loadDialogLatest(
      q4hAnswerAfterVisibleDlg.id,
      q4hAnswerAfterVisibleDlg.status,
    );
    const q4hAnswerAfterVisibleAnswers = await DialogPersistence.loadAnswersToHumanState(
      q4hAnswerAfterVisibleDlg.id,
      q4hAnswerAfterVisibleDlg.status,
    );
    assert.equal(
      q4hAnswerAfterVisibleAnswers.length,
      0,
      'course JSONL recovery should not treat a prompt-bound Q4H answer continuation as automatic drive',
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
      1,
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
