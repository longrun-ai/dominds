import assert from 'node:assert/strict';

import {
  bindingsAwareFlow,
  createPhaseGateFixture,
  extractOutput,
  parseJsonBlock,
  resolvePhaseGateFixture,
} from './helpers/phase-gate-flow-fixture';

async function main(): Promise<void> {
  const fixture = await createPhaseGateFixture();
  try {
    const templateListOutput = extractOutput(await fixture.tools.templateList({}, fixture.toolCtx));
    assert.match(templateListOutput, /`mvp_default`/);
    assert.match(templateListOutput, /`web_dev_acceptance`/);

    const initOutput = extractOutput(
      await fixture.tools.initFlow(
        {
          taskDocPath: fixture.taskDocRel,
          templateId: 'mvp_default',
          overwrite: true,
          resetState: false,
        },
        fixture.toolCtx,
      ),
    );
    assert.match(
      initOutput,
      /Initialized phase-gate template `mvp_default` for `manage-case\.tsk`\./,
    );

    const currentFlowOutput = extractOutput(
      await fixture.tools.getFlow({ taskDocPath: fixture.taskDocRel }, fixture.toolCtx),
    );
    assert.match(currentFlowOutput, /^# Current phase-gate flow/m);
    assert.match(currentFlowOutput, /Taskdoc: `manage-case\.tsk`/);
    assert.match(currentFlowOutput, /```phasegate/);

    const currentBindingsOutput = extractOutput(
      await fixture.tools.getBindings({ taskDocPath: fixture.taskDocRel }, fixture.toolCtx),
    );
    assert.match(currentBindingsOutput, /^# Current phase-gate bindings/m);
    assert.match(currentBindingsOutput, /- bindingsSource: `file`/);
    assert.match(currentBindingsOutput, /"roleId": "builder"/);

    const preservedStatus = extractOutput(
      await fixture.tools.getStatus({ taskDocPath: fixture.taskDocRel }, fixture.toolCtx),
    );
    assert.match(preservedStatus, /- currentPhase: `implementation` \(Implementation\)/);

    const replacedBindingsAwareFlow = extractOutput(
      await fixture.tools.replaceFlow(
        {
          taskDocPath: fixture.bindingsTaskDocRel,
          content: resolvePhaseGateFixture(bindingsAwareFlow),
          resetState: true,
        },
        fixture.toolCtx,
      ),
    );
    assert.match(
      replacedBindingsAwareFlow,
      /Replaced phase-gate flow for `bindings-case\.tsk` and reset state\./,
    );

    const missingBindingsStatus = extractOutput(
      await fixture.tools.getStatus({ taskDocPath: fixture.bindingsTaskDocRel }, fixture.toolCtx),
    );
    assert.match(missingBindingsStatus, /- blockingReason: `missing_bindings`/);
    const policy = parseJsonBlock(missingBindingsStatus);
    assert.equal(policy.blockingReason, 'missing_bindings');
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
