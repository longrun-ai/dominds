import assert from 'node:assert/strict';

import type { AgentWordsRecord, HumanTextRecord } from '@longrun-ai/kernel/types/storage';
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
      recoveredAnswers[0]?.userInterjection.msgId,
      userRecord.msgId,
      'recovered A2H should point back to the original user interjection',
    );
    assert.equal(
      recoveredAnswers[0]?.content,
      'Here is the answer after the tool result.',
      'recovered A2H content should match the post-tool visible assistant answer',
    );
  });

  console.log('kernel-driver pending-user-interjection-recovery: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver pending-user-interjection-recovery: FAIL\n${message}`);
  process.exit(1);
});
