import assert from 'node:assert/strict';

import {
  bindingsAwareBindings,
  bindingsAwareFlow,
  createPhaseGateFixture,
  extractOutput,
  parseJsonBlock,
  resolvePhaseGateFixture,
} from './helpers/phase-gate-flow-fixture';

async function main(): Promise<void> {
  const fixture = await createPhaseGateFixture();
  try {
    extractOutput(
      await fixture.tools.replaceFlow(
        {
          taskDocPath: fixture.bindingsTaskDocRel,
          content: resolvePhaseGateFixture(bindingsAwareFlow),
          resetState: true,
        },
        fixture.toolCtx,
      ),
    );

    const initialBindingsOutput = extractOutput(
      await fixture.tools.getBindings({ taskDocPath: fixture.bindingsTaskDocRel }, fixture.toolCtx),
    );
    assert.match(initialBindingsOutput, /- bindingsSource: `file`/);
    assert.match(initialBindingsOutput, /"roleId": "owner"/);
    assert.match(initialBindingsOutput, /"roleId": "reviewer"/);

    const statusWithMissingBindings = extractOutput(
      await fixture.tools.getStatus({ taskDocPath: fixture.bindingsTaskDocRel }, fixture.toolCtx),
    );
    assert.match(statusWithMissingBindings, /- blockingReason: `missing_bindings`/);
    assert.match(statusWithMissingBindings, /- missingBindings: `owner`/);
    const missingBindingsPolicy = parseJsonBlock(statusWithMissingBindings);
    assert.equal(missingBindingsPolicy.blockingReason, 'missing_bindings');

    const replacedBindingsOutput = extractOutput(
      await fixture.tools.replaceBindings(
        {
          taskDocPath: fixture.bindingsTaskDocRel,
          content: resolvePhaseGateFixture(bindingsAwareBindings),
        },
        fixture.toolCtx,
      ),
    );
    assert.match(replacedBindingsOutput, /Replaced phase-gate bindings for `bindings-case\.tsk`\./);

    const currentBindingsOutput = extractOutput(
      await fixture.tools.getBindings({ taskDocPath: fixture.bindingsTaskDocRel }, fixture.toolCtx),
    );
    assert.match(currentBindingsOutput, /"memberIds": \[/);
    assert.match(currentBindingsOutput, /@reviewer-a/);
    assert.match(currentBindingsOutput, /@reviewer-b/);

    const statusAfterBindings = extractOutput(
      await fixture.tools.getStatus({ taskDocPath: fixture.bindingsTaskDocRel }, fixture.toolCtx),
    );
    assert.doesNotMatch(statusAfterBindings, /- missingBindings:/);
    assert.match(statusAfterBindings, /- activeRolesNow: `owner`/);
    const bindingsWorkflowPolicy = parseJsonBlock(statusAfterBindings);
    const bindingsMeta = bindingsWorkflowPolicy.bindings;
    assert.equal(typeof bindingsMeta, 'object');
    assert.notEqual(bindingsMeta, null);
    assert.equal((bindingsMeta as Record<string, unknown>).source, 'file');
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
