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
};

export const DRIVER_V2_DEFAULT_CRITICAL_COUNTDOWN_GENERATIONS = 5;

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
    state.lastSeenLevel = snapshot.level;
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

export function decideDriverV2ContextHealth(args: {
  snapshot?: ContextHealthSnapshot;
  hadUserPromptThisGen: boolean;
  criticalCountdownRemaining: number;
}): DriverV2ContextHealthDecision {
  const { snapshot } = args;
  if (!snapshot || snapshot.kind !== 'available') {
    return { kind: 'proceed' };
  }
  if (snapshot.level === 'healthy') {
    return { kind: 'proceed' };
  }
  if (snapshot.level === 'caution') {
    return args.hadUserPromptThisGen
      ? { kind: 'proceed' }
      : { kind: 'continue', reason: 'caution_soft_remediation' };
  }
  if (snapshot.level === 'critical') {
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
