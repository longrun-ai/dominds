import assert from 'node:assert/strict';

import {
  createPhaseGateFixture,
  expectToolError,
  extractOutput,
  incompatiblePreserveStateFlow,
  parseJsonBlock,
  resolvePhaseGateFixture,
} from './helpers/phase-gate-flow-fixture';

async function main(): Promise<void> {
  const fixture = await createPhaseGateFixture();
  try {
    const preservedStatus = extractOutput(
      await fixture.tools.getStatus({ taskDocPath: fixture.taskDocRel }, fixture.toolCtx),
    );
    assert.match(preservedStatus, /- currentPhase: `implementation` \(Implementation\)/);
    const preservedWorkflowPolicy = parseJsonBlock(preservedStatus);
    const preservedPhase = preservedWorkflowPolicy.phase;
    assert.equal(typeof preservedPhase, 'object');
    assert.notEqual(preservedPhase, null);
    assert.equal((preservedPhase as Record<string, unknown>).id, 'implementation');
    const preservedRecentEvents = preservedWorkflowPolicy.recentEvents;
    assert.ok(Array.isArray(preservedRecentEvents), 'expected recentEvents array');
    assert.equal(preservedRecentEvents.length, 1);

    const incompatibleReplaceMessage = await expectToolError(
      fixture.tools.replaceFlow,
      {
        taskDocPath: fixture.taskDocRel,
        content: resolvePhaseGateFixture(incompatiblePreserveStateFlow),
      },
      fixture.toolCtx,
    );
    assert.match(
      incompatibleReplaceMessage,
      /state\.assessments\[0\]\.gateId 'acceptance_input_check' is not declared in the flow/,
    );

    const incompatibleInitMessage = await expectToolError(
      fixture.tools.initFlow,
      {
        taskDocPath: fixture.taskDocRel,
        templateId: 'web_dev_acceptance',
        overwrite: true,
        resetState: false,
      },
      fixture.toolCtx,
    );
    assert.match(
      incompatibleInitMessage,
      /state\.assessments\[0\]\.roleId 'builder' is not declared for gate 'acceptance_input_check'/,
    );

    const statusAfterFailures = extractOutput(
      await fixture.tools.getStatus({ taskDocPath: fixture.taskDocRel }, fixture.toolCtx),
    );
    assert.match(statusAfterFailures, /- currentPhase: `implementation` \(Implementation\)/);
    assert.match(
      statusAfterFailures,
      /- activeGate: `acceptance_input_check` \(Acceptance input check\)/,
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
