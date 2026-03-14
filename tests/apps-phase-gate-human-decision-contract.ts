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
    const requestHumanOutput = extractOutput(
      await fixture.tools.requestHumanDecision(
        {
          taskDocPath: fixture.controlTaskDocRel,
          reason: 'Need product tradeoff choice.',
          blockedWithoutDecision: 'Acceptance cannot start without an explicit product call.',
          teamRecommendation: 'Prefer option A and keep the current implementation direction.',
          question: 'Should we accept the current behavior or require a product-level change?',
          options: ['Accept current behavior', 'Require product change before acceptance'],
          evidence: ['artifacts/acceptance-summary.md', 'artifacts/browser-run.png'],
        },
        fixture.ownerCtx,
      ),
    );
    assert.match(requestHumanOutput, /Set human-decision control/);

    const humanStatus = extractOutput(
      await fixture.tools.getStatus({ taskDocPath: fixture.controlTaskDocRel }, fixture.ownerCtx),
    );
    assert.match(humanStatus, /- primaryAction: `request_human_decision`/);
    assert.match(humanStatus, /## Human decision handoff/);
    assert.match(
      humanStatus,
      /- blockedWithoutDecision: Acceptance cannot start without an explicit product call\./,
    );
    assert.match(
      humanStatus,
      /- teamRecommendation: Prefer option A and keep the current implementation direction\./,
    );
    assert.match(
      humanStatus,
      /- question: Should we accept the current behavior or require a product-level change\?/,
    );
    assert.match(
      humanStatus,
      /- options: Accept current behavior \| Require product change before acceptance/,
    );
    assert.match(
      humanStatus,
      /- evidence: artifacts\/acceptance-summary\.md \| artifacts\/browser-run\.png/,
    );
    const humanWorkflowPolicy = parseJsonBlock(humanStatus);
    const humanPrimaryAction = humanWorkflowPolicy.primaryAction;
    assertRecord(humanPrimaryAction, 'human primaryAction');
    assert.equal(humanPrimaryAction.kind, 'request_human_decision');
    const humanActor = humanPrimaryAction.actor;
    assertRecord(humanActor, 'human action actor');
    assert.equal(humanActor.type, 'human');
    assert.equal(humanWorkflowPolicy.blockingReason, 'await_human_decision');
    const humanGate = humanWorkflowPolicy.gate;
    assertRecord(humanGate, 'human gate');
    assert.equal(humanGate.status, 'blocked');
    const humanDecisionRequest = humanWorkflowPolicy.humanDecisionRequest;
    assertRecord(humanDecisionRequest, 'human decision handoff');
    const humanRecentEvents = humanWorkflowPolicy.recentEvents;
    assertArray(humanRecentEvents, 'human recent events');
    assert.equal(humanRecentEvents.length, 1);
    assertRecord(humanRecentEvents[0], 'human recent event');
    assert.equal(humanRecentEvents[0].kind, 'control_set');
    assert.equal(humanRecentEvents[0].controlKind, 'request_human_decision');
    assert.equal(
      humanDecisionRequest.blockedWithoutDecision,
      'Acceptance cannot start without an explicit product call.',
    );
    assert.equal(
      humanDecisionRequest.teamRecommendation,
      'Prefer option A and keep the current implementation direction.',
    );
    assert.equal(
      humanDecisionRequest.question,
      'Should we accept the current behavior or require a product-level change?',
    );
    assert.deepEqual(humanDecisionRequest.options, [
      'Accept current behavior',
      'Require product change before acceptance',
    ]);
    assert.deepEqual(humanDecisionRequest.evidence, [
      'artifacts/acceptance-summary.md',
      'artifacts/browser-run.png',
    ]);

    const recordHumanDecisionOutput = extractOutput(
      await fixture.tools.recordHumanDecision(
        {
          taskDocPath: fixture.controlTaskDocRel,
          summary: 'Human decided to keep the current behavior for this iteration.',
        },
        fixture.ownerCtx,
      ),
    );
    assert.match(
      recordHumanDecisionOutput,
      /Recorded human decision for `control-case\.tsk` and cleared the active human-decision control\./,
    );

    const resolvedHumanStatus = extractOutput(
      await fixture.tools.getStatus({ taskDocPath: fixture.controlTaskDocRel }, fixture.ownerCtx),
    );
    const resolvedHumanWorkflowPolicy = parseJsonBlock(resolvedHumanStatus);
    const resolvedHumanRecentEvents = resolvedHumanWorkflowPolicy.recentEvents;
    assertArray(resolvedHumanRecentEvents, 'resolved-human recent events');
    assert.deepEqual(
      resolvedHumanRecentEvents.map((event) => {
        assertRecord(event, 'resolved-human recent event');
        return event.kind;
      }),
      ['control_set', 'human_decision_recorded', 'control_cleared'],
    );
    const resolvedHumanLastEvent = resolvedHumanRecentEvents.at(-1);
    assertRecord(resolvedHumanLastEvent, 'resolved-human last event');
    assert.equal(resolvedHumanLastEvent.controlKind, 'request_human_decision');
    assert.equal(resolvedHumanWorkflowPolicy.blockingReason, null);
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
