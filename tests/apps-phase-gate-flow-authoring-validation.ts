import assert from 'node:assert/strict';

import {
  createPhaseGateFixture,
  expectToolError,
  invalidMissingEdgeFlow,
  invalidNoMermaidFlow,
  resolvePhaseGateFixture,
} from './helpers/phase-gate-flow-fixture';

async function main(): Promise<void> {
  const fixture = await createPhaseGateFixture();
  try {
    const missingFlowMessage = await expectToolError(
      fixture.tools.getFlow,
      { taskDocPath: fixture.uninitializedTaskDocRel },
      fixture.toolCtx,
    );
    assert.match(
      missingFlowMessage,
      /phase-gate flow is not initialized for 'uninitialized-case\.tsk'; use 'phase_gate_init_flow' first/,
    );

    const invalidNoMermaidMessage = await expectToolError(
      fixture.tools.replaceFlow,
      {
        taskDocPath: fixture.taskDocRel,
        content: resolvePhaseGateFixture(invalidNoMermaidFlow),
      },
      fixture.toolCtx,
    );
    assert.match(invalidNoMermaidMessage, /flow markdown must include a ```mermaid block/);

    const invalidMissingEdgeMessage = await expectToolError(
      fixture.tools.replaceFlow,
      {
        taskDocPath: fixture.taskDocRel,
        content: resolvePhaseGateFixture(invalidMissingEdgeFlow),
      },
      fixture.toolCtx,
    );
    assert.match(invalidMissingEdgeMessage, /mermaid graph is missing edge 'alignment->done'/);
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
