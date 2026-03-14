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

    const assessmentOutput = extractOutput(
      await fixture.tools.recordAssessment(
        {
          taskDocPath: fixture.reviewTaskDocRel,
          summary: 'Implementation is ready for acceptance input check.',
          recommendation: 'approve',
        },
        fixture.ownerCtx,
      ),
    );
    assert.match(
      assessmentOutput,
      /Recorded assessment for gate `acceptance_input_check` as role `builder`\./,
    );

    const rejectedVoteOutput = extractOutput(
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
      rejectedVoteOutput,
      /Recorded vote `reject` for gate `acceptance_input_check`\. Current tally: approve=0, reject=1, veto=0\./,
    );

    const approvedVoteOutput = extractOutput(
      await fixture.tools.castVote(
        {
          taskDocPath: fixture.reviewTaskDocRel,
          decision: 'approve',
          rationale: 'Acceptance inputs are ready.',
        },
        fixture.ownerCtx,
      ),
    );
    assert.match(
      approvedVoteOutput,
      /Recorded vote `approve` for gate `acceptance_input_check`; quorum passed and phase advanced to `acceptance` via `advance`\./,
    );

    const finalStatus = extractOutput(
      await fixture.tools.getStatus({ taskDocPath: fixture.reviewTaskDocRel }, fixture.ownerCtx),
    );
    assert.match(finalStatus, /phase advanced `implementation` -> `acceptance` via `advance` @ /);
    const workflowPolicy = parseJsonBlock(finalStatus);
    const recentEvents = workflowPolicy.recentEvents;
    assertArray(recentEvents, 'review recent events');
    assert.deepEqual(
      recentEvents.map((event) => {
        assertRecord(event, 'review recent event');
        return event.kind;
      }),
      ['assessment_recorded', 'vote_cast', 'vote_cast', 'phase_advanced'],
    );
    const phase = workflowPolicy.phase;
    assertRecord(phase, 'review phase');
    assert.equal(phase.id, 'acceptance');
    assert.equal(workflowPolicy.gate, null);
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
