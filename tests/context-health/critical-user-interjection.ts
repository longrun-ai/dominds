import assert from 'node:assert/strict';

import type { ContextHealthSnapshot } from '@longrun-ai/kernel/types/context-health';
import {
  consumeCriticalCountdown,
  decideKernelDriverContextHealth,
  resetContextHealthRoundState,
  resolveCriticalCountdownRemaining,
} from '../../main/llm/kernel-driver/context-health';

const CRITICAL_SNAPSHOT: ContextHealthSnapshot = {
  kind: 'available',
  promptTokens: 190_000,
  completionTokens: 100,
  totalTokens: 190_100,
  modelContextLimitTokens: 200_000,
  effectiveOptimalMaxTokens: 180_000,
  effectiveCriticalMaxTokens: 180_000,
  hardUtil: 190_000 / 200_000,
  optimalUtil: 190_000 / 180_000,
  level: 'critical',
};

function decideCritical(args: { dialogKey: string; hadUserPromptThisGen: boolean }) {
  return decideKernelDriverContextHealth({
    dialogKey: args.dialogKey,
    snapshot: CRITICAL_SNAPSHOT,
    hadUserPromptThisGen: args.hadUserPromptThisGen,
    canInjectPromptThisGen: true,
    cautionRemediationCadenceGenerations: 10,
    criticalCountdownRemaining: resolveCriticalCountdownRemaining(
      args.dialogKey,
      CRITICAL_SNAPSHOT,
    ),
  });
}

async function main(): Promise<void> {
  const dialogKey = 'test-critical-user-interjection';
  resetContextHealthRoundState(dialogKey);

  assert.deepEqual(
    decideCritical({ dialogKey, hadUserPromptThisGen: true }),
    { kind: 'continue', reason: 'critical_user_prompt_remediation' },
    'critical user interjection should be an effective remediation turn, not a silent suspend',
  );

  assert.equal(
    consumeCriticalCountdown(dialogKey),
    4,
    'critical user interjection should consume countdown like a runtime remediation turn',
  );
  assert.deepEqual(decideCritical({ dialogKey, hadUserPromptThisGen: true }), {
    kind: 'continue',
    reason: 'critical_user_prompt_remediation',
  });
  assert.equal(consumeCriticalCountdown(dialogKey), 3);
  assert.equal(consumeCriticalCountdown(dialogKey), 2);
  assert.equal(consumeCriticalCountdown(dialogKey), 1);
  assert.equal(consumeCriticalCountdown(dialogKey), 0);

  assert.deepEqual(
    decideCritical({ dialogKey, hadUserPromptThisGen: true }),
    { kind: 'continue', reason: 'critical_force_new_course' },
    'after counted critical user turns exhaust the countdown, the driver should force a new course',
  );

  console.log('context-health critical-user-interjection: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`context-health critical-user-interjection: FAIL\n${message}`);
  process.exit(1);
});
