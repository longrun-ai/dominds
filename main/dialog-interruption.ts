import type { DialogInterruptionReason } from '@longrun-ai/kernel/types/display-state';

/**
 * Decides whether a finalized stopped dialog should expose manual Continue.
 *
 * This only applies to the persisted/broadcast final stopped state after the driver has fully
 * unwound and confirmed an interrupted terminal projection. Transient interruption markers and
 * retry-stop progress events must stay disabled until that final stopped state is written. Do not
 * "simplify" this by enabling Continue earlier: that would let the UI offer a resume action before
 * the dialog is actually resumable again, reintroducing exactly the class of race/false-positive
 * bugs this split is here to prevent.
 *
 * `llm_retry_stopped` is intentionally resumable here:
 * - manual Continue starts a fresh drive invocation, which naturally resets per-run retry state
 *   and provider-quirk tracking state;
 * - it does NOT reset process-wide adaptive smart-rate backoff, which is shared by
 *   provider/model and should keep protecting the system.
 */
export function isInterruptionReasonManualResumeEligible(
  reason: DialogInterruptionReason,
): boolean {
  switch (reason.kind) {
    case 'user_stop':
    case 'emergency_stop':
    case 'server_restart':
    case 'pending_course_start':
    case 'fork_continue_ready':
    case 'system_stop':
    case 'llm_retry_stopped':
      return true;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export function doesInterruptionReasonRequireExplicitResume(
  reason: DialogInterruptionReason,
): boolean {
  switch (reason.kind) {
    case 'pending_course_start':
      return false;
    case 'user_stop':
    case 'emergency_stop':
    case 'server_restart':
    case 'fork_continue_ready':
    case 'system_stop':
    case 'llm_retry_stopped':
      return true;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}
