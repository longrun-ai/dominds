import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import type { DomindsAppRunControlContext } from '@longrun-ai/kernel/app-host-contract';
import { renderAppRunControlBlockForPreDrive } from '../main/apps/run-control';
import {
  assertRecord,
  createPhaseGatePrimaryActionsFixture,
  extractOutput,
  parseJsonBlock,
  parsePhaseGateStateBlock,
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
    const manualVoteOutput = extractOutput(
      await fixture.tools.castVote(
        {
          taskDocPath: fixture.manualTaskDocRel,
          decision: 'approve',
          rationale: 'Implementation is complete but needs committee escalation.',
        },
        fixture.ownerCtx,
      ),
    );
    assert.match(
      manualVoteOutput,
      /Recorded vote `approve` for gate `implementation_signoff`; quorum passed and flow mentor must now select a manual exit: `ship_small_change`, `escalate_committee`\./,
    );

    const manualSelectionStatus = extractOutput(
      await fixture.tools.getStatus(
        { taskDocPath: fixture.manualTaskDocRel },
        fixture.flowMentorCtx,
      ),
    );
    assert.match(
      manualSelectionStatus,
      /- primaryAction: `select_exit` -> `ship_small_change` -> `acceptance`, `escalate_committee` -> `committee_review`/,
    );
    assert.match(manualSelectionStatus, /- blockingReason: `manual_exit_required`/);
    assert.match(
      manualSelectionStatus,
      /- currentPath: `triage` -> `implementation` via `small_change_path`/,
    );
    assert.match(manualSelectionStatus, /- latestEscalation: \(none\)/);
    const manualSelectionPolicy = parseJsonBlock(manualSelectionStatus);
    assert.equal(manualSelectionPolicy.blockingReason, 'manual_exit_required');
    const manualSelectionGate = manualSelectionPolicy.gate;
    assertRecord(manualSelectionGate, 'manual-selection gate');
    assert.deepEqual(manualSelectionGate.manualExitIds, [
      'ship_small_change',
      'escalate_committee',
    ]);
    assert.equal(manualSelectionGate.autoAdvanceExitId, null);
    const manualSelectionRouting = manualSelectionPolicy.routing;
    assertRecord(manualSelectionRouting, 'manual-selection routing');
    assertRecord(manualSelectionRouting.currentPath, 'manual-selection currentPath');
    assert.equal(manualSelectionRouting.currentPath.exitId, 'small_change_path');
    assert.equal(manualSelectionRouting.latestEscalation, null);

    const manualRunControl = await runControl(
      buildRunControlContext({ agentId: 'spectator', taskDocPath: fixture.manualTaskDocRel }),
    );
    assert.equal(manualRunControl.kind, 'block');
    if (manualRunControl.kind !== 'block') {
      throw new Error('expected blocked run-control result for manual exit selection');
    }
    assert.equal(manualRunControl.block.blockKind, 'await_app_action');
    if (manualRunControl.block.blockKind !== 'await_app_action') {
      throw new Error('expected await_app_action block for manual exit selection');
    }
    assert.equal(manualRunControl.block.actionClass, 'select');
    assert.deepEqual(manualRunControl.block.optionsSummary, [
      'ship_small_change -> acceptance',
      'escalate_committee -> committee_review',
    ]);
    assert.match(renderAppRunControlBlockForPreDrive(manualRunControl.block), /Choose an option/);

    const selectExitOutput = extractOutput(
      await fixture.tools.selectExit(
        {
          taskDocPath: fixture.manualTaskDocRel,
          exitId: 'escalate_committee',
        },
        fixture.flowMentorCtx,
      ),
    );
    assert.match(
      selectExitOutput,
      /Selected manual exit `escalate_committee` for gate `implementation_signoff`; phase advanced to `committee_review`\./,
    );

    const manualEscalatedStatus = extractOutput(
      await fixture.tools.getStatus(
        { taskDocPath: fixture.manualTaskDocRel },
        fixture.flowMentorCtx,
      ),
    );
    assert.match(manualEscalatedStatus, /- currentPhase: `committee_review` \(Committee Review\)/);
    assert.match(
      manualEscalatedStatus,
      /phase advanced `implementation` -> `committee_review` via `escalate_committee` @ /,
    );
    assert.match(
      manualEscalatedStatus,
      /- latestEscalation: `implementation` -> `committee_review` via `escalate_committee` \(Expert committee\)/,
    );
    const manualEscalatedPolicy = parseJsonBlock(manualEscalatedStatus);
    const manualEscalatedPhase = manualEscalatedPolicy.phase;
    assertRecord(manualEscalatedPhase, 'manual-escalated phase');
    assert.equal(manualEscalatedPhase.id, 'committee_review');
    const manualEscalatedRouting = manualEscalatedPolicy.routing;
    assertRecord(manualEscalatedRouting, 'manual-escalated routing');
    assertRecord(manualEscalatedRouting.currentPath, 'manual-escalated currentPath');
    assert.equal(manualEscalatedRouting.currentPath.exitId, 'small_change_path');
    assertRecord(manualEscalatedRouting.latestEscalation, 'manual-escalated latestEscalation');
    assert.equal(manualEscalatedRouting.latestEscalation.exitId, 'escalate_committee');

    const stateMarkdown = await fs.readFile(
      path.join(fixture.tmpRoot, fixture.manualTaskDocRel, 'phasegate', 'state.md'),
      'utf-8',
    );
    const state = parsePhaseGateStateBlock(stateMarkdown);
    assert.equal(state.currentPhase, 'committee_review');
    const history = state.history;
    assert.ok(Array.isArray(history), 'manual history must be an array');
    const latestHistory = history.at(-1);
    assertRecord(latestHistory, 'manual latest history');
    assert.equal(latestHistory.exitId, 'escalate_committee');
    assert.equal(latestHistory.exitKind, 'escalate');
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
