import assert from 'node:assert/strict';

import { DialogID, MainDialog } from '../../main/dialog';
import { maybePrepareDiligenceAutoContinuePrompt } from '../../main/llm/kernel-driver/runtime';
import { DialogPersistence, DiskFileDialogStore } from '../../main/persistence';

import { withTempRtws } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async () => {
    const dlg = new MainDialog(
      new DiskFileDialogStore(new DialogID('diligence-retry-recovery-budget-test')),
      'task.md',
      new DialogID('diligence-retry-recovery-budget-test'),
      'tester',
    );
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
    if (recovery.kind !== 'prompt') {
      throw new Error(`Expected retry recovery to prepare a prompt, got ${recovery.kind}`);
    }
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
    if (manuallyRefilledWithZeroDefault.kind !== 'prompt') {
      throw new Error(
        `Expected manual dialog budget to prepare a prompt, got ${manuallyRefilledWithZeroDefault.kind}`,
      );
    }
    assert.equal(manuallyRefilledWithZeroDefault.maxInjectCount, 0);
    assert.equal(manuallyRefilledWithZeroDefault.nextRemainingBudget, 2);

    const manuallyExpandedAbovePositiveDefault = await maybePrepareDiligenceAutoContinuePrompt({
      dlg,
      remainingBudget: 7,
      diligencePushMax: 2,
    });
    assert.equal(manuallyExpandedAbovePositiveDefault.kind, 'prompt');
    if (manuallyExpandedAbovePositiveDefault.kind !== 'prompt') {
      throw new Error(
        `Expected expanded dialog budget to prepare a prompt, got ${manuallyExpandedAbovePositiveDefault.kind}`,
      );
    }
    assert.equal(manuallyExpandedAbovePositiveDefault.maxInjectCount, 2);
    assert.equal(manuallyExpandedAbovePositiveDefault.nextRemainingBudget, 6);

    const recoveryWithOrdinaryKeepGoingDisabled = await maybePrepareDiligenceAutoContinuePrompt({
      dlg,
      remainingBudget: 0,
      diligencePushMax: 0,
      ignoreBudgetExhaustion: true,
    });
    assert.equal(recoveryWithOrdinaryKeepGoingDisabled.kind, 'prompt');

    await DialogPersistence.setActiveTellaskReplyObligation(dlg.id, {
      expectedReplyCallName: 'replyTellaskBack',
      targetDialogId: dlg.id.selfId,
      targetCallId: 'active-reply-obligation-blocks-diligence',
      tellaskContent: 'Finish this reply obligation before any Diligence Push.',
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
