import type { ContextHealthLevel, ContextHealthSnapshot } from '../../shared/types/context-health';

export type DriverV2ContextHealthDecision =
  | Readonly<{ kind: 'proceed' }>
  | Readonly<{
      kind: 'continue';
      reason:
        | 'caution_soft_remediation'
        | 'critical_countdown_remediation'
        | 'critical_force_new_course';
    }>
  | Readonly<{ kind: 'suspend'; reason: 'critical_wait_human' }>;

type DriverV2ContextHealthRoundState = {
  lastSeenLevel?: ContextHealthLevel;
  criticalCountdownRemaining?: number;
  cautionPromptDue?: boolean;
  cautionGenerationsSincePrompt?: number;
};

export const DRIVER_V2_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS = 5;
export const DRIVER_V2_DEFAULT_CAUTION_REMEDIATION_CADENCE_GENERATIONS = 10;

const contextHealthRoundStateByDialogKey: Map<string, DriverV2ContextHealthRoundState> = new Map();

function getContextHealthRoundState(dialogKey: string): DriverV2ContextHealthRoundState {
  const existing = contextHealthRoundStateByDialogKey.get(dialogKey);
  if (existing) {
    return existing;
  }
  const created: DriverV2ContextHealthRoundState = {};
  contextHealthRoundStateByDialogKey.set(dialogKey, created);
  return created;
}

export function resetContextHealthRoundState(dialogKey: string): void {
  contextHealthRoundStateByDialogKey.delete(dialogKey);
}

export function resolveCriticalCountdownRemaining(
  dialogKey: string,
  snapshot: ContextHealthSnapshot | undefined,
): number {
  if (!snapshot || snapshot.kind !== 'available') {
    resetContextHealthRoundState(dialogKey);
    return DRIVER_V2_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS;
  }

  if (snapshot.level !== 'critical') {
    if (snapshot.level === 'healthy') {
      resetContextHealthRoundState(dialogKey);
      return DRIVER_V2_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS;
    }
    const state = getContextHealthRoundState(dialogKey);
    state.criticalCountdownRemaining = undefined;
    return DRIVER_V2_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS;
  }

  const state = getContextHealthRoundState(dialogKey);
  if (
    state.lastSeenLevel !== 'critical' ||
    typeof state.criticalCountdownRemaining !== 'number' ||
    !Number.isFinite(state.criticalCountdownRemaining)
  ) {
    state.lastSeenLevel = 'critical';
    state.criticalCountdownRemaining = DRIVER_V2_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS;
  }

  const remaining = Math.floor(state.criticalCountdownRemaining);
  return remaining > 0 ? remaining : 0;
}

export function consumeCriticalCountdown(dialogKey: string): number {
  const state = getContextHealthRoundState(dialogKey);
  const currentRaw =
    typeof state.criticalCountdownRemaining === 'number' &&
    Number.isFinite(state.criticalCountdownRemaining)
      ? Math.floor(state.criticalCountdownRemaining)
      : DRIVER_V2_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS;
  const current = currentRaw > 0 ? currentRaw : 0;
  const next = Math.max(0, current - 1);
  state.lastSeenLevel = 'critical';
  state.criticalCountdownRemaining = next;
  return next;
}

export function resolveCautionRemediationCadenceGenerations(
  configured: number | undefined,
): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return DRIVER_V2_DEFAULT_CAUTION_REMEDIATION_CADENCE_GENERATIONS;
  }
  const normalized = Math.floor(configured);
  if (normalized <= 0) {
    return DRIVER_V2_DEFAULT_CAUTION_REMEDIATION_CADENCE_GENERATIONS;
  }
  return normalized;
}

export function decideDriverV2ContextHealth(args: {
  dialogKey: string;
  snapshot?: ContextHealthSnapshot;
  hadUserPromptThisGen: boolean;
  canInjectPromptThisGen: boolean;
  cautionRemediationCadenceGenerations: number;
  criticalCountdownRemaining: number;
}): DriverV2ContextHealthDecision {
  const { snapshot, dialogKey } = args;
  if (!snapshot || snapshot.kind !== 'available') {
    return { kind: 'proceed' };
  }
  if (snapshot.level === 'healthy') {
    return { kind: 'proceed' };
  }
  if (snapshot.level === 'caution') {
    const state = getContextHealthRoundState(dialogKey);
    const cadence = resolveCautionRemediationCadenceGenerations(
      args.cautionRemediationCadenceGenerations,
    );
    const enteringCaution = state.lastSeenLevel !== 'caution';

    state.lastSeenLevel = 'caution';
    state.criticalCountdownRemaining = undefined;

    if (enteringCaution) {
      state.cautionPromptDue = true;
      state.cautionGenerationsSincePrompt = 0;
    } else if (state.cautionPromptDue !== true) {
      const previous =
        typeof state.cautionGenerationsSincePrompt === 'number' &&
        Number.isFinite(state.cautionGenerationsSincePrompt)
          ? Math.max(0, Math.floor(state.cautionGenerationsSincePrompt))
          : 0;
      const next = previous + 1;
      state.cautionGenerationsSincePrompt = next;
      if (next >= cadence) {
        state.cautionPromptDue = true;
      }
    }

    const shouldInjectPrompt =
      state.cautionPromptDue === true && !args.hadUserPromptThisGen && args.canInjectPromptThisGen;
    if (!shouldInjectPrompt) {
      return { kind: 'proceed' };
    }

    state.cautionPromptDue = false;
    state.cautionGenerationsSincePrompt = 0;
    return { kind: 'continue', reason: 'caution_soft_remediation' };
  }
  if (snapshot.level === 'critical') {
    const state = getContextHealthRoundState(dialogKey);
    state.lastSeenLevel = 'critical';
    state.cautionPromptDue = undefined;
    state.cautionGenerationsSincePrompt = undefined;
    if (args.criticalCountdownRemaining <= 0) {
      return { kind: 'continue', reason: 'critical_force_new_course' };
    }
    return args.hadUserPromptThisGen
      ? { kind: 'suspend', reason: 'critical_wait_human' }
      : { kind: 'continue', reason: 'critical_countdown_remediation' };
  }
  const _exhaustive: never = snapshot.level;
  return _exhaustive;
}
