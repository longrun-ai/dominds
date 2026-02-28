import assert from 'node:assert/strict';

import {
  decideKernelDriverContextHealth,
  KERNEL_DRIVER_DEFAULT_CAUTION_REMEDIATION_CADENCE_GENERATIONS,
  resetContextHealthRoundState,
  resolveCautionRemediationCadenceGenerations,
  resolveCriticalCountdownRemaining,
} from '../../main/llm/kernel-driver/context-health';
import type { ContextHealthSnapshot } from '../../main/shared/types/context-health';

const CAUTION_SNAPSHOT: ContextHealthSnapshot = {
  kind: 'available',
  promptTokens: 210_000,
  completionTokens: 100,
  totalTokens: 210_100,
  modelContextLimitTokens: 272_000,
  effectiveOptimalMaxTokens: 200_000,
  effectiveCriticalMaxTokens: 244_800,
  hardUtil: 210_000 / 272_000,
  optimalUtil: 210_000 / 200_000,
  level: 'caution',
};

const HEALTHY_SNAPSHOT: ContextHealthSnapshot = {
  kind: 'available',
  promptTokens: 120_000,
  completionTokens: 100,
  totalTokens: 120_100,
  modelContextLimitTokens: 272_000,
  effectiveOptimalMaxTokens: 200_000,
  effectiveCriticalMaxTokens: 244_800,
  hardUtil: 120_000 / 272_000,
  optimalUtil: 120_000 / 200_000,
  level: 'healthy',
};

function decideForRound(args: {
  dialogKey: string;
  snapshot: ContextHealthSnapshot;
  cadence: number;
  hadUserPromptThisGen?: boolean;
  canInjectPromptThisGen?: boolean;
}) {
  const criticalCountdownRemaining = resolveCriticalCountdownRemaining(
    args.dialogKey,
    args.snapshot,
  );
  return decideKernelDriverContextHealth({
    dialogKey: args.dialogKey,
    snapshot: args.snapshot,
    hadUserPromptThisGen: args.hadUserPromptThisGen ?? false,
    canInjectPromptThisGen: args.canInjectPromptThisGen ?? true,
    cautionRemediationCadenceGenerations: args.cadence,
    criticalCountdownRemaining,
  });
}

async function main(): Promise<void> {
  assert.equal(
    resolveCautionRemediationCadenceGenerations(undefined),
    KERNEL_DRIVER_DEFAULT_CAUTION_REMEDIATION_CADENCE_GENERATIONS,
    'undefined cadence should fallback to default',
  );
  assert.equal(
    resolveCautionRemediationCadenceGenerations(0),
    KERNEL_DRIVER_DEFAULT_CAUTION_REMEDIATION_CADENCE_GENERATIONS,
    'non-positive cadence should fallback to default',
  );
  assert.equal(
    resolveCautionRemediationCadenceGenerations(3.9),
    3,
    'cadence should be floored to integer',
  );

  const defaultDialogKey = 'test-caution-cadence-default';
  const defaultCadence = resolveCautionRemediationCadenceGenerations(undefined);
  resetContextHealthRoundState(defaultDialogKey);

  const entryDecision = decideForRound({
    dialogKey: defaultDialogKey,
    snapshot: CAUTION_SNAPSHOT,
    cadence: defaultCadence,
  });
  assert.deepEqual(entryDecision, { kind: 'continue', reason: 'caution_soft_remediation' });

  for (let i = 1; i < defaultCadence; i += 1) {
    const d = decideForRound({
      dialogKey: defaultDialogKey,
      snapshot: CAUTION_SNAPSHOT,
      cadence: defaultCadence,
    });
    assert.deepEqual(
      d,
      { kind: 'proceed' },
      `unexpected caution prompt before cadence at step ${i}`,
    );
  }
  const cadenceDecision = decideForRound({
    dialogKey: defaultDialogKey,
    snapshot: CAUTION_SNAPSHOT,
    cadence: defaultCadence,
  });
  assert.deepEqual(cadenceDecision, { kind: 'continue', reason: 'caution_soft_remediation' });

  const userBlockedDialogKey = 'test-caution-cadence-user-blocked';
  resetContextHealthRoundState(userBlockedDialogKey);
  const blockedByUser = decideForRound({
    dialogKey: userBlockedDialogKey,
    snapshot: CAUTION_SNAPSHOT,
    cadence: 4,
    hadUserPromptThisGen: true,
  });
  assert.deepEqual(blockedByUser, { kind: 'proceed' });
  const delayedEntryInjection = decideForRound({
    dialogKey: userBlockedDialogKey,
    snapshot: CAUTION_SNAPSHOT,
    cadence: 4,
  });
  assert.deepEqual(delayedEntryInjection, { kind: 'continue', reason: 'caution_soft_remediation' });

  const queueBlockedDialogKey = 'test-caution-cadence-queue-blocked';
  resetContextHealthRoundState(queueBlockedDialogKey);
  assert.deepEqual(
    decideForRound({
      dialogKey: queueBlockedDialogKey,
      snapshot: CAUTION_SNAPSHOT,
      cadence: 2,
    }),
    { kind: 'continue', reason: 'caution_soft_remediation' },
  );
  assert.deepEqual(
    decideForRound({
      dialogKey: queueBlockedDialogKey,
      snapshot: CAUTION_SNAPSHOT,
      cadence: 2,
    }),
    { kind: 'proceed' },
  );
  assert.deepEqual(
    decideForRound({
      dialogKey: queueBlockedDialogKey,
      snapshot: CAUTION_SNAPSHOT,
      cadence: 2,
      canInjectPromptThisGen: false,
    }),
    { kind: 'proceed' },
  );
  assert.deepEqual(
    decideForRound({
      dialogKey: queueBlockedDialogKey,
      snapshot: CAUTION_SNAPSHOT,
      cadence: 2,
    }),
    { kind: 'continue', reason: 'caution_soft_remediation' },
    'prompt should inject immediately after queue block is removed',
  );

  assert.deepEqual(
    decideForRound({
      dialogKey: queueBlockedDialogKey,
      snapshot: HEALTHY_SNAPSHOT,
      cadence: 2,
    }),
    { kind: 'proceed' },
  );
  assert.deepEqual(
    decideForRound({
      dialogKey: queueBlockedDialogKey,
      snapshot: CAUTION_SNAPSHOT,
      cadence: 2,
    }),
    { kind: 'continue', reason: 'caution_soft_remediation' },
    'healthy transition should reset caution cadence state',
  );

  console.log('context-health caution cadence: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`context-health caution cadence: FAIL\n${message}`);
  process.exit(1);
});
