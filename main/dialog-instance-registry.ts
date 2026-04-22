import { DEFAULT_DILIGENCE_PUSH_MAX } from '@longrun-ai/kernel/diligence';
import type { DialogRuntimePrompt } from '@longrun-ai/kernel/types/drive-intent';
import { Dialog, DialogID, MainDialog, SideDialog } from './dialog';
import { globalDialogRegistry } from './dialog-global-registry';
import { DialogPersistence, DiskFileDialogStore } from './persistence';
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

async function resolvePendingCourseStartPromptForRestore(args: {
  dialogId: DialogID;
  status: DialogPersistenceStatus;
  messages: Dialog['msgs'];
  latest: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>;
}): Promise<{
  pendingCourseStartPrompt: DialogRuntimePrompt | undefined;
}> {
  const pending = args.latest?.pendingCourseStartPrompt;
  if (!pending) {
    return { pendingCourseStartPrompt: undefined };
  }
  const alreadyPersisted = args.messages.some((message) => {
    return message.type === 'prompting_msg' && message.msgId === pending.msgId;
  });
  if (alreadyPersisted) {
    if (args.status === 'running') {
      await DialogPersistence.clearPendingCourseStartPrompt(
        args.dialogId,
        pending.msgId,
        args.status,
      );
    }
    return { pendingCourseStartPrompt: undefined };
  }
  return { pendingCourseStartPrompt: pending };
}

export async function getOrRestoreMainDialog(
  rootId: string,
  status: DialogPersistenceStatus,
): Promise<MainDialog | undefined> {
  const existing = globalDialogRegistry.get(rootId);
  if (existing) {
    existing.setPersistenceStatus(status);
    await existing.loadSideDialogRegistry();
    await existing.loadPendingSideDialogsFromPersistence();
    return existing;
  }

  const mainDialogId = new DialogID(rootId);
  const rootState = await DialogPersistence.restoreDialog(mainDialogId, status);
  if (!rootState) return undefined;
  const rootMetadata = rootState.metadata;
  if (rootMetadata.askerDialogId !== undefined) {
    return undefined;
  }

  const latest = await DialogPersistence.loadDialogLatest(mainDialogId, status);
  const { pendingCourseStartPrompt } = await resolvePendingCourseStartPromptForRestore({
    dialogId: mainDialogId,
    status,
    messages: rootState.messages,
    latest,
  });
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

  const rootStore = new DiskFileDialogStore(mainDialogId);
  const mainDialog = new MainDialog(
    rootStore,
    rootMetadata.taskDocPath,
    mainDialogId,
    rootMetadata.agentId,
    {
      messages: rootState.messages,
      reminders: rootState.reminders,
      currentCourse: rootState.currentCourse,
      contextHealth: rootState.contextHealth,
      pendingCourseStartPrompt,
    },
  );
  const persistedDisableDiligencePush =
    latest && typeof latest.disableDiligencePush === 'boolean'
      ? latest.disableDiligencePush
      : defaultDisableDiligencePush;
  mainDialog.disableDiligencePush = persistedDisableDiligencePush;

  const persistedRemainingBudget =
    latest && typeof latest.diligencePushRemainingBudget === 'number'
      ? latest.diligencePushRemainingBudget
      : undefined;
  const normalizedRemainingBudget = clampNonNegativeFiniteInt(
    persistedRemainingBudget,
    diligencePushMax > 0 ? diligencePushMax : 0,
  );
  mainDialog.diligencePushRemainingBudget =
    diligencePushMax > 0
      ? Math.min(normalizedRemainingBudget, diligencePushMax)
      : normalizedRemainingBudget;

  mainDialog.setPersistenceStatus(status);
  globalDialogRegistry.register(mainDialog);

  // Keep the in-memory main dialog fully hydrated regardless of persistence status
  // (running/completed/archived) so sideDialog lookup is stable across UI navigation.
  await mainDialog.loadSideDialogRegistry();
  await mainDialog.loadPendingSideDialogsFromPersistence();
  return mainDialog;
}

export async function ensureDialogLoaded(
  mainDialog: MainDialog,
  targetId: DialogID,
  status: DialogPersistenceStatus,
  visitedSelfIds: Set<string> = new Set(),
): Promise<Dialog | undefined> {
  if (targetId.selfId === targetId.rootId) return mainDialog;

  const existing = mainDialog.lookupDialog(targetId.selfId);
  if (existing) return existing;

  if (visitedSelfIds.has(targetId.selfId)) return undefined;
  visitedSelfIds.add(targetId.selfId);

  const metadata = await DialogPersistence.loadDialogMetadata(targetId, status);
  if (!metadata) return undefined;
  if (!('askerDialogId' in metadata)) {
    throw new Error(
      `ensureDialogLoaded invariant violation: expected sideDialog metadata for ${targetId.valueOf()}`,
    );
  }

  const askerStack = await DialogPersistence.loadSideDialogAskerStackState(targetId, status);
  if (!askerStack) {
    throw new Error(
      `ensureDialogLoaded invariant violation: missing asker stack for ${targetId.valueOf()}`,
    );
  }
  const askerStackTop = askerStack.askerStack[askerStack.askerStack.length - 1];
  if (!askerStackTop) {
    throw new Error(
      `ensureDialogLoaded invariant violation: empty askerDialog stack for ${targetId.valueOf()}`,
    );
  }

  // Ensure asker dialog exists in root registry for dynamic asker/askerDialog resolution.
  if (askerStackTop.askerDialogId !== targetId.rootId) {
    await ensureDialogLoaded(
      mainDialog,
      new DialogID(askerStackTop.askerDialogId, targetId.rootId),
      status,
      visitedSelfIds,
    );
  }

  const state = await DialogPersistence.restoreDialog(targetId, status);
  if (!state) return undefined;

  const latest = await DialogPersistence.loadDialogLatest(targetId, status);
  const { pendingCourseStartPrompt } = await resolvePendingCourseStartPromptForRestore({
    dialogId: targetId,
    status,
    messages: state.messages,
    latest,
  });

  const assignmentFromAsker = (() => {
    for (let index = askerStack.askerStack.length - 1; index >= 0; index -= 1) {
      const frame = askerStack.askerStack[index];
      if (frame?.assignmentFromAsker !== undefined) {
        return frame.assignmentFromAsker;
      }
    }
    throw new Error(
      `ensureDialogLoaded invariant violation: missing assignment frame in asker stack for ${targetId.valueOf()}`,
    );
  })();

  // Ensure the tellasker exists so SideDialog can resolve its effective askerDialog.
  if (
    assignmentFromAsker.askerDialogId &&
    assignmentFromAsker.askerDialogId !== targetId.rootId &&
    assignmentFromAsker.askerDialogId !== targetId.selfId
  ) {
    await ensureDialogLoaded(
      mainDialog,
      new DialogID(assignmentFromAsker.askerDialogId, targetId.rootId),
      status,
      visitedSelfIds,
    );
  }

  const store = new DiskFileDialogStore(targetId);
  const sideDialog = new SideDialog(
    store,
    mainDialog,
    metadata.taskDocPath,
    targetId,
    metadata.agentId,
    askerStack,
    metadata.sessionSlug,
    {
      messages: state.messages,
      reminders: state.reminders,
      currentCourse: state.currentCourse,
      contextHealth: state.contextHealth,
      pendingCourseStartPrompt,
    },
  );
  sideDialog.disableDiligencePush = latest?.disableDiligencePush ?? false;
  if (sideDialog.sessionSlug) {
    mainDialog.registerSideDialog(sideDialog);
  }
  return sideDialog;
}
