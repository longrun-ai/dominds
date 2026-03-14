import assert from 'node:assert/strict';

import {
  assertArray,
  assertRecord,
  createPhaseGatePrimaryActionsFixture,
  extractOutput,
  parseJsonBlock,
} from './helpers/phase-gate-primary-actions-fixture';

async function main(): Promise<void> {
  const fixture = await createPhaseGatePrimaryActionsFixture();
  try {
    const pendingReviewStatus = extractOutput(
      await fixture.tools.getStatus(
        { taskDocPath: fixture.reviewTaskDocRel },
        fixture.flowMentorCtx,
      ),
    );
    assert.match(pendingReviewStatus, /- primaryAction: `dispatch_to_role` -> `builder`/);
    const pendingReviewWorkflowPolicy = parseJsonBlock(pendingReviewStatus);
    assert.equal(pendingReviewWorkflowPolicy.blockingReason, 'await_gate_reviews');
    const pendingReviewUnlockBy = pendingReviewWorkflowPolicy.unlockBy;
    assertArray(pendingReviewUnlockBy, 'pending-review unlockBy');
    assert.equal(pendingReviewUnlockBy.length, 1);
    assertRecord(pendingReviewUnlockBy[0], 'pending-review unlock target');
    assert.equal(pendingReviewUnlockBy[0].type, 'member');
    assert.equal(pendingReviewUnlockBy[0].memberId, 'owner');
    assert.deepEqual(pendingReviewUnlockBy[0].roleIds, ['builder']);
    const pendingReviewPrimaryAction = pendingReviewWorkflowPolicy.primaryAction;
    assertRecord(pendingReviewPrimaryAction, 'pending-review primaryAction');
    assert.equal(pendingReviewPrimaryAction.kind, 'dispatch_to_role');
    assert.deepEqual(pendingReviewPrimaryAction.targetRoleIds, ['builder']);

    const rejectedReviewOutput = extractOutput(
      await fixture.tools.castVote(
        {
          taskDocPath: fixture.reviewTaskDocRel,
          decision: 'reject',
          rationale: 'Acceptance inputs still need one more pass.',
        },
        fixture.ownerCtx,
      ),
    );
    assert.match(
      rejectedReviewOutput,
      /Recorded vote `reject` for gate `acceptance_input_check`\. Current tally: approve=0, reject=1, veto=0\./,
    );

    const rejectedReviewStatus = extractOutput(
      await fixture.tools.getStatus(
        { taskDocPath: fixture.reviewTaskDocRel },
        fixture.flowMentorCtx,
      ),
    );
    assert.match(rejectedReviewStatus, /- primaryAction: `dispatch_to_role` -> `builder`/);
    const rejectedReviewWorkflowPolicy = parseJsonBlock(rejectedReviewStatus);
    assert.equal(rejectedReviewWorkflowPolicy.blockingReason, 'quorum_not_met');
    const rejectedReviewUnlockBy = rejectedReviewWorkflowPolicy.unlockBy;
    assertArray(rejectedReviewUnlockBy, 'rejected-review unlockBy');
    assert.equal(rejectedReviewUnlockBy.length, 1);
    assertRecord(rejectedReviewUnlockBy[0], 'rejected-review unlock target');
    assert.equal(rejectedReviewUnlockBy[0].type, 'member');
    assert.equal(rejectedReviewUnlockBy[0].memberId, 'flow-mentor');
    assert.deepEqual(rejectedReviewUnlockBy[0].roleIds, ['flow_mentor']);

    const vetoVoteOutput = extractOutput(
      await fixture.tools.castVote(
        {
          taskDocPath: fixture.vetoTaskDocRel,
          decision: 'veto',
          rationale: 'Hard blocker remains open.',
        },
        fixture.ownerCtx,
      ),
    );
    assert.match(
      vetoVoteOutput,
      /Recorded vote `veto` for gate `acceptance_input_check`\. Current tally: approve=0, reject=0, veto=1\./,
    );

    const vetoStatus = extractOutput(
      await fixture.tools.getStatus({ taskDocPath: fixture.vetoTaskDocRel }, fixture.flowMentorCtx),
    );
    assert.match(vetoStatus, /- primaryAction: `dispatch_to_role` -> `builder`/);
    assert.match(vetoStatus, /- blockingReason: `veto_open`/);
    const vetoWorkflowPolicy = parseJsonBlock(vetoStatus);
    assert.equal(vetoWorkflowPolicy.blockingReason, 'veto_open');
    const vetoUnlockBy = vetoWorkflowPolicy.unlockBy;
    assertArray(vetoUnlockBy, 'veto unlockBy');
    assert.equal(vetoUnlockBy.length, 1);
    assertRecord(vetoUnlockBy[0], 'veto unlock target');
    assert.equal(vetoUnlockBy[0].memberId, 'flow-mentor');
    const vetoPrimaryAction = vetoWorkflowPolicy.primaryAction;
    assertRecord(vetoPrimaryAction, 'veto primaryAction');
    assert.equal(vetoPrimaryAction.kind, 'dispatch_to_role');
    assert.deepEqual(vetoPrimaryAction.targetRoleIds, ['builder']);
  } finally {
    await fixture.cleanup();
  }
}

void main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
