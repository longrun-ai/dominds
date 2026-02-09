import type { ContextHealthSnapshot } from '../../shared/types/context-health';

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
