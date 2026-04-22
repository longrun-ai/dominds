import type { LanguageCode } from './language';

export type DialogDisplayTextI18n = Partial<Record<LanguageCode, string>>;

export type DialogRetryDisplay = {
  titleTextI18n: DialogDisplayTextI18n;
  summaryTextI18n: DialogDisplayTextI18n;
};

/**
 * Structured post-quirk recovery intent attached to a finalized `llm_retry_stopped` reason.
 *
 * Important design boundary:
 * - Quirk handlers still own the concrete hard-coded stop/retry policy and decide whether they
 *   want to attach a recovery action at all.
 * - The driver/runtime only interprets the structured action if one is present; `none` means the
 *   quirk explicitly stops without any automatic recovery attempt.
 * - If the driver accepts a structured recovery path for the current stop decision, that recovery
 *   budget is considered consumed/reserved immediately even before the follow-up request starts.
 * - This is intentionally compositional metadata, not a global policy switch and not a generic
 *   "always auto-recover" flag.
 */
export type DialogLlmRetryRecoveryAction = { kind: 'none' } | { kind: 'diligence_push_once' };

export type DialogLlmRetryExhaustedReason = {
  kind: 'llm_retry_stopped';
  error: string;
  display: DialogRetryDisplay;
  recoveryAction: DialogLlmRetryRecoveryAction;
};

export type DialogInterruptionReason =
  | { kind: 'user_stop' }
  | { kind: 'emergency_stop' }
  | { kind: 'server_restart' }
  | { kind: 'pending_course_start' }
  | { kind: 'fork_continue_ready' }
  | { kind: 'system_stop'; detail: string; i18nStopReason?: DialogDisplayTextI18n }
  | DialogLlmRetryExhaustedReason;

export type DialogBlockedReason =
  | { kind: 'needs_human_input' }
  | { kind: 'waiting_for_sideDialogs' }
  | { kind: 'needs_human_input_and_sideDialogs' };

export type DialogDeadReason = { kind: 'declared_by_user' } | { kind: 'system'; detail: string };

export type DialogDisplayState =
  | { kind: 'idle_waiting_user' }
  | { kind: 'proceeding' }
  | { kind: 'proceeding_stop_requested'; reason: 'user_stop' | 'emergency_stop' }
  | { kind: 'stopped'; reason: DialogInterruptionReason; continueEnabled: boolean }
  | { kind: 'blocked'; reason: DialogBlockedReason }
  | { kind: 'dead'; reason: DialogDeadReason };
