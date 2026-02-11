import { Dialog, DialogID, RootDialog, SubDialog } from './dialog';
import { globalDialogRegistry } from './dialog-global-registry';
import { DialogPersistence, DiskFileDialogStore } from './persistence';
import { DEFAULT_DILIGENCE_PUSH_MAX } from './shared/diligence';
import { Team } from './team';

export type DialogPersistenceStatus = 'running' | 'completed' | 'archived';

function resolveMemberDiligencePushMax(team: Team, agentId: string): number {
  const member = team.getMember(agentId);
  if (member && member.diligence_push_max !== undefined) {
    return member.diligence_push_max;
  }
  return DEFAULT_DILIGENCE_PUSH_MAX;
}

function normalizeDiligencePushMax(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.floor(value);
}

function clampNonNegativeFiniteInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

export async function getOrRestoreRootDialog(
  rootId: string,
  status: DialogPersistenceStatus,
): Promise<RootDialog | undefined> {
  const existing = globalDialogRegistry.get(rootId);
  if (existing) {
    existing.setPersistenceStatus(status);
    await existing.loadSubdialogRegistry();
    await existing.loadPendingSubdialogsFromPersistence();
    return existing;
  }

  const rootDialogId = new DialogID(rootId);
  const rootState = await DialogPersistence.restoreDialog(rootDialogId, status);
  if (!rootState) return undefined;
  const rootMetadata = rootState.metadata;
  if (rootMetadata.supdialogId !== undefined) {
    return undefined;
  }

  const latest = await DialogPersistence.loadDialogLatest(rootDialogId, status);
  let diligencePushMax = DEFAULT_DILIGENCE_PUSH_MAX;
  try {
    const team = await Team.load();
    diligencePushMax = normalizeDiligencePushMax(
      resolveMemberDiligencePushMax(team, rootMetadata.agentId),
    );
  } catch (_err: unknown) {
    diligencePushMax = DEFAULT_DILIGENCE_PUSH_MAX;
  }
  const defaultDisableDiligencePush = diligencePushMax <= 0;

  const rootStore = new DiskFileDialogStore(rootDialogId);
  const rootDialog = new RootDialog(
    rootStore,
    rootMetadata.taskDocPath,
    rootDialogId,
    rootMetadata.agentId,
    {
      messages: rootState.messages,
      reminders: rootState.reminders,
      currentCourse: rootState.currentCourse,
      contextHealth: rootState.contextHealth,
    },
  );
  const persistedSubdialogAgentPrimingMode =
    rootMetadata.subdialogAgentPrimingMode === 'do' ||
    rootMetadata.subdialogAgentPrimingMode === 'reuse' ||
    rootMetadata.subdialogAgentPrimingMode === 'skip'
      ? rootMetadata.subdialogAgentPrimingMode
      : 'reuse';
  rootDialog.setSubdialogAgentPrimingMode(persistedSubdialogAgentPrimingMode);
  const persistedDisableDiligencePush =
    latest && typeof latest.disableDiligencePush === 'boolean'
      ? latest.disableDiligencePush
      : defaultDisableDiligencePush;
  rootDialog.disableDiligencePush = persistedDisableDiligencePush;

  const persistedRemainingBudget =
    latest && typeof latest.diligencePushRemainingBudget === 'number'
      ? latest.diligencePushRemainingBudget
      : undefined;
  const normalizedRemainingBudget = clampNonNegativeFiniteInt(
    persistedRemainingBudget,
    diligencePushMax > 0 ? diligencePushMax : 0,
  );
  rootDialog.diligencePushRemainingBudget =
    diligencePushMax > 0
      ? Math.min(normalizedRemainingBudget, diligencePushMax)
      : normalizedRemainingBudget;

  rootDialog.setPersistenceStatus(status);
  globalDialogRegistry.register(rootDialog);

  // Keep the in-memory root dialog fully hydrated regardless of persistence status
  // (running/completed/archived) so subdialog lookup is stable across UI navigation.
  await rootDialog.loadSubdialogRegistry();
  await rootDialog.loadPendingSubdialogsFromPersistence();
  return rootDialog;
}

export async function ensureDialogLoaded(
  rootDialog: RootDialog,
  targetId: DialogID,
  status: DialogPersistenceStatus,
  visitedSelfIds: Set<string> = new Set(),
): Promise<Dialog | undefined> {
  if (targetId.selfId === targetId.rootId) return rootDialog;

  const existing = rootDialog.lookupDialog(targetId.selfId);
  if (existing) return existing;

  if (visitedSelfIds.has(targetId.selfId)) return undefined;
  visitedSelfIds.add(targetId.selfId);

  const metadata = await DialogPersistence.loadDialogMetadata(targetId, status);
  if (!metadata) return undefined;

  // Ensure parent dialog (supdialog) exists in root registry for SubDialog.supdialog resolution.
  if (metadata.supdialogId && metadata.supdialogId !== targetId.rootId) {
    await ensureDialogLoaded(
      rootDialog,
      new DialogID(metadata.supdialogId, targetId.rootId),
      status,
      visitedSelfIds,
    );
  }

  const state = await DialogPersistence.restoreDialog(targetId, status);
  if (!state) return undefined;

  const latest = await DialogPersistence.loadDialogLatest(targetId, status);

  const assignmentFromSup = state.metadata.assignmentFromSup;
  if (!assignmentFromSup) return undefined;

  // Ensure the caller dialog exists so SubDialog can resolve its effective supdialog.
  if (
    assignmentFromSup.callerDialogId &&
    assignmentFromSup.callerDialogId !== targetId.rootId &&
    assignmentFromSup.callerDialogId !== targetId.selfId
  ) {
    await ensureDialogLoaded(
      rootDialog,
      new DialogID(assignmentFromSup.callerDialogId, targetId.rootId),
      status,
      visitedSelfIds,
    );
  }

  const store = new DiskFileDialogStore(targetId);
  const subdialog = new SubDialog(
    store,
    rootDialog,
    state.metadata.taskDocPath,
    targetId,
    state.metadata.agentId,
    assignmentFromSup,
    state.metadata.sessionSlug,
    {
      messages: state.messages,
      reminders: state.reminders,
      currentCourse: state.currentCourse,
      contextHealth: state.contextHealth,
    },
  );
  subdialog.disableDiligencePush = latest?.disableDiligencePush ?? false;
  if (subdialog.sessionSlug) {
    rootDialog.registerSubdialog(subdialog);
  }
  return subdialog;
}
