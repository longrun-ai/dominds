/**
 * Module: shared/types/run-state
 *
 * Authoritative dialog run state model for proceeding / interrupted / blocked / terminal UX.
 * This is intentionally separate from dialog event types to avoid circular type dependencies.
 */

export type DialogInterruptionReason =
  | { kind: 'user_stop' }
  | { kind: 'emergency_stop' }
  | { kind: 'server_restart' }
  | { kind: 'system_stop'; detail: string };

export type DialogBlockedReason =
  | { kind: 'needs_human_input' }
  | { kind: 'waiting_for_subdialogs' }
  | { kind: 'needs_human_input_and_subdialogs' };

export type DialogRunState =
  | { kind: 'idle_waiting_user' }
  | { kind: 'proceeding' }
  | { kind: 'proceeding_stop_requested'; reason: 'user_stop' | 'emergency_stop' }
  | { kind: 'interrupted'; reason: DialogInterruptionReason }
  | { kind: 'blocked'; reason: DialogBlockedReason }
  | { kind: 'terminal'; status: 'completed' | 'archived' };
