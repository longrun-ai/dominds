import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertArray,
  assertRecord,
  createPhaseGatePrimaryActionsFixture,
  extractOutput,
  parseJsonBlock,
  parsePhaseGateStateBlock,
} from './helpers/phase-gate-primary-actions-fixture';

async function main(): Promise<void> {
  const fixture = await createPhaseGatePrimaryActionsFixture();
  try {
    const requestRollbackOutput = extractOutput(
      await fixture.tools.requestRollback(
        {
          taskDocPath: fixture.controlTaskDocRel,
          targetPhase: 'alignment',
          reason: 'Implementation assumption proved invalid.',
        },
        fixture.ownerCtx,
      ),
    );
    assert.match(requestRollbackOutput, /Set rollback control/);

    const rollbackStatus = extractOutput(
      await fixture.tools.getStatus({ taskDocPath: fixture.controlTaskDocRel }, fixture.ownerCtx),
    );
    assert.match(rollbackStatus, /- primaryAction: `rollback` -> `alignment`/);
    const rollbackWorkflowPolicy = parseJsonBlock(rollbackStatus);
    const rollbackPrimaryAction = rollbackWorkflowPolicy.primaryAction;
    assertRecord(rollbackPrimaryAction, 'rollback primaryAction');
    assert.equal(rollbackPrimaryAction.kind, 'rollback');
    assert.equal(rollbackPrimaryAction.targetPhase, 'alignment');
    assert.equal(rollbackWorkflowPolicy.blockingReason, 'rollback_requested');
    const rollbackGate = rollbackWorkflowPolicy.gate;
    assertRecord(rollbackGate, 'rollback gate');
    assert.equal(rollbackGate.status, 'blocked');
    const rollbackRecentEvents = rollbackWorkflowPolicy.recentEvents;
    assertArray(rollbackRecentEvents, 'rollback recent events');
    assert.equal(rollbackRecentEvents.length, 1);
    assertRecord(rollbackRecentEvents[0], 'rollback recent event');
    assert.equal(rollbackRecentEvents[0].kind, 'control_set');
    assert.equal(rollbackRecentEvents[0].controlKind, 'rollback');
    assert.equal(rollbackRecentEvents[0].targetPhase, 'alignment');

    const applyRollbackOutput = extractOutput(
      await fixture.tools.applyRollback(
        { taskDocPath: fixture.controlTaskDocRel },
        fixture.ownerCtx,
      ),
    );
    assert.match(
      applyRollbackOutput,
      /Rolled back `control-case\.tsk` from phase `implementation` to `alignment`\./,
    );

    const rolledBackStatus = extractOutput(
      await fixture.tools.getStatus({ taskDocPath: fixture.controlTaskDocRel }, fixture.ownerCtx),
    );
    assert.match(rolledBackStatus, /- currentPhase: `alignment` \(Alignment\)/);
    assert.match(
      rolledBackStatus,
      /phase rolled back `implementation` -> `alignment` via `revisit_alignment` @ /,
    );
    const rolledBackWorkflowPolicy = parseJsonBlock(rolledBackStatus);
    const rolledBackPhase = rolledBackWorkflowPolicy.phase;
    assertRecord(rolledBackPhase, 'rolled-back phase');
    assert.equal(rolledBackPhase.id, 'alignment');
    assert.equal(rolledBackWorkflowPolicy.blockingReason, null);
    const rolledBackRecentEvents = rolledBackWorkflowPolicy.recentEvents;
    assertArray(rolledBackRecentEvents, 'rolled-back recent events');
    assert.deepEqual(
      rolledBackRecentEvents.map((event) => {
        assertRecord(event, 'rolled-back recent event');
        return event.kind;
      }),
      ['control_set', 'control_cleared', 'phase_rolled_back'],
    );
    const rolledBackLastEvent = rolledBackRecentEvents.at(-1);
    assertRecord(rolledBackLastEvent, 'rolled-back last event');
    assert.equal(rolledBackLastEvent.exitId, 'revisit_alignment');
    assert.equal(rolledBackLastEvent.exitKind, 'rollback');

    const clearAfterRollbackOutput = extractOutput(
      await fixture.tools.clearControl(
        { taskDocPath: fixture.controlTaskDocRel },
        fixture.ownerCtx,
      ),
    );
    assert.match(clearAfterRollbackOutput, /No explicit phase-gate control is set/);

    const stateMarkdown = await fs.readFile(
      path.join(fixture.tmpRoot, fixture.controlTaskDocRel, 'phasegate', 'state.md'),
      'utf-8',
    );
    const state = parsePhaseGateStateBlock(stateMarkdown);
    assert.equal(state.currentPhase, 'alignment');
    assert.equal(state.control, null);
    const history = state.history;
    assertArray(history, 'rollback history');
    const latestHistory = history.at(-1);
    assertRecord(latestHistory, 'rollback latest history');
    assert.equal(latestHistory.exitId, 'revisit_alignment');
    assert.equal(latestHistory.exitKind, 'rollback');
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
