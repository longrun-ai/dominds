/**
 * Module: shared/types/display-state
 *
 * UI/diagnostic projection for dialog execution state.
 *
 * Important:
 * - This is not a business source of truth.
 * - Backend control flow must rely on primary facts such as active runs, stop requests,
 *   pending Q4H, pending subdialogs, queued prompts, persisted status, and explicit
 *   interruption/death markers.
 * - This projection exists so WebUI and operators can render or inspect the current state
 *   without recomputing those facts client-side.
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

export type DialogDeadReason = { kind: 'declared_by_user' } | { kind: 'system'; detail: string };

export type DialogDisplayState =
  | { kind: 'idle_waiting_user' }
  | { kind: 'proceeding' }
  | { kind: 'proceeding_stop_requested'; reason: 'user_stop' | 'emergency_stop' }
  | { kind: 'interrupted'; reason: DialogInterruptionReason }
  | { kind: 'blocked'; reason: DialogBlockedReason }
  | { kind: 'dead'; reason: DialogDeadReason }
  | { kind: 'terminal'; status: 'completed' | 'archived' };
