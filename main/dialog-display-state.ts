/**
 * Module: dialog-display-state
 *
 * Owns the persisted/broadcast display-state projection for dialogs, plus best-effort
 * cancellation for in-flight dialog drives.
 *
 * Design constraints:
 * - `displayState` is a UI/diagnostic projection, not a business source of truth.
 * - Primary control flow must rely on underlying facts (active runs, stop requests,
 *   pending Q4H, active callee dispatches, queued prompts, persisted status, explicit
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
import type {
  DialogExecutionMarker,
  DialogLatestFile,
  TellaskReplyDirective,
} from '@longrun-ai/kernel/types/storage';
import type { WebSocketMessage } from '@longrun-ai/kernel/types/wire';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { DialogID, type Dialog } from './dialog';
import { getRecoverableGenerationRunState } from './dialog-generation-run';
import { globalDialogRegistry } from './dialog-global-registry';
import { isInterruptionReasonManualResumeEligible } from './dialog-interruption';
import { createEmptyDialogNextStepState } from './dialog-latest-state';
import { dialogEventRegistry } from './evt-registry';
import { createLogger } from './log';
import { DialogPersistence } from './persistence';
import { findDomindsPersistenceFileError } from './persistence-errors';
import { isUserInterjectionPauseStopReason } from './runtime/interjection-pause-stop';

const log = createLogger('dialog-display-state');

type StopRequestedReason = 'user_stop' | 'emergency_stop';

type ActiveRun = {
  abortController: AbortController;
  stopRequested?: StopRequestedReason;
};

let broadcastToClients: ((msg: WebSocketMessage) => void) | undefined;

const activeRunsByDialogKey: Map<string, ActiveRun> = new Map();
const quarantiningMainDialogIds: Set<string> = new Set();

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

function isNonIdleDisplayProjection(state: DialogDisplayState | undefined): boolean {
  return state !== undefined && state.kind !== 'idle_waiting_user';
}

function hasPendingNextStepTriggers(latest: DialogLatestFile | null | undefined): boolean {
  return (latest?.nextStep.triggers.length ?? 0) > 0;
}

function q4hSuspensionDisplayState(hasQ4H: boolean): DialogDisplayState | undefined {
  if (hasQ4H) {
    return { kind: 'blocked', reason: { kind: 'needs_human_input' } };
  }
  return undefined;
}

async function backgroundCalleeSuspensionDisplayState(
  dialogId: DialogID,
  status: 'running' | 'completed' | 'archived',
  activeReplyObligation: TellaskReplyDirective | undefined,
): Promise<DialogDisplayState | undefined> {
  if (status !== 'running' || activeReplyObligation === undefined) {
    return undefined;
  }
  const activeCallees = await DialogPersistence.loadActiveCallees(dialogId, status);
  const hasPendingBackgroundCallee = activeCallees.batches.some((batch) =>
    batch.callees.some((callee) => callee.status === 'pending'),
  );
  if (!hasPendingBackgroundCallee) {
    return undefined;
  }
  return { kind: 'waiting_side_dialog' };
}

function pendingReplyObligationDisplayState(
  activeReplyObligation: TellaskReplyDirective | undefined,
): DialogDisplayState | undefined {
  if (activeReplyObligation === undefined) {
    return undefined;
  }
  return {
    kind: 'stopped',
    reason: { kind: 'pending_reply_obligation' },
    continueEnabled: true,
  };
}

type SideDialogFinalResponseClosure =
  | Readonly<{
      kind: 'no_final_response';
    }>
  | Readonly<{
      kind: 'closed_without_active_reply_obligation';
      callId: string;
    }>
  | Readonly<{
      kind: 'closed_with_matching_reply_obligation';
      callId: string;
      activeReplyObligation: TellaskReplyDirective;
    }>
  | Readonly<{
      kind: 'blocked_by_different_reply_obligation';
      callId: string;
      activeReplyObligation: TellaskReplyDirective;
    }>;

async function resolveSideDialogFinalResponseClosure(args: {
  dialogId: DialogID;
  latest: DialogLatestFile | null | undefined;
}): Promise<SideDialogFinalResponseClosure> {
  if (!args.latest) {
    return { kind: 'no_final_response' };
  }
  const finalResponseAnchor = args.latest.sideDialogFinalResponse;
  if (!finalResponseAnchor) {
    return { kind: 'no_final_response' };
  }
  const finalResponseCallId = finalResponseAnchor.callId.trim();
  const activeReplyObligation = await DialogPersistence.loadActiveTellaskReplyObligation(
    args.dialogId,
    'running',
  );
  if (activeReplyObligation === undefined) {
    return {
      kind: 'closed_without_active_reply_obligation',
      callId: finalResponseCallId,
    };
  }
  if (activeReplyObligation.targetCallId.trim() === finalResponseCallId) {
    return {
      kind: 'closed_with_matching_reply_obligation',
      callId: finalResponseCallId,
      activeReplyObligation,
    };
  }
  return {
    kind: 'blocked_by_different_reply_obligation',
    callId: finalResponseCallId,
    activeReplyObligation,
  };
}

async function clearMatchingFinalResponseReplyObligation(
  dialogId: DialogID,
  closure: SideDialogFinalResponseClosure,
): Promise<boolean> {
  if (closure.kind !== 'closed_with_matching_reply_obligation') {
    return false;
  }
  await DialogPersistence.setActiveTellaskReplyObligation(dialogId, undefined, 'running');
  return true;
}

async function settleFinalResponseClosureForIdleProjection(
  dialogId: DialogID,
  closure: SideDialogFinalResponseClosure,
): Promise<boolean> {
  switch (closure.kind) {
    case 'no_final_response':
    case 'blocked_by_different_reply_obligation':
      return false;
    case 'closed_without_active_reply_obligation':
      return true;
    case 'closed_with_matching_reply_obligation':
      await clearMatchingFinalResponseReplyObligation(dialogId, closure);
      return true;
    default: {
      const _exhaustive: never = closure;
      throw new Error(`Unhandled final response closure kind: ${String(_exhaustive)}`);
    }
  }
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
      if (quarantiningMainDialogIds.has(dialogId.rootId)) {
        continue;
      }
      // listAllDialogIds() is intentionally a candidate scan. Per-dialog latest reads below may
      // still quarantine one malformed dialog without invalidating the rest of the snapshot.
      const activeRun = activeRunKeysByDialogKey.get(dialogKey);
      if (activeRun) {
        proceeding++;
        continue;
      }
      let latest = await DialogPersistence.loadDialogLatest(dialogId, 'running');
      if (!latest) {
        continue;
      }
      const healedLatest = await healStaleSideDialogRunControlAfterFinalResponse({
        dialogId,
        latest,
        trigger: 'run_control_snapshot',
      });
      latest = healedLatest;
      if (latest?.generating === true) {
        proceeding++;
      } else if (
        latest?.executionMarker?.kind === 'interrupted' &&
        isStoppedReasonResumable(latest.executionMarker.reason)
      ) {
        // Keep run-control counts aligned with actual Continue affordance:
        // - ordinary interrupted dialogs count as resumable only when no Q4H suspension remains
        // - legacy interjection-paused dialogs still count as resumable even if Q4H remains,
        //   because Continue only re-evaluates the original task from fresh facts
        if (isUserInterjectionPauseStopReason(latest.executionMarker.reason)) {
          resumable++;
        } else {
          if (latest.userWait?.kind !== 'awaiting_user_answer') {
            resumable++;
          }
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
    if (!rootId || quarantiningMainDialogIds.has(rootId)) {
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
    clearQuarantiningMainDialogIfIdle(dialogId.rootId);
    return;
  }
  clearQuarantiningMainDialogIfIdle(dialogId.rootId);
  if (options?.notifyBackendLoop !== false) {
    globalDialogRegistry.notifyActiveRunCleared(dialogId.rootId, {
      source: 'dialog_display_state_active_run_clear',
      reason:
        dialogId.selfId === dialogId.rootId
          ? 'root_active_run_cleared'
          : 'sideDialog_active_run_cleared',
    });
  }
  syncRunControlCountsAfterActiveRunChange('clear_active_run', dialogId);
}

function clearQuarantiningMainDialogIfIdle(rootId: string): void {
  for (const key of activeRunsByDialogKey.keys()) {
    const [candidateRootId] = key.includes('#') ? key.split('#') : [key];
    if (candidateRootId === rootId) {
      return;
    }
  }
  quarantiningMainDialogIds.delete(rootId);
}

export function clearMainDialogQuarantiningIfIdle(mainDialogId: DialogID): void {
  clearQuarantiningMainDialogIfIdle(mainDialogId.selfId);
}

export function markMainDialogQuarantining(mainDialogId: DialogID): void {
  quarantiningMainDialogIds.add(mainDialogId.selfId);
}

export function clearMainDialogQuarantining(mainDialogId: DialogID): void {
  quarantiningMainDialogIds.delete(mainDialogId.selfId);
}

export async function forceStopActiveRunsForMainDialog(mainDialogId: DialogID): Promise<void> {
  for (const key of Array.from(activeRunsByDialogKey.keys())) {
    const [rootId, selfId] = key.includes('#') ? key.split('#') : [key, key];
    if (!rootId || !selfId) continue;
    if (rootId !== mainDialogId.selfId) continue;
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
        log.warn('Failed to persist stop-requested state while forcing main dialog stop', error, {
          dialogId: dialogId.valueOf(),
          mainDialogId: mainDialogId.valueOf(),
        });
      }
    }
    try {
      run.abortController.abort();
    } catch (error: unknown) {
      log.warn('Failed to abort active run while forcing main dialog stop', error, {
        dialogId: dialogId.valueOf(),
        mainDialogId: mainDialogId.valueOf(),
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
  status: 'running' | 'completed' | 'archived' = 'running',
): Promise<void> {
  if (executionMarker?.kind === 'dead' && dialogId.selfId === dialogId.rootId) {
    log.warn(
      'Rejecting dead executionMarker for main dialog (main dialogs must not be dead)',
      undefined,
      {
        dialogId: dialogId.valueOf(),
      },
    );
    return;
  }

  try {
    await DialogPersistence.mutateDialogLatest(
      dialogId,
      () => ({
        kind: 'patch',
        patch: { executionMarker },
      }),
      status,
    );
  } catch (err) {
    log.warn('Failed to persist dialog executionMarker', err, {
      dialogId: dialogId.valueOf(),
      rootId: dialogId.rootId,
      selfId: dialogId.selfId,
      status,
      intendedExecutionMarker: executionMarker ?? null,
    });
  }
}

export async function clearDialogInterruptedExecutionMarker(
  dialogId: DialogID,
  status: 'running' | 'completed' | 'archived' = 'running',
): Promise<void> {
  try {
    const latest = await DialogPersistence.loadDialogLatest(dialogId, status);
    if (latest?.executionMarker?.kind !== 'interrupted') {
      return;
    }
  } catch (err) {
    log.warn('Failed to inspect executionMarker before clearing interrupted marker', err, {
      dialogId: dialogId.valueOf(),
      status,
    });
    return;
  }
  await setDialogExecutionMarker(dialogId, undefined, status);
}

export async function setDialogDisplayState(
  dialogId: DialogID,
  displayState: DialogDisplayState,
  status: 'running' | 'completed' | 'archived' = 'running',
): Promise<void> {
  if (displayState.kind === 'dead' && dialogId.selfId === dialogId.rootId) {
    log.warn(
      'Rejecting dead displayState for main dialog (main dialogs must not be dead)',
      undefined,
      {
        dialogId: dialogId.valueOf(),
      },
    );
    return;
  }

  let nextDisplayState = displayState;
  let previousDisplayState: DialogDisplayState | undefined;
  let previousExecutionMarker: DialogExecutionMarker | undefined;
  // "dead" is irreversible. Once a dialog is marked dead, do not allow overwriting it with
  // another state (best-effort; races may still exist across concurrent writers).
  try {
    const latest = await DialogPersistence.loadDialogLatest(dialogId, status);
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
    if (status === 'running' && displayState.kind === 'idle_waiting_user') {
      const q4hSuspension = q4hSuspensionDisplayState(
        latest?.userWait?.kind === 'awaiting_user_answer',
      );
      if (q4hSuspension) {
        nextDisplayState = q4hSuspension;
        log.warn('Redirecting idle displayState to suspension projection', undefined, {
          dialogId: dialogId.valueOf(),
          rootId: dialogId.rootId,
          selfId: dialogId.selfId,
          status,
          suspensionDisplayState: nextDisplayState,
          previousDisplayState: latest?.displayState ?? null,
          previousExecutionMarker: latest?.executionMarker ?? null,
        });
      } else if (
        !(await settleFinalResponseClosureForIdleProjection(
          dialogId,
          await resolveSideDialogFinalResponseClosure({
            dialogId,
            latest,
          }),
        ))
      ) {
        const activeReplyObligation = await DialogPersistence.loadActiveTellaskReplyObligation(
          dialogId,
          status,
        );
        const backgroundCalleeSuspension = await backgroundCalleeSuspensionDisplayState(
          dialogId,
          status,
          activeReplyObligation,
        );
        if (backgroundCalleeSuspension) {
          nextDisplayState = backgroundCalleeSuspension;
          log.warn('Redirecting idle displayState to suspension projection', undefined, {
            dialogId: dialogId.valueOf(),
            rootId: dialogId.rootId,
            selfId: dialogId.selfId,
            status,
            suspensionDisplayState: nextDisplayState,
            targetCallId: activeReplyObligation?.targetCallId ?? null,
            targetDialogId: activeReplyObligation?.targetDialogId.valueOf() ?? null,
            previousDisplayState: latest?.displayState ?? null,
            previousExecutionMarker: latest?.executionMarker ?? null,
          });
        } else {
          const pendingReplyObligation = pendingReplyObligationDisplayState(activeReplyObligation);
          if (pendingReplyObligation) {
            nextDisplayState = pendingReplyObligation;
            log.warn(
              'Redirecting idle displayState to pending reply obligation projection',
              undefined,
              {
                dialogId: dialogId.valueOf(),
                rootId: dialogId.rootId,
                selfId: dialogId.selfId,
                status,
                targetCallId: activeReplyObligation?.targetCallId ?? null,
                targetDialogId: activeReplyObligation?.targetDialogId.valueOf() ?? null,
                previousDisplayState: latest?.displayState ?? null,
                previousExecutionMarker: latest?.executionMarker ?? null,
                sideDialogFinalResponseCallId: latest?.sideDialogFinalResponse?.callId ?? null,
              },
            );
          }
        }
      }
    }
  } catch (err) {
    log.warn('Failed to check existing displayState before setDialogDisplayState', err, {
      dialogId: dialogId.valueOf(),
      status,
      intendedDisplayState: displayState,
    });
    if (status === 'running' && displayState.kind === 'idle_waiting_user') {
      return;
    }
  }

  const nextExecutionMarker: DialogExecutionMarker | undefined =
    nextDisplayState.kind === 'stopped'
      ? { kind: 'interrupted', reason: nextDisplayState.reason }
      : nextDisplayState.kind === 'dead'
        ? { kind: 'dead', reason: nextDisplayState.reason }
        : previousExecutionMarker?.kind === 'interrupted'
          ? undefined
          : previousExecutionMarker;

  try {
    await DialogPersistence.mutateDialogLatest(
      dialogId,
      () => ({
        kind: 'patch',
        patch: { displayState: nextDisplayState, executionMarker: nextExecutionMarker },
      }),
      status,
    );
  } catch (err) {
    log.warn('Failed to persist dialog displayState', err, {
      dialogId: dialogId.valueOf(),
      rootId: dialogId.rootId,
      selfId: dialogId.selfId,
      status,
      intendedDisplayState: displayState,
      persistedDisplayState: nextDisplayState,
    });
  }

  const typed = dialogEventRegistry.createTypedEvent(dialogId, {
    type: 'dlg_display_state_evt',
    displayState: nextDisplayState,
  });

  if (broadcastToClients) {
    broadcastToClients(typed);
  }
  if (shouldBroadcastRunControlCounts(previousDisplayState, nextDisplayState)) {
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
  if (
    latest?.executionMarker?.kind === 'interrupted' &&
    latest.executionMarker.reason.kind !== 'pending_reply_obligation'
  ) {
    return {
      kind: 'stopped',
      reason: latest.executionMarker.reason,
      continueEnabled: isStoppedReasonResumable(latest.executionMarker.reason),
    };
  }
  if (latest?.pendingRuntimePrompt) {
    return {
      kind: 'stopped',
      reason: { kind: 'pending_runtime_prompt' },
      continueEnabled: true,
    };
  }
  const q4hSuspension = q4hSuspensionDisplayState(
    latest?.userWait?.kind === 'awaiting_user_answer',
  );
  if (q4hSuspension) {
    return q4hSuspension;
  }
  const finalResponseClosure = await resolveSideDialogFinalResponseClosure({
    dialogId: dlg.id,
    latest,
  });
  if (await settleFinalResponseClosureForIdleProjection(dlg.id, finalResponseClosure)) {
    return { kind: 'idle_waiting_user' };
  }
  const activeReplyObligation = await DialogPersistence.loadActiveTellaskReplyObligation(
    dlg.id,
    dlg.status,
  );
  const backgroundCalleeSuspension = await backgroundCalleeSuspensionDisplayState(
    dlg.id,
    dlg.status,
    activeReplyObligation,
  );
  if (backgroundCalleeSuspension) {
    return backgroundCalleeSuspension;
  }
  const pendingReplyObligation = pendingReplyObligationDisplayState(activeReplyObligation);
  if (pendingReplyObligation) {
    return pendingReplyObligation;
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
  if (
    latest?.executionMarker?.kind === 'interrupted' &&
    latest.executionMarker.reason.kind !== 'pending_reply_obligation'
  ) {
    return {
      kind: 'stopped',
      reason: latest.executionMarker.reason,
      continueEnabled: isStoppedReasonResumable(latest.executionMarker.reason),
    };
  }
  if (latest?.pendingRuntimePrompt) {
    return {
      kind: 'stopped',
      reason: { kind: 'pending_runtime_prompt' },
      continueEnabled: true,
    };
  }
  const q4hSuspension = q4hSuspensionDisplayState(
    latest?.userWait?.kind === 'awaiting_user_answer',
  );
  if (q4hSuspension) {
    return q4hSuspension;
  }
  const finalResponseClosure = await resolveSideDialogFinalResponseClosure({ dialogId, latest });
  if (await settleFinalResponseClosureForIdleProjection(dialogId, finalResponseClosure)) {
    return { kind: 'idle_waiting_user' };
  }
  const activeReplyObligation = await DialogPersistence.loadActiveTellaskReplyObligation(
    dialogId,
    'running',
  );
  const backgroundCalleeSuspension = await backgroundCalleeSuspensionDisplayState(
    dialogId,
    'running',
    activeReplyObligation,
  );
  if (backgroundCalleeSuspension) {
    return backgroundCalleeSuspension;
  }
  const pendingReplyObligation = pendingReplyObligationDisplayState(activeReplyObligation);
  if (pendingReplyObligation) {
    return pendingReplyObligation;
  }
  return { kind: 'idle_waiting_user' };
}

async function healStaleSideDialogRunControlAfterFinalResponse(args: {
  dialogId: DialogID;
  latest: DialogLatestFile;
  trigger: string;
}): Promise<DialogLatestFile | null> {
  if (
    args.dialogId.selfId === args.dialogId.rootId ||
    (!hasPendingNextStepTriggers(args.latest) &&
      args.latest.generating !== true &&
      args.latest.executionMarker?.kind !== 'interrupted' &&
      !isNonIdleDisplayProjection(args.latest.displayState))
  ) {
    return args.latest;
  }
  if (args.latest.executionMarker?.kind === 'dead') {
    return args.latest;
  }
  if (args.latest.pendingRuntimePrompt) {
    return args.latest;
  }
  const finalResponseClosure = await resolveSideDialogFinalResponseClosure({
    dialogId: args.dialogId,
    latest: args.latest,
  });
  if (
    finalResponseClosure.kind !== 'closed_without_active_reply_obligation' &&
    finalResponseClosure.kind !== 'closed_with_matching_reply_obligation'
  ) {
    return args.latest;
  }
  if (!(await settleFinalResponseClosureForIdleProjection(args.dialogId, finalResponseClosure))) {
    return args.latest;
  }
  const clearedReplyObligation =
    finalResponseClosure.kind === 'closed_with_matching_reply_obligation';

  log.warn('Healing stale sideDialog run-control flags after final response anchor', undefined, {
    dialogId: args.dialogId.valueOf(),
    trigger: args.trigger,
    responseCallId: finalResponseClosure.callId,
    clearedReplyObligation,
    previousGenerating: args.latest.generating ?? null,
    previousNextStepTriggerCount: args.latest.nextStep.triggers.length,
    previousDisplayState: args.latest.displayState ?? null,
    previousExecutionMarker: args.latest.executionMarker ?? null,
  });
  await DialogPersistence.mutateDialogLatest(args.dialogId, () => ({
    kind: 'patch',
    patch: {
      generating: false,
      nextStep: createEmptyDialogNextStepState(),
      displayState: { kind: 'idle_waiting_user' },
      executionMarker: undefined,
    },
  }));
  return await DialogPersistence.loadDialogLatest(args.dialogId, 'running');
}

export async function refreshRunControlProjectionFromPersistenceFacts(
  dialogId: DialogID,
  trigger:
    | 'resume_dialog'
    | 'resume_all'
    | 'run_control_snapshot'
    | 'active_callee_dispatches_changed'
    | 'q4h_changed'
    | 'restart_reconciliation',
): Promise<DialogLatestFile | null> {
  let latest = await DialogPersistence.loadDialogLatest(dialogId, 'running');
  if (!latest) {
    return null;
  }

  if (hasActiveRun(dialogId)) {
    return latest;
  }

  const healedStaleSideDialogRunControl = await healStaleSideDialogRunControlAfterFinalResponse({
    dialogId,
    latest,
    trigger,
  });
  if (!healedStaleSideDialogRunControl) {
    return null;
  }
  latest = healedStaleSideDialogRunControl;

  if (latest.generating === true) {
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
    if (
      latest.executionMarker?.kind === 'interrupted' &&
      isUserInterjectionPauseStopReason(latest.executionMarker.reason)
    ) {
      // WARNING:
      // This is the one place where the projection intentionally preserves legacy
      // paused-interjection stopped state ahead of the current suspension facts. That is not a bug:
      // the UI may still need to show that the original task was paused even if the underlying
      // dialog is now waiting on Q4H.
      //
      // The true source-of-truth decision about what Continue should do next lives in `flow.ts`'s
      // resume path, which performs a fresh fact scan at resume time and then either restores the
      // Q4H suspension projection or keeps driving immediately.
      //
      // Do not "heal" this branch away by prioritizing suspension facts here; that would collapse the
      // temporary interjection UX and make repeated interjection turns revert too early.
      return {
        kind: 'stopped',
        reason: latest.executionMarker.reason,
        continueEnabled: isStoppedReasonResumable(latest.executionMarker.reason),
      };
    }
    if (latest.pendingRuntimePrompt) {
      return {
        kind: 'stopped',
        reason: { kind: 'pending_runtime_prompt' },
        continueEnabled: true,
      };
    }
    const q4hSuspension = q4hSuspensionDisplayState(
      latest.userWait?.kind === 'awaiting_user_answer',
    );
    if (q4hSuspension) {
      return q4hSuspension;
    }
    const finalResponseClosure = await resolveSideDialogFinalResponseClosure({ dialogId, latest });
    if (await settleFinalResponseClosureForIdleProjection(dialogId, finalResponseClosure)) {
      return { kind: 'idle_waiting_user' };
    }
    const activeReplyObligation = await DialogPersistence.loadActiveTellaskReplyObligation(
      dialogId,
      'running',
    );
    const backgroundCalleeSuspension = await backgroundCalleeSuspensionDisplayState(
      dialogId,
      'running',
      activeReplyObligation,
    );
    if (backgroundCalleeSuspension) {
      return backgroundCalleeSuspension;
    }
    const pendingReplyObligation = pendingReplyObligationDisplayState(activeReplyObligation);
    if (pendingReplyObligation) {
      return pendingReplyObligation;
    }
    if (
      latest.executionMarker?.kind === 'interrupted' &&
      latest.executionMarker.reason.kind !== 'pending_reply_obligation'
    ) {
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
    if (!latest) {
      continue;
    }

    const existing = latest.displayState;
    const existingMarker = latest.executionMarker;

    if (existingMarker && existingMarker.kind === 'dead' && dialogId.selfId !== dialogId.rootId) {
      if (latest.generating === true) {
        const displayState = latest.displayState ?? { kind: 'dead', reason: existingMarker.reason };
        try {
          await DialogPersistence.mutateDialogLatest(dialogId, () => ({
            kind: 'patch',
            patch: {
              generating: false,
              displayState,
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

    if (latest.generating === true && latest.generationRunState === undefined) {
      await DialogPersistence.quarantineMalformedRuntimeState(
        dialogId,
        'running',
        'restart_reconciliation_missing_generation_run_state',
        `Restart reconciliation refused to recover generating dialog without generationRunState (rootId=${dialogId.rootId}, selfId=${dialogId.selfId})`,
      );
      continue;
    }

    if (
      dialogId.selfId !== dialogId.rootId &&
      (latest.generating === true ||
        hasPendingNextStepTriggers(latest) ||
        latest.executionMarker?.kind === 'interrupted' ||
        isNonIdleDisplayProjection(latest.displayState))
    ) {
      const healedStaleSideDialogRunControl = await healStaleSideDialogRunControlAfterFinalResponse(
        {
          dialogId,
          latest,
          trigger: 'restart_reconciliation',
        },
      );
      if (!healedStaleSideDialogRunControl) {
        continue;
      }
      latest = healedStaleSideDialogRunControl;
      if (latest.generating !== true && !hasPendingNextStepTriggers(latest)) {
        continue;
      }
    }

    const recoverableGenerationRunState = getRecoverableGenerationRunState(latest);
    if (recoverableGenerationRunState !== undefined) {
      try {
        await DialogPersistence.upsertNextStepTrigger(
          dialogId,
          {
            triggerId: `open-generation-recovery:${dialogId.selfId}:${recoverableGenerationRunState.course}:${recoverableGenerationRunState.genseq}`,
            kind: 'open_generation_recovery',
            course: recoverableGenerationRunState.course,
            genseq: recoverableGenerationRunState.genseq,
            createdAt: recoverableGenerationRunState.openedAt,
          },
          'running',
        );
        await DialogPersistence.mutateDialogLatest(dialogId, () => ({
          kind: 'patch',
          patch: {
            displayState: { kind: 'proceeding' },
            executionMarker:
              existingMarker?.kind === 'interrupted' &&
              (existingMarker.reason.kind === 'pending_runtime_prompt' ||
                existingMarker.reason.kind === 'pending_reply_obligation')
                ? undefined
                : existingMarker,
          },
        }));
      } catch (err) {
        log.warn('Failed to preserve open-generation dialog for auto-drive after restart', err, {
          dialogId: dialogId.valueOf(),
        });
      }
      continue;
    }

    if (latest.generating === true || hasPendingNextStepTriggers(latest)) {
      const nextIdle = await computeIdleDisplayStateForReconciliation(dialogId);
      if (!nextIdle) {
        continue;
      }
      const next =
        nextIdle.kind === 'blocked' ||
        nextIdle.kind === 'waiting_side_dialog' ||
        nextIdle.kind === 'stopped' ||
        nextIdle.kind === 'dead'
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
        log.warn('Failed to reconcile open-generation dialog after restart', err, {
          dialogId: dialogId.valueOf(),
        });
      }
      continue;
    }

    if (
      latest.userWait?.kind === 'awaiting_user_answer' ||
      latest.pendingRuntimePrompt !== undefined ||
      latest.executionMarker?.kind === 'interrupted' ||
      isNonIdleDisplayProjection(latest.displayState)
    ) {
      try {
        await refreshRunControlProjectionFromPersistenceFacts(dialogId, 'restart_reconciliation');
      } catch (err) {
        log.warn('Failed to refresh stale run-control projection after restart', err, {
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
