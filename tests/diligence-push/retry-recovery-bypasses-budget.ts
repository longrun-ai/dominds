import assert from 'node:assert/strict';

import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import { maybePrepareDiligenceAutoContinuePrompt } from '../../main/llm/kernel-driver/runtime';
import { DialogPersistence } from '../../main/persistence';

import { createMainDialog, withTempRtws, writeStandardMinds } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws, { extraMembers: ['worker'] });
    const dlg = await createMainDialog();
    dlg.disableDiligencePush = false;

    const ordinary = await maybePrepareDiligenceAutoContinuePrompt({
      dlg,
      remainingBudget: 0,
      diligencePushMax: 2,
    });
    assert.equal(ordinary.kind, 'budget_exhausted');
    assert.equal(ordinary.nextRemainingBudget, 0);

    const recovery = await maybePrepareDiligenceAutoContinuePrompt({
      dlg,
      remainingBudget: 0,
      diligencePushMax: 2,
      ignoreBudgetExhaustion: true,
    });
    assert.equal(recovery.kind, 'prompt');
    assert.equal(recovery.nextRemainingBudget, 0);
    assert.equal(recovery.prompt.origin, 'diligence_push');

    dlg.disableDiligencePush = true;
    const disabled = await maybePrepareDiligenceAutoContinuePrompt({
      dlg,
      remainingBudget: 0,
      diligencePushMax: 2,
      ignoreBudgetExhaustion: true,
    });
    assert.equal(disabled.kind, 'disabled');

    dlg.disableDiligencePush = false;
    const zeroRemainingWithZeroDefault = await maybePrepareDiligenceAutoContinuePrompt({
      dlg,
      remainingBudget: 0,
      diligencePushMax: 0,
    });
    assert.equal(zeroRemainingWithZeroDefault.kind, 'disabled');
    assert.equal(zeroRemainingWithZeroDefault.nextRemainingBudget, 0);

    const manuallyRefilledWithZeroDefault = await maybePrepareDiligenceAutoContinuePrompt({
      dlg,
      remainingBudget: 3,
      diligencePushMax: 0,
    });
    assert.equal(manuallyRefilledWithZeroDefault.kind, 'prompt');
    assert.equal(manuallyRefilledWithZeroDefault.maxInjectCount, 0);
    assert.equal(manuallyRefilledWithZeroDefault.nextRemainingBudget, 2);

    const manuallyExpandedAbovePositiveDefault = await maybePrepareDiligenceAutoContinuePrompt({
      dlg,
      remainingBudget: 7,
      diligencePushMax: 2,
    });
    assert.equal(manuallyExpandedAbovePositiveDefault.kind, 'prompt');
    assert.equal(manuallyExpandedAbovePositiveDefault.maxInjectCount, 2);
    assert.equal(manuallyExpandedAbovePositiveDefault.nextRemainingBudget, 6);

    const recoveryWithOrdinaryKeepGoingDisabled = await maybePrepareDiligenceAutoContinuePrompt({
      dlg,
      remainingBudget: 0,
      diligencePushMax: 0,
      ignoreBudgetExhaustion: true,
    });
    assert.equal(recoveryWithOrdinaryKeepGoingDisabled.kind, 'prompt');

    const requester = await dlg.createSideDialog('worker', ['@worker'], 'work-data', {
      callName: 'tellask',
      originMemberId: 'tester',
      askerDialogId: dlg.id.selfId,
      callId: 'work-call',
      callSiteCourse: toCallSiteCourseNo(1),
      callSiteGenseq: toCallSiteGenseqNo(1),
      sessionSlug: 'budget-gate',
      collectiveTargets: ['worker'],
    });
    await requester.persistTellaskCall(
      'active-reply-obligation-blocks-diligence',
      'tellaskBack',
      JSON.stringify({ tellaskContent: 'question-data' }),
      1,
    );
    await DialogPersistence.pushTellaskReplyObligation(dlg.id, {
      expectedReplyCallName: 'replyTellaskBack',
      targetDialogId: requester.id.selfId,
      targetCallId: 'active-reply-obligation-blocks-diligence',
      tellaskContent: 'question-data',
    });
    const activeReplyObligation = await maybePrepareDiligenceAutoContinuePrompt({
      dlg,
      remainingBudget: 3,
      diligencePushMax: 2,
      ignoreBudgetExhaustion: true,
    });
    assert.equal(activeReplyObligation.kind, 'disabled');
    assert.equal(activeReplyObligation.nextRemainingBudget, 3);
  });

  console.log('diligence retry recovery bypasses budget: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`diligence retry recovery bypasses budget: FAIL\n${message}`);
  process.exit(1);
});
