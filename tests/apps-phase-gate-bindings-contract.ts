import assert from 'node:assert/strict';

import type { DomindsAppRunControlContext } from '@longrun-ai/kernel/app-host-contract';
import { renderAppRunControlBlockForPreDrive } from '../main/apps/run-control';
import {
  bindingsAwareBindings,
  bindingsAwareFlow,
  createPhaseGateFixture,
  extractOutput,
  parseJsonBlock,
  resolvePhaseGateFixture,
} from './helpers/phase-gate-flow-fixture';

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
  const fixture = await createPhaseGateFixture();
  try {
    const runControl = fixture.host.runControls?.phase_gate_autonomy;
    assert.ok(runControl, 'expected phase_gate_autonomy run control');
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

    const missingBindingsControl = await runControl(
      buildRunControlContext({ agentId: 'spectator', taskDocPath: fixture.bindingsTaskDocRel }),
    );
    assert.equal(missingBindingsControl.kind, 'block');
    if (missingBindingsControl.kind !== 'block') {
      throw new Error('expected blocked run-control result for missing bindings');
    }
    assert.equal(missingBindingsControl.block.blockKind, 'await_app_action');
    if (missingBindingsControl.block.blockKind !== 'await_app_action') {
      throw new Error('expected await_app_action block');
    }
    assert.equal(missingBindingsControl.block.actionClass, 'input');
    assert.equal(missingBindingsControl.block.actionId, 'bind_members');
    assert.match(
      renderAppRunControlBlockForPreDrive(missingBindingsControl.block),
      /Provide information/,
    );

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

    const resolvedBindingsControl = await runControl(
      buildRunControlContext({ agentId: 'spectator', taskDocPath: fixture.bindingsTaskDocRel }),
    );
    assert.equal(resolvedBindingsControl.kind, 'block');
    if (resolvedBindingsControl.kind !== 'block') {
      throw new Error('expected blocked run-control result after bindings were restored');
    }
    assert.equal(resolvedBindingsControl.block.blockKind, 'await_members');
    if (resolvedBindingsControl.block.blockKind !== 'await_members') {
      throw new Error('expected await_members block after bindings were restored');
    }
    assert.deepEqual(
      resolvedBindingsControl.block.waitingFor.map((entry) => entry.memberId).sort(),
      ['owner'],
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
