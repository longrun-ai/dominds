import { Dialog, DialogID, RootDialog, SubDialog } from './dialog';
import { globalDialogRegistry } from './dialog-global-registry';
import { DialogPersistence, DiskFileDialogStore } from './persistence';

export type DialogPersistenceStatus = 'running' | 'completed' | 'archived';

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

  const latest = await DialogPersistence.loadDialogLatest(rootDialogId, status);

  const rootStore = new DiskFileDialogStore(rootDialogId);
  const rootDialog = new RootDialog(
    rootStore,
    rootState.metadata.taskDocPath,
    rootDialogId,
    rootState.metadata.agentId,
    {
      messages: rootState.messages,
      reminders: rootState.reminders,
      currentRound: rootState.currentRound,
      contextHealth: rootState.contextHealth,
    },
  );
  rootDialog.disableDiligencePush = latest?.disableDiligencePush ?? false;
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
    state.metadata.tellaskSession,
    {
      messages: state.messages,
      reminders: state.reminders,
      currentRound: state.currentRound,
      contextHealth: state.contextHealth,
    },
  );
  subdialog.disableDiligencePush = latest?.disableDiligencePush ?? false;
  if (subdialog.tellaskSession) {
    rootDialog.registerSubdialog(subdialog);
  }
  return subdialog;
}
