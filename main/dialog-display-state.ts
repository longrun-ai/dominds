/**
 * Module: dialog-display-state
 *
 * Owns the persisted/broadcast display-state projection for dialogs, plus best-effort
 * cancellation for in-flight dialog drives.
 *
 * Design constraints:
 * - `displayState` is a UI/diagnostic projection, not a business source of truth.
 * - Primary control flow must rely on underlying facts (active runs, stop requests,
 *   pending Q4H, pending subdialogs, queued prompts, persisted status, explicit
 *   interruption/death markers).
 * - The projection is persisted to latest.yaml (`DialogLatestFile.displayState`) so it survives
 *   restarts and multi-tab views can converge quickly.
 * - "Stop" is best-effort: it aborts in-flight LLM streaming and lets the driver unwind.
 * - Broadcasting is optional: when configured, display-state updates are pushed to all WS clients
 *   so multi-tab views converge without polling.
 */

import type {
  DialogDisplayState,
  DialogInterruptionReason,
} from '@longrun-ai/kernel/types/display-state';
import type { DialogExecutionMarker, DialogLatestFile } from '@longrun-ai/kernel/types/storage';
import type { WebSocketMessage } from '@longrun-ai/kernel/types/wire';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { DialogID, type Dialog } from './dialog';
import { globalDialogRegistry } from './dialog-global-registry';
import { isInterruptionReasonManualResumeEligible } from './dialog-interruption';
import { dialogEventRegistry } from './evt-registry';
import { createLogger } from './log';
import { DialogPersistence } from './persistence';
import { findDomindsPersistenceFileError } from './persistence-errors';

const log = createLogger('dialog-display-state');

type StopRequestedReason = 'user_stop' | 'emergency_stop';

type ActiveRun = {
  abortController: AbortController;
  stopRequested?: StopRequestedReason;
};

let broadcastToClients: ((msg: WebSocketMessage) => void) | undefined;

const activeRunsByDialogKey: Map<string, ActiveRun> = new Map();
const quarantiningRootDialogIds: Set<string> = new Set();

export type RunControlCountsSnapshot = {
  proceeding: number;
  resumable: number;
};

export function setDisplayStateBroadcaster(fn: (msg: WebSocketMessage) => void): void {
  broadcastToClients = fn;
}

function syncRunControlCountsAfterActiveRunChange(
  trigger: 'create_active_run' | 'clear_active_run',
  dialogId: DialogID,
): void {
  void (async () => {
    try {
      await broadcastRunControlCountsSnapshot();
    } catch (err) {
      log.warn('Failed to broadcast run-control counts snapshot after active-run change', err, {
        dialogId: dialogId.valueOf(),
        trigger,
      });
    }
  })();
}

type RunControlBucket = 'proceeding' | 'resumable' | 'none';

export function isStoppedReasonResumable(reason: DialogInterruptionReason): boolean {
  return isInterruptionReasonManualResumeEligible(reason);
}

export function isDisplayStateResumable(state: DialogDisplayState | undefined): boolean {
  return state?.kind === 'stopped' && state.continueEnabled;
}

export function isExecutionMarkerResumable(
  executionMarker: DialogExecutionMarker | undefined,
): boolean {
  return (
    executionMarker?.kind === 'interrupted' && isStoppedReasonResumable(executionMarker.reason)
  );
}

export function isDialogLatestResumable(latest: DialogLatestFile | null | undefined): boolean {
  return (
    latest?.displayState?.kind === 'stopped' &&
    latest.displayState.continueEnabled &&
    latest.executionMarker?.kind === 'interrupted'
  );
}

function isSameDisplayState(
  left: DialogDisplayState | undefined,
  right: DialogDisplayState,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function classifyRunControlBucket(state: DialogDisplayState | undefined): RunControlBucket {
  if (!state) return 'none';
  if (state.kind === 'proceeding' || state.kind === 'proceeding_stop_requested') {
    return 'proceeding';
  }
  if (isDisplayStateResumable(state)) {
    return 'resumable';
  }
  return 'none';
}

function shouldBroadcastRunControlCounts(
  previous: DialogDisplayState | undefined,
  next: DialogDisplayState,
): boolean {
  return classifyRunControlBucket(previous) !== classifyRunControlBucket(next);
}

export async function getRunControlCountsSnapshot(): Promise<RunControlCountsSnapshot> {
  let proceeding = 0;
  let resumable = 0;
  const activeRunKeysByDialogKey = new Map(activeRunsByDialogKey.entries());
  const seenDialogKeys = new Set<string>();
  const dialogIds = await DialogPersistence.listAllDialogIds('running');
  for (const dialogId of dialogIds) {
    try {
      const dialogKey = dialogId.key();
      seenDialogKeys.add(dialogKey);
      if (quarantiningRootDialogIds.has(dialogId.rootId)) {
        continue;
      }
      // listAllDialogIds() is intentionally a candidate scan. Per-dialog latest reads below may
      // still quarantine one malformed dialog without invalidating the rest of the snapshot.
      const activeRun = activeRunKeysByDialogKey.get(dialogKey);
      if (activeRun) {
        proceeding++;
        continue;
      }
      const latest = await DialogPersistence.loadDialogLatest(dialogId, 'running');
      if (latest?.generating === true) {
        proceeding++;
      } else if (
        latest?.executionMarker?.kind === 'interrupted' &&
        isStoppedReasonResumable(latest.executionMarker.reason)
      ) {
        const q4h = await DialogPersistence.loadQuestions4HumanState(dialogId, 'running');
        const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(
          dialogId,
          'running',
        );
        if (q4h.length === 0 && pendingSubdialogs.length === 0) {
          resumable++;
        }
      }
    } catch (error: unknown) {
      if (!findDomindsPersistenceFileError(error)) {
        throw error;
      }
      log.warn('Skipping malformed dialog during run-control snapshot rebuild', error, {
        dialogId: dialogId.valueOf(),
      });
      continue;
    }
  }
  for (const [dialogKey, activeRun] of activeRunKeysByDialogKey.entries()) {
    if (!activeRun) {
      continue;
    }
    const [rootId] = dialogKey.includes('#') ? dialogKey.split('#') : [dialogKey];
    if (!rootId || quarantiningRootDialogIds.has(rootId)) {
      continue;
    }
    if (!seenDialogKeys.has(dialogKey)) {
      proceeding++;
    }
  }
  return { proceeding, resumable };
}

export async function broadcastRunControlCountsSnapshot(): Promise<void> {
  if (!broadcastToClients) return;
  const counts = await getRunControlCountsSnapshot();
  broadcastToClients({
    type: 'run_control_counts_evt',
    proceeding: counts.proceeding,
    resumable: counts.resumable,
    timestamp: formatUnifiedTimestamp(new Date()),
  });
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
  syncRunControlCountsAfterActiveRunChange('create_active_run', dialogId);
  return run.abortController.signal;
}

export function clearActiveRun(
  dialogId: DialogID,
  options?: Readonly<{
    notifyBackendLoop?: boolean;
  }>,
): void {
  const deleted = activeRunsByDialogKey.delete(dialogId.key());
  if (!deleted) {
    clearQuarantiningRootDialogIfIdle(dialogId.rootId);
    return;
  }
  clearQuarantiningRootDialogIfIdle(dialogId.rootId);
  if (dialogId.selfId === dialogId.rootId && options?.notifyBackendLoop !== false) {
    globalDialogRegistry.notifyActiveRunCleared(dialogId.rootId, {
      source: 'dialog_display_state_active_run_clear',
      reason: 'root_active_run_cleared',
    });
  }
  syncRunControlCountsAfterActiveRunChange('clear_active_run', dialogId);
}

function clearQuarantiningRootDialogIfIdle(rootId: string): void {
  for (const key of activeRunsByDialogKey.keys()) {
    const [candidateRootId] = key.includes('#') ? key.split('#') : [key];
    if (candidateRootId === rootId) {
      return;
    }
  }
  quarantiningRootDialogIds.delete(rootId);
}

export function clearRootDialogQuarantiningIfIdle(rootDialogId: DialogID): void {
  clearQuarantiningRootDialogIfIdle(rootDialogId.selfId);
}

export function markRootDialogQuarantining(rootDialogId: DialogID): void {
  quarantiningRootDialogIds.add(rootDialogId.selfId);
}

export function clearRootDialogQuarantining(rootDialogId: DialogID): void {
  quarantiningRootDialogIds.delete(rootDialogId.selfId);
}

export async function forceStopActiveRunsForRootDialog(rootDialogId: DialogID): Promise<void> {
  for (const key of Array.from(activeRunsByDialogKey.keys())) {
    const [rootId, selfId] = key.includes('#') ? key.split('#') : [key, key];
    if (!rootId || !selfId) continue;
    if (rootId !== rootDialogId.selfId) continue;
    const dialogId = new DialogID(selfId, rootId);
    const run = activeRunsByDialogKey.get(key);
    if (!run) continue;
    if (!run.stopRequested) {
      run.stopRequested = 'emergency_stop';
      try {
        await setDialogDisplayState(dialogId, {
          kind: 'proceeding_stop_requested',
          reason: 'emergency_stop',
        });
      } catch (error: unknown) {
        log.warn('Failed to persist stop-requested state while forcing root dialog stop', error, {
          dialogId: dialogId.valueOf(),
          rootDialogId: rootDialogId.valueOf(),
        });
      }
    }
    try {
      run.abortController.abort();
    } catch (error: unknown) {
      log.warn('Failed to abort active run while forcing root dialog stop', error, {
        dialogId: dialogId.valueOf(),
        rootDialogId: rootDialogId.valueOf(),
      });
    }
  }
}

export function getStopRequestedReason(dialogId: DialogID): StopRequestedReason | undefined {
  return activeRunsByDialogKey.get(dialogId.key())?.stopRequested;
}

export async function loadDialogExecutionMarker(
  dialogId: DialogID,
  status: 'running' | 'completed' | 'archived' = 'running',
): Promise<DialogExecutionMarker | undefined> {
  const latest = await DialogPersistence.loadDialogLatest(dialogId, status);
  return latest?.executionMarker;
}

export async function setDialogExecutionMarker(
  dialogId: DialogID,
  executionMarker: DialogExecutionMarker | undefined,
): Promise<void> {
  if (executionMarker?.kind === 'dead' && dialogId.selfId === dialogId.rootId) {
    log.warn(
      'Rejecting dead executionMarker for root dialog (root dialogs must not be dead)',
      undefined,
      {
        dialogId: dialogId.valueOf(),
      },
    );
    return;
  }

  try {
    await DialogPersistence.mutateDialogLatest(dialogId, () => ({
      kind: 'patch',
      patch: { executionMarker },
    }));
  } catch (err) {
    log.warn('Failed to persist dialog executionMarker', err, {
      dialogId: dialogId.valueOf(),
      rootId: dialogId.rootId,
      selfId: dialogId.selfId,
      intendedExecutionMarker: executionMarker ?? null,
    });
  }
}

export async function clearDialogInterruptedExecutionMarker(dialogId: DialogID): Promise<void> {
  try {
    const latest = await DialogPersistence.loadDialogLatest(dialogId, 'running');
    if (latest?.executionMarker?.kind !== 'interrupted') {
      return;
    }
  } catch (err) {
    log.warn('Failed to inspect executionMarker before clearing interrupted marker', err, {
      dialogId: dialogId.valueOf(),
    });
    return;
  }
  await setDialogExecutionMarker(dialogId, undefined);
}

export async function setDialogDisplayState(
  dialogId: DialogID,
  displayState: DialogDisplayState,
): Promise<void> {
  if (displayState.kind === 'dead' && dialogId.selfId === dialogId.rootId) {
    log.warn(
      'Rejecting dead displayState for root dialog (root dialogs must not be dead)',
      undefined,
      {
        dialogId: dialogId.valueOf(),
      },
    );
    return;
  }

  let previousDisplayState: DialogDisplayState | undefined;
  let previousExecutionMarker: DialogExecutionMarker | undefined;
  // "dead" is irreversible. Once a dialog is marked dead, do not allow overwriting it with
  // another state (best-effort; races may still exist across concurrent writers).
  try {
    const latest = await DialogPersistence.loadDialogLatest(dialogId, 'running');
    previousDisplayState = latest?.displayState;
    previousExecutionMarker = latest?.executionMarker;
    if (
      dialogId.selfId !== dialogId.rootId &&
      latest &&
      latest.executionMarker &&
      latest.executionMarker.kind === 'dead' &&
      displayState.kind !== 'dead'
    ) {
      const typed = dialogEventRegistry.createTypedEvent(dialogId, {
        type: 'dlg_display_state_evt',
        displayState: latest.displayState ?? {
          kind: 'dead',
          reason: latest.executionMarker.reason,
        },
      });
      if (broadcastToClients) {
        broadcastToClients(typed);
      }
      return;
    }
  } catch (err) {
    log.warn('Failed to check existing displayState before setDialogDisplayState', err, {
      dialogId: dialogId.valueOf(),
    });
  }

  const nextExecutionMarker: DialogExecutionMarker | undefined =
    displayState.kind === 'stopped'
      ? { kind: 'interrupted', reason: displayState.reason }
      : displayState.kind === 'dead'
        ? { kind: 'dead', reason: displayState.reason }
        : previousExecutionMarker?.kind === 'interrupted'
          ? undefined
          : previousExecutionMarker;

  try {
    await DialogPersistence.mutateDialogLatest(dialogId, () => ({
      kind: 'patch',
      patch: { displayState, executionMarker: nextExecutionMarker },
    }));
  } catch (err) {
    log.warn('Failed to persist dialog displayState', err, {
      dialogId: dialogId.valueOf(),
      rootId: dialogId.rootId,
      selfId: dialogId.selfId,
      intendedDisplayState: displayState,
    });
  }

  const typed = dialogEventRegistry.createTypedEvent(dialogId, {
    type: 'dlg_display_state_evt',
    displayState,
  });

  if (broadcastToClients) {
    broadcastToClients(typed);
  }
  if (shouldBroadcastRunControlCounts(previousDisplayState, displayState)) {
    try {
      await broadcastRunControlCountsSnapshot();
    } catch (err) {
      log.warn('Failed to broadcast run-control counts snapshot', err, {
        dialogId: dialogId.valueOf(),
      });
    }
  }
}

export function broadcastDisplayStateMarker(
  dialogId: DialogID,
  marker: { kind: 'interrupted' | 'resumed'; reason?: DialogInterruptionReason },
): void {
  const typed = dialogEventRegistry.createTypedEvent(dialogId, {
    type: 'dlg_display_state_marker_evt',
    kind: marker.kind,
    reason: marker.reason,
  });
  if (broadcastToClients) {
    broadcastToClients(typed);
  }
}

export async function computeIdleDisplayState(dlg: Dialog): Promise<DialogDisplayState> {
  if (dlg.status === 'completed' || dlg.status === 'archived') {
    return { kind: 'idle_waiting_user' };
  }

  const latest = await DialogPersistence.loadDialogLatest(dlg.id, 'running');
  if (
    dlg.id.selfId !== dlg.id.rootId &&
    latest?.executionMarker &&
    latest.executionMarker.kind === 'dead'
  ) {
    return { kind: 'dead', reason: latest.executionMarker.reason };
  }
  if (latest?.executionMarker?.kind === 'interrupted') {
    return {
      kind: 'stopped',
      reason: latest.executionMarker.reason,
      continueEnabled: isStoppedReasonResumable(latest.executionMarker.reason),
    };
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

async function computeIdleDisplayStateFromPersistence(
  dialogId: DialogID,
): Promise<DialogDisplayState> {
  const latest = await DialogPersistence.loadDialogLatest(dialogId, 'running');
  const status = latest?.status;
  if (status === 'completed' || status === 'archived') {
    return { kind: 'idle_waiting_user' };
  }
  if (
    dialogId.selfId !== dialogId.rootId &&
    latest &&
    latest.executionMarker &&
    latest.executionMarker.kind === 'dead'
  ) {
    return { kind: 'dead', reason: latest.executionMarker.reason };
  }
  if (latest?.executionMarker?.kind === 'interrupted') {
    return {
      kind: 'stopped',
      reason: latest.executionMarker.reason,
      continueEnabled: isStoppedReasonResumable(latest.executionMarker.reason),
    };
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

export async function refreshRunControlProjectionFromPersistenceFacts(
  dialogId: DialogID,
  trigger:
    | 'resume_dialog'
    | 'resume_all'
    | 'run_control_snapshot'
    | 'pending_subdialogs_changed'
    | 'q4h_changed',
): Promise<DialogLatestFile | null> {
  const latest = await DialogPersistence.loadDialogLatest(dialogId, 'running');
  if (!latest) {
    return null;
  }

  if (latest.generating === true) {
    return latest;
  }
  if (hasActiveRun(dialogId)) {
    return latest;
  }

  const desired = await (async (): Promise<DialogDisplayState> => {
    if (
      dialogId.selfId !== dialogId.rootId &&
      latest.executionMarker &&
      latest.executionMarker.kind === 'dead'
    ) {
      return { kind: 'dead', reason: latest.executionMarker.reason };
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
    if (latest.executionMarker?.kind === 'interrupted') {
      return {
        kind: 'stopped',
        reason: latest.executionMarker.reason,
        continueEnabled: isStoppedReasonResumable(latest.executionMarker.reason),
      };
    }
    return { kind: 'idle_waiting_user' };
  })();

  const executionMarkerNeedsHealing =
    desired.kind === 'stopped'
      ? latest.executionMarker?.kind !== 'interrupted' ||
        JSON.stringify(latest.executionMarker.reason) !== JSON.stringify(desired.reason)
      : desired.kind === 'dead'
        ? latest.executionMarker?.kind !== 'dead' ||
          JSON.stringify(latest.executionMarker.reason) !== JSON.stringify(desired.reason)
        : latest.executionMarker?.kind === 'interrupted';
  const displayStateNeedsHealing = !isSameDisplayState(latest.displayState, desired);

  if (!displayStateNeedsHealing && !executionMarkerNeedsHealing) {
    return latest;
  }

  log.warn('Healing stale run-control projection from persistence facts', undefined, {
    dialogId: dialogId.valueOf(),
    trigger,
    previousDisplayState: latest.displayState ?? null,
    previousExecutionMarker: latest.executionMarker ?? null,
    healedDisplayState: desired,
  });
  await setDialogDisplayState(dialogId, desired);
  return await DialogPersistence.loadDialogLatest(dialogId, 'running');
}

async function computeIdleDisplayStateForReconciliation(
  dialogId: DialogID,
): Promise<DialogDisplayState | null> {
  try {
    return await computeIdleDisplayStateFromPersistence(dialogId);
  } catch (error: unknown) {
    if (!findDomindsPersistenceFileError(error)) {
      throw error;
    }
    log.warn('Skipping malformed dialog during display-state idle reconstruction', error, {
      dialogId: dialogId.valueOf(),
    });
    return null;
  }
}

export async function reconcileDisplayStatesAfterRestart(): Promise<void> {
  const dialogIds = await DialogPersistence.listAllDialogIds('running');
  for (const dialogId of dialogIds) {
    let latest: DialogLatestFile | null;
    try {
      latest = await DialogPersistence.loadDialogLatest(dialogId, 'running');
    } catch (error: unknown) {
      if (!findDomindsPersistenceFileError(error)) {
        throw error;
      }
      log.warn('Skipping malformed dialog during display-state restart reconciliation', error, {
        dialogId: dialogId.valueOf(),
      });
      continue;
    }
    const existing = latest?.displayState;

    const existingMarker = latest?.executionMarker;

    if (existingMarker && existingMarker.kind === 'dead' && dialogId.selfId !== dialogId.rootId) {
      if (latest?.generating === true) {
        try {
          await DialogPersistence.mutateDialogLatest(dialogId, () => ({
            kind: 'patch',
            patch: {
              generating: false,
              displayState: latest.displayState ?? { kind: 'dead', reason: existingMarker.reason },
              executionMarker: existingMarker,
            },
          }));
        } catch (err) {
          log.warn('Failed to clear generating flag for dead dialog after restart', err, {
            dialogId: dialogId.valueOf(),
          });
        }
      }
      continue;
    }

    const wasProceeding =
      latest?.generating === true ||
      (existing !== undefined &&
        (existing.kind === 'proceeding' || existing.kind === 'proceeding_stop_requested'));

    if (wasProceeding) {
      const nextIdle = await computeIdleDisplayStateForReconciliation(dialogId);
      if (!nextIdle) {
        continue;
      }
      const next =
        nextIdle.kind === 'blocked'
          ? nextIdle
          : ({
              kind: 'stopped',
              reason: { kind: 'server_restart' },
              continueEnabled: true,
            } satisfies DialogDisplayState);
      try {
        await DialogPersistence.mutateDialogLatest(dialogId, () => ({
          kind: 'patch',
          patch: {
            generating: false,
            displayState: next,
            executionMarker:
              next.kind === 'stopped' ? { kind: 'interrupted', reason: next.reason } : undefined,
          },
        }));
      } catch (err) {
        log.warn('Failed to reconcile proceeding dialog after restart', err, {
          dialogId: dialogId.valueOf(),
        });
      }
      continue;
    }

    if (!existing) {
      const inferred = await computeIdleDisplayStateForReconciliation(dialogId);
      if (!inferred) {
        continue;
      }
      try {
        await DialogPersistence.mutateDialogLatest(dialogId, () => ({
          kind: 'patch',
          patch: { displayState: inferred },
        }));
      } catch (err) {
        log.warn('Failed to backfill missing displayState', err, { dialogId: dialogId.valueOf() });
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
  await setDialogDisplayState(dialogId, { kind: 'proceeding_stop_requested', reason });
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
