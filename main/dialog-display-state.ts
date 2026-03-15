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
import type { DialogExecutionMarker } from '@longrun-ai/kernel/types/storage';
import type { WebSocketMessage } from '@longrun-ai/kernel/types/wire';
import { DialogID, type Dialog } from './dialog';
import { dialogEventRegistry } from './evt-registry';
import { createLogger } from './log';
import { DialogPersistence } from './persistence';
import { formatUnifiedTimestamp } from './shared/utils/time';

const log = createLogger('dialog-display-state');

type StopRequestedReason = 'user_stop' | 'emergency_stop';

type ActiveRun = {
  abortController: AbortController;
  stopRequested?: StopRequestedReason;
};

let broadcastToClients: ((msg: WebSocketMessage) => void) | undefined;

const activeRunsByDialogKey: Map<string, ActiveRun> = new Map();

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

function classifyRunControlBucket(state: DialogDisplayState | undefined): RunControlBucket {
  if (!state) return 'none';
  if (state.kind === 'proceeding' || state.kind === 'proceeding_stop_requested') {
    return 'proceeding';
  }
  if (state.kind === 'interrupted') {
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
  const activeRunDialogKeys = new Set(activeRunsByDialogKey.keys());
  const seenDialogKeys = new Set<string>();
  const dialogIds = await DialogPersistence.listAllDialogIds('running');
  for (const dialogId of dialogIds) {
    const dialogKey = dialogId.key();
    seenDialogKeys.add(dialogKey);
    // Active in-memory drives are authoritative for "proceeding". This avoids transient
    // under-count windows when displayState persistence lags behind an already started drive.
    if (activeRunDialogKeys.has(dialogKey)) {
      proceeding++;
      continue;
    }
    const latest = await DialogPersistence.loadDialogLatest(dialogId, 'running');
    if (latest?.generating === true) {
      proceeding++;
    } else if (latest?.executionMarker?.kind === 'interrupted') {
      resumable++;
    }
  }
  for (const dialogKey of activeRunDialogKeys) {
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

export function clearActiveRun(dialogId: DialogID): void {
  const deleted = activeRunsByDialogKey.delete(dialogId.key());
  if (!deleted) return;
  syncRunControlCountsAfterActiveRunChange('clear_active_run', dialogId);
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
    displayState.kind === 'interrupted'
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
    return { kind: 'terminal', status: dlg.status };
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
    return { kind: 'interrupted', reason: latest.executionMarker.reason };
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
    return { kind: 'terminal', status };
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
    return { kind: 'interrupted', reason: latest.executionMarker.reason };
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

export async function reconcileDisplayStatesAfterRestart(): Promise<void> {
  const dialogIds = await DialogPersistence.listAllDialogIds('running');
  for (const dialogId of dialogIds) {
    const latest = await DialogPersistence.loadDialogLatest(dialogId, 'running');
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
      const nextIdle = await computeIdleDisplayStateFromPersistence(dialogId);
      const next =
        nextIdle.kind === 'blocked'
          ? nextIdle
          : ({
              kind: 'interrupted',
              reason: { kind: 'server_restart' },
            } satisfies DialogDisplayState);
      try {
        await DialogPersistence.mutateDialogLatest(dialogId, () => ({
          kind: 'patch',
          patch: {
            generating: false,
            displayState: next,
            executionMarker:
              next.kind === 'interrupted'
                ? { kind: 'interrupted', reason: next.reason }
                : undefined,
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
      const inferred = await computeIdleDisplayStateFromPersistence(dialogId);
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
