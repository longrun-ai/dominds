import type { LanguageCode } from './language';

export type DialogDisplayTextI18n = Partial<Record<LanguageCode, string>>;

export type DialogRetryDisplay = {
  titleTextI18n: DialogDisplayTextI18n;
  summaryTextI18n: DialogDisplayTextI18n;
};

export type DialogLlmRetryExhaustedReason = {
  kind: 'llm_retry_stopped';
  error: string;
  display: DialogRetryDisplay;
};

export type DialogInterruptionReason =
  | { kind: 'user_stop' }
  | { kind: 'emergency_stop' }
  | { kind: 'server_restart' }
  | { kind: 'fork_continue_ready' }
  | { kind: 'system_stop'; detail: string }
  | DialogLlmRetryExhaustedReason;

export type DialogBlockedReason =
  | { kind: 'needs_human_input' }
  | { kind: 'waiting_for_subdialogs' }
  | { kind: 'needs_human_input_and_subdialogs' };

export type DialogDeadReason = { kind: 'declared_by_user' } | { kind: 'system'; detail: string };

export type DialogDisplayState =
  | { kind: 'idle_waiting_user' }
  | { kind: 'proceeding' }
  | { kind: 'proceeding_stop_requested'; reason: 'user_stop' | 'emergency_stop' }
  | { kind: 'stopped'; reason: DialogInterruptionReason; continueEnabled: boolean }
  | { kind: 'blocked'; reason: DialogBlockedReason }
  | { kind: 'dead'; reason: DialogDeadReason };
