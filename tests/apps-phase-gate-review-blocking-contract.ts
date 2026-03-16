import assert from 'node:assert/strict';

import type { DomindsAppRunControlContext } from '@longrun-ai/kernel/app-host-contract';
import { renderAppRunControlBlockForPreDrive } from '../main/apps/run-control';
import {
  assertArray,
  assertRecord,
  createPhaseGatePrimaryActionsFixture,
  extractOutput,
  parseJsonBlock,
} from './helpers/phase-gate-primary-actions-fixture';

function buildRunControlContext(params: {
  agentId: string;
  taskDocPath: string;
  source?: DomindsAppRunControlContext['source'];
}): DomindsAppRunControlContext {
  return {
    dialog: { selfId: `dlg-${params.agentId}`, rootId: `root-${params.agentId}` },
    agentId: params.agentId,
    taskDocPath: params.taskDocPath,
    genIterNo: 1,
    source: params.source ?? 'drive_dlg_by_user_msg',
    input: {},
  };
}

async function main(): Promise<void> {
  const fixture = await createPhaseGatePrimaryActionsFixture();
  try {
    const runControl = fixture.host.runControls?.phase_gate_autonomy;
    assert.ok(runControl, 'expected phase_gate_autonomy run control');
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

    const rejectedReviewControl = await runControl(
      buildRunControlContext({ agentId: 'spectator', taskDocPath: fixture.reviewTaskDocRel }),
    );
    assert.equal(rejectedReviewControl.kind, 'block');
    if (rejectedReviewControl.kind !== 'block') {
      throw new Error('expected blocked run-control result for quorum_not_met');
    }
    assert.equal(rejectedReviewControl.block.blockKind, 'await_app_action');
    assert.match(
      renderAppRunControlBlockForPreDrive(rejectedReviewControl.block),
      /^View problem details\./,
    );

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

    const vetoRunControl = await runControl(
      buildRunControlContext({ agentId: 'spectator', taskDocPath: fixture.vetoTaskDocRel }),
    );
    assert.equal(vetoRunControl.kind, 'block');
    if (vetoRunControl.kind !== 'block') {
      throw new Error('expected blocked run-control result for veto_open');
    }
    assert.equal(vetoRunControl.block.blockKind, 'await_app_action');
    assert.match(
      renderAppRunControlBlockForPreDrive(vetoRunControl.block),
      /^View problem details\./,
    );
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
