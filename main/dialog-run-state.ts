/**
 * Module: dialog-run-state
 *
 * Owns the authoritative proceeding/idle/interrupted/blocked/terminal state for dialogs,
 * plus best-effort cancellation for in-flight dialog drives.
 *
 * Design constraints:
 * - State is persisted to latest.yaml (`DialogLatestFile.runState`) so it survives restarts.
 * - "Stop" is best-effort: it aborts in-flight LLM streaming and lets the driver unwind.
 * - Broadcasting is optional: when configured, run-state updates are pushed to all WS clients
 *   so multi-tab views converge without polling.
 */

import { DialogID, type Dialog } from './dialog';
import { dialogEventRegistry } from './evt-registry';
import { createLogger } from './log';
import { DialogPersistence } from './persistence';
import type { DialogInterruptionReason, DialogRunState } from './shared/types/run-state';
import type { WebSocketMessage } from './shared/types/wire';

const log = createLogger('dialog-run-state');

type StopRequestedReason = 'user_stop' | 'emergency_stop';

type ActiveRun = {
  abortController: AbortController;
  stopRequested?: StopRequestedReason;
};

let broadcastToClients: ((msg: WebSocketMessage) => void) | undefined;

const activeRunsByDialogKey: Map<string, ActiveRun> = new Map();

export function setRunStateBroadcaster(fn: (msg: WebSocketMessage) => void): void {
  broadcastToClients = fn;
}

export function hasActiveRun(dialogId: DialogID): boolean {
  return activeRunsByDialogKey.has(dialogId.key());
}

export function getActiveRunSignal(dialogId: DialogID): AbortSignal | undefined {
  const run = activeRunsByDialogKey.get(dialogId.key());
  return run?.abortController.signal;
}

export function createActiveRun(dialogId: DialogID): AbortSignal {
  const key = dialogId.key();
  const existing = activeRunsByDialogKey.get(key);
  if (existing) {
    return existing.abortController.signal;
  }
  const run: ActiveRun = { abortController: new AbortController() };
  activeRunsByDialogKey.set(key, run);
  return run.abortController.signal;
}

export function clearActiveRun(dialogId: DialogID): void {
  activeRunsByDialogKey.delete(dialogId.key());
}

export function getStopRequestedReason(dialogId: DialogID): StopRequestedReason | undefined {
  return activeRunsByDialogKey.get(dialogId.key())?.stopRequested;
}

export async function setDialogRunState(
  dialogId: DialogID,
  runState: DialogRunState,
): Promise<void> {
  try {
    await DialogPersistence.mutateDialogLatest(dialogId, () => ({
      kind: 'patch',
      patch: { runState },
    }));
  } catch (err) {
    log.warn('Failed to persist dialog runState', err, { dialogId: dialogId.valueOf() });
  }

  const typed = dialogEventRegistry.createTypedEvent(dialogId, {
    type: 'dlg_run_state_evt',
    runState,
  });

  if (broadcastToClients) {
    broadcastToClients(typed);
  }
}

export function broadcastRunStateMarker(
  dialogId: DialogID,
  marker: { kind: 'interrupted' | 'resumed'; reason?: DialogInterruptionReason },
): void {
  const typed = dialogEventRegistry.createTypedEvent(dialogId, {
    type: 'dlg_run_state_marker_evt',
    kind: marker.kind,
    reason: marker.reason,
  });
  if (broadcastToClients) {
    broadcastToClients(typed);
  }
}

export async function computeIdleRunState(dlg: Dialog): Promise<DialogRunState> {
  if (dlg.status === 'completed' || dlg.status === 'archived') {
    return { kind: 'terminal', status: dlg.status };
  }

  const hasQ4H = await dlg.hasPendingQ4H();
  const hasSubdialogs = await dlg.hasPendingSubdialogs();

  if (hasQ4H && hasSubdialogs) {
    return { kind: 'blocked', reason: { kind: 'needs_human_input_and_subdialogs' } };
  }
  if (hasQ4H) {
    return { kind: 'blocked', reason: { kind: 'needs_human_input' } };
  }
  if (hasSubdialogs) {
    return { kind: 'blocked', reason: { kind: 'waiting_for_subdialogs' } };
  }
  return { kind: 'idle_waiting_user' };
}

async function computeIdleRunStateFromPersistence(dialogId: DialogID): Promise<DialogRunState> {
  const latest = await DialogPersistence.loadDialogLatest(dialogId, 'running');
  const status = latest?.status;
  if (status === 'completed' || status === 'archived') {
    return { kind: 'terminal', status };
  }

  const q4h = await DialogPersistence.loadQuestions4HumanState(dialogId, 'running');
  const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(dialogId, 'running');
  const hasQ4H = q4h.length > 0;
  const hasSubdialogs = pendingSubdialogs.length > 0;

  if (hasQ4H && hasSubdialogs) {
    return { kind: 'blocked', reason: { kind: 'needs_human_input_and_subdialogs' } };
  }
  if (hasQ4H) {
    return { kind: 'blocked', reason: { kind: 'needs_human_input' } };
  }
  if (hasSubdialogs) {
    return { kind: 'blocked', reason: { kind: 'waiting_for_subdialogs' } };
  }
  return { kind: 'idle_waiting_user' };
}

export async function reconcileRunStatesAfterRestart(): Promise<void> {
  const dialogIds = await DialogPersistence.listAllDialogIds('running');
  for (const dialogId of dialogIds) {
    const latest = await DialogPersistence.loadDialogLatest(dialogId, 'running');
    const existing = latest?.runState;

    const wasProceeding =
      latest?.generating === true ||
      (existing !== undefined &&
        (existing.kind === 'proceeding' || existing.kind === 'proceeding_stop_requested'));

    if (wasProceeding) {
      const nextIdle = await computeIdleRunStateFromPersistence(dialogId);
      const next =
        nextIdle.kind === 'blocked'
          ? nextIdle
          : ({ kind: 'interrupted', reason: { kind: 'server_restart' } } satisfies DialogRunState);
      try {
        await DialogPersistence.mutateDialogLatest(dialogId, () => ({
          kind: 'patch',
          patch: { generating: false, runState: next },
        }));
      } catch (err) {
        log.warn('Failed to reconcile proceeding dialog after restart', err, {
          dialogId: dialogId.valueOf(),
        });
      }
      continue;
    }

    if (!existing) {
      const inferred = await computeIdleRunStateFromPersistence(dialogId);
      try {
        await DialogPersistence.mutateDialogLatest(dialogId, () => ({
          kind: 'patch',
          patch: { runState: inferred },
        }));
      } catch (err) {
        log.warn('Failed to backfill missing runState', err, { dialogId: dialogId.valueOf() });
      }
    }
  }
}

export async function requestInterruptDialog(
  dialogId: DialogID,
  reason: StopRequestedReason,
): Promise<{ applied: boolean }> {
  const key = dialogId.key();
  const run = activeRunsByDialogKey.get(key);
  if (!run) {
    return { applied: false };
  }
  if (run.stopRequested) {
    return { applied: false };
  }
  run.stopRequested = reason;
  await setDialogRunState(dialogId, { kind: 'proceeding_stop_requested', reason });
  try {
    run.abortController.abort();
  } catch (err) {
    log.warn('Failed to abort active run', err, { dialogId: dialogId.valueOf() });
  }
  return { applied: true };
}

export async function requestEmergencyStopAll(): Promise<{ interrupted: number }> {
  const keys = [...activeRunsByDialogKey.keys()];
  let interrupted = 0;
  for (const key of keys) {
    const [rootId, selfId] = key.includes('#') ? key.split('#') : [key, key];
    if (!rootId || !selfId) continue;
    const dialogId = new DialogID(selfId, rootId);
    const res = await requestInterruptDialog(dialogId, 'emergency_stop');
    if (res.applied) interrupted++;
  }
  return { interrupted };
}
