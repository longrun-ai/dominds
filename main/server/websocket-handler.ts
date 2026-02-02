/**
 * Module: server/websocket-handler
 *
 * Common WebSocket handling functionality for dialog communication
 */
import type { Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { Dialog, DialogID, RootDialog } from '../dialog';
import { globalDialogRegistry } from '../dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreRootDialog } from '../dialog-instance-registry';
import {
  requestEmergencyStopAll,
  requestInterruptDialog,
  setRunStateBroadcaster,
} from '../dialog-run-state';
import { dialogEventRegistry, postDialogEvent, setQ4HBroadcaster } from '../evt-registry';
import { driveDialogStream } from '../llm/driver';
import { createLogger } from '../log';
import { DialogPersistence, DiskFileDialogStore } from '../persistence';
import { createProblemsSnapshotMessage, setProblemsBroadcaster } from '../problems';
import { DEFAULT_DILIGENCE_PUSH_MAX } from '../shared/diligence';
import { EndOfStream, type SubChan } from '../shared/evt';
import { getWorkLanguage } from '../shared/runtime-language';
import type {
  CreateDialogRequest,
  DialogReadyMessage,
  DiligencePushUpdatedMessage,
  DisplayCourseRequest,
  DisplayDialogRequest,
  DisplayRemindersRequest,
  DriveDialogByUserAnswer,
  DriveDialogRequest,
  EmergencyStopRequest,
  GetProblemsRequest,
  GetQ4HStateRequest,
  InterruptDialogRequest,
  Q4HStateResponse,
  RefillDiligencePushBudgetRequest,
  ResumeAllRequest,
  ResumeDialogRequest,
  SetDiligencePushRequest,
  WebSocketMessage,
} from '../shared/types';
import type { DialogEvent, NewQ4HAskedEvent, Q4HAnsweredEvent } from '../shared/types/dialog';
import {
  normalizeLanguageCode,
  supportedLanguageCodes,
  type LanguageCode,
} from '../shared/types/language';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import { Team } from '../team';
import { generateDialogID } from '../utils/id';
import { isTaskPackagePath } from '../utils/task-package';
import type { AuthConfig } from './auth';
import { getWebSocketAuthCheck } from './auth';

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

const log = createLogger('websocket-handler');

const wsLiveDlg = new WeakMap<WebSocket, Dialog>();
const wsSub = new WeakMap<WebSocket, { dialogKey: string; subChan: SubChan<DialogEvent> }>();
const wsUiLanguage = new WeakMap<WebSocket, LanguageCode>();

let broadcastDialogsIndexMessage: ((msg: WebSocketMessage) => void) | null = null;

function resolveUserLanguageCode(
  ws: WebSocket,
  raw: unknown,
  fallbackDialog?: Dialog,
): LanguageCode {
  if (typeof raw === 'string') {
    const parsed = normalizeLanguageCode(raw);
    if (parsed) return parsed;
  }

  const fromWs = wsUiLanguage.get(ws);
  if (fromWs) return fromWs;

  if (fallbackDialog) return fallbackDialog.getLastUserLanguageCode();
  return getWorkLanguage();
}

/**
 * Get error code from unknown error
 */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === 'string' ? maybeCode : undefined;
}

/**
 * Cleanup WebSocket client: cancel active forwarder and clear live dialog state
 */
function cleanupWsClient(ws: WebSocket): void {
  const existingSub = wsSub.get(ws);
  if (existingSub) {
    try {
      existingSub.subChan.cancel();
    } catch (err) {
      log.warn('Failed to cancel forwarder on cleanupWsClient', err);
    }
    wsSub.delete(ws);
  }
  wsLiveDlg.delete(ws);
  wsUiLanguage.delete(ws);
}

/**
 * Setup WebSocket subscription for real-time dialog events
 * Ensures only one subscription per WebSocket connection
 */
async function setupWebSocketSubscription(ws: WebSocket, dialog: Dialog): Promise<void> {
  // Cancel any existing subscription
  const existingSub = wsSub.get(ws);
  if (existingSub) {
    try {
      existingSub.subChan.cancel();
    } catch (err) {
      log.warn('Failed to cancel existing subscription', undefined, err);
    }
  }

  // Store dialog in wsLiveDlg
  wsLiveDlg.set(ws, dialog);

  // Create new subscription for real-time events
  const subChan = dialogEventRegistry.createSubChan(dialog.id);
  wsSub.set(ws, { dialogKey: dialog.id.valueOf(), subChan });

  // Forward events from SubChan to WebSocket
  (async () => {
    try {
      for await (const event of subChan.stream()) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(event));
        } else {
          break;
        }
      }
    } catch (err: unknown) {
      if (err !== EndOfStream) {
        log.warn(`Event forwarding error for dialog ${dialog.id.selfId}:`, err);
      }
    }
  })().catch((err: unknown) => {
    log.warn(`Event forwarding task failed for dialog ${dialog.id.selfId}:`, err);
  });
}

/**
 * Handle incoming WebSocket messages
 */
export async function handleWebSocketMessage(
  ws: WebSocket,
  packet: WebSocketMessage,
): Promise<void> {
  try {
    switch (packet.type) {
      case 'set_ui_language':
        await handleSetUiLanguage(ws, packet);
        break;

      case 'get_problems':
        await handleGetProblems(ws, packet);
        break;

      case 'create_dialog':
        await handleCreateDialog(ws, packet);
        break;

      case 'display_dialog':
        await handleDisplayDialog(ws, packet);
        break;

      case 'set_diligence_push':
        await handleSetDiligencePush(ws, packet);
        break;

      case 'refill_diligence_push_budget':
        await handleRefillDiligencePushBudget(ws, packet);
        break;

      case 'get_q4h_state':
        await handleGetQ4HState(ws, packet);
        break;

      case 'display_reminders':
        await handleDisplayReminders(ws, packet);
        break;

      case 'display_course':
        await handleDisplayCourse(ws, packet);
        break;

      case 'drive_dlg_by_user_msg':
        await handleUserMsg2Dlg(ws, packet);
        break;

      case 'drive_dialog_by_user_answer':
        await handleUserAnswer2Q4H(ws, packet);
        break;

      case 'interrupt_dialog':
        await handleInterruptDialog(ws, packet);
        break;

      case 'emergency_stop':
        await handleEmergencyStop(ws, packet);
        break;

      case 'resume_dialog':
        await handleResumeDialog(ws, packet);
        break;

      case 'resume_all':
        await handleResumeAll(ws, packet);
        break;

      default:
        log.warn('Unknown WebSocket packet type:', undefined, packet.type);
        ws.send(
          JSON.stringify({
            type: 'error',
            message: `Unknown packet type: ${packet.type}`,
          }),
        );
    }
  } catch (error) {
    log.error('Error processing WebSocket packet:', error);
    ws.send(
      JSON.stringify({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
    );
  }
}

async function handleSetDiligencePush(
  ws: WebSocket,
  packet: SetDiligencePushRequest,
): Promise<void> {
  try {
    const { dialog, disableDiligencePush } = packet as unknown as {
      dialog?: unknown;
      disableDiligencePush?: unknown;
    };
    if (!isRecord(dialog)) {
      ws.send(JSON.stringify({ type: 'error', message: 'dialog is required' }));
      return;
    }
    const selfId = typeof dialog.selfId === 'string' ? dialog.selfId : null;
    const rootId = typeof dialog.rootId === 'string' ? dialog.rootId : null;
    if (!selfId || !rootId) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message:
            'Invalid dialog identifiers for set_diligence_push: selfId/rootId must be strings',
        }),
      );
      return;
    }
    if (typeof disableDiligencePush !== 'boolean') {
      ws.send(JSON.stringify({ type: 'error', message: 'disableDiligencePush must be a boolean' }));
      return;
    }

    // Diligence Push is root-dialog state. Even if a subdialog is displayed, always mutate the root.
    const dialogIdObj = new DialogID(rootId);

    // Locate dialog status (running/completed/archived) for persistence.
    const statuses: Array<'running' | 'completed' | 'archived'> = [
      'running',
      'completed',
      'archived',
    ];
    let foundStatus: 'running' | 'completed' | 'archived' | null = null;
    for (const status of statuses) {
      const meta = await DialogPersistence.loadDialogMetadata(dialogIdObj, status);
      if (!meta) continue;
      foundStatus = status;
      break;
    }
    if (!foundStatus) {
      ws.send(
        JSON.stringify({ type: 'error', message: `Dialog ${dialogIdObj.valueOf()} not found` }),
      );
      return;
    }

    await DialogPersistence.mutateDialogLatest(
      dialogIdObj,
      (previous) => ({
        kind: 'patch',
        patch: { disableDiligencePush },
      }),
      foundStatus,
    );

    // Update live in-memory instance if it's loaded.
    const rootDialog = await getOrRestoreRootDialog(dialogIdObj.rootId, foundStatus);
    if (rootDialog) {
      rootDialog.disableDiligencePush = disableDiligencePush;
    }

    const msg: DiligencePushUpdatedMessage = {
      type: 'diligence_push_updated',
      dialog: { selfId: dialogIdObj.selfId, rootId: dialogIdObj.rootId },
      disableDiligencePush,
      timestamp: formatUnifiedTimestamp(new Date()),
    };
    ws.send(JSON.stringify(msg));
  } catch (error: unknown) {
    log.warn('Failed to handle set_diligence_push', error);
    ws.send(
      JSON.stringify({
        type: 'error',
        message:
          error instanceof Error ? error.message : 'Unknown error updating diligence push setting',
      }),
    );
  }
}

function clampNonNegativeFiniteInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

async function handleRefillDiligencePushBudget(
  ws: WebSocket,
  packet: RefillDiligencePushBudgetRequest,
): Promise<void> {
  const { dialog } = packet as unknown as { dialog?: unknown };
  if (!isRecord(dialog)) {
    ws.send(JSON.stringify({ type: 'error', message: 'dialog is required' }));
    return;
  }

  const rootId = typeof dialog.rootId === 'string' ? dialog.rootId : null;
  if (!rootId) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message:
          'Invalid dialog identifiers for refill_diligence_push_budget: rootId must be a string',
      }),
    );
    return;
  }

  const rootDialogId = new DialogID(rootId);
  const statuses: Array<'running' | 'completed' | 'archived'> = [
    'running',
    'completed',
    'archived',
  ];
  let foundStatus: 'running' | 'completed' | 'archived' | null = null;
  for (const status of statuses) {
    const meta = await DialogPersistence.loadDialogMetadata(rootDialogId, status);
    if (!meta) continue;
    foundStatus = status;
    break;
  }
  if (!foundStatus) {
    ws.send(
      JSON.stringify({ type: 'error', message: `Dialog ${rootDialogId.valueOf()} not found` }),
    );
    return;
  }

  const rootDialog = await getOrRestoreRootDialog(rootDialogId.rootId, foundStatus);
  if (!rootDialog) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: `Root dialog ${rootDialogId.rootId} is not available for refill`,
      }),
    );
    return;
  }

  const team = await Team.load();
  const configuredMax = normalizeDiligencePushMax(
    resolveMemberDiligencePushMax(team, rootDialog.agentId),
  );

  if (configuredMax > 0) {
    rootDialog.diligencePushRemainingBudget = configuredMax;
  } else {
    rootDialog.diligencePushRemainingBudget =
      clampNonNegativeFiniteInt(rootDialog.diligencePushRemainingBudget, 0) + 3;
  }

  postDialogEvent(rootDialog, {
    type: 'diligence_budget_evt',
    maxInjectCount: configuredMax > 0 ? configuredMax : 0,
    injectedCount: 0,
    remainingCount: rootDialog.diligencePushRemainingBudget,
    disableDiligencePush: rootDialog.disableDiligencePush,
  });
}

async function handleGetProblems(ws: WebSocket, packet: WebSocketMessage): Promise<void> {
  if (packet.type !== 'get_problems') {
    throw new Error('Internal error: handleGetProblems called with non get_problems packet');
  }
  const _req: GetProblemsRequest = packet;
  ws.send(JSON.stringify(createProblemsSnapshotMessage()));
}

async function handleSetUiLanguage(ws: WebSocket, packet: WebSocketMessage): Promise<void> {
  if (packet.type !== 'set_ui_language') {
    throw new Error('Internal error: handleSetUiLanguage called with non set_ui_language packet');
  }

  const raw = (packet as { uiLanguage?: unknown }).uiLanguage;
  if (typeof raw !== 'string') {
    ws.send(JSON.stringify({ type: 'error', message: 'uiLanguage must be a string' }));
    return;
  }

  const parsed = normalizeLanguageCode(raw);
  if (!parsed) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: `Unsupported uiLanguage '${raw}'. Supported: ${supportedLanguageCodes.join(', ')}`,
      }),
    );
    return;
  }

  wsUiLanguage.set(ws, parsed);
  ws.send(JSON.stringify({ type: 'ui_language_set', uiLanguage: parsed }));
}

/**
 * Handle dialog creation via WebSocket
 */
async function handleCreateDialog(ws: WebSocket, packet: CreateDialogRequest): Promise<void> {
  try {
    const { agentId, taskDocPath } = packet;

    // Validate that taskDocPath is provided (it's now mandatory)
    if (!taskDocPath || taskDocPath.trim() === '') {
      throw new Error('Task Doc path is required for creating a dialog');
    }
    if (!isTaskPackagePath(taskDocPath)) {
      throw new Error(`Task Doc must be a directory ending in '.tsk' (got: '${taskDocPath}')`);
    }

    // Auto-fill default_responder if no agentId provided
    let finalAgentId = agentId;
    if (!finalAgentId) {
      try {
        const teamConfig = await Team.load();
        const def = teamConfig.getDefaultResponder();
        finalAgentId = def ? def.id : undefined;
      } catch (error) {
        throw new Error(
          `Failed to load team configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }
    if (!finalAgentId) {
      throw new Error('No team members available to create a dialog');
    }

    const generatedId = generateDialogID();
    // For root dialogs, self and root are the same
    const dialogId = new DialogID(generatedId);

    // Import Dialog and DiskFileDialogStore

    // Create DiskFileDialogStore for file-based persistence
    const dialogUI = new DiskFileDialogStore(dialogId);

    // Create RootDialog instance with the new store
    const dialog = new RootDialog(dialogUI, taskDocPath, dialogId, finalAgentId);
    globalDialogRegistry.register(dialog);
    // Setup WebSocket subscription for real-time events
    await setupWebSocketSubscription(ws, dialog);

    // Persist dialog metadata and latest.yaml (write-once pattern)
    const metadata = {
      id: dialogId.selfId,
      agentId: finalAgentId,
      taskDocPath: taskDocPath,
      createdAt: formatUnifiedTimestamp(new Date()),
    };
    await DialogPersistence.saveDialogMetadata(new DialogID(dialogId.selfId), metadata);

    const team = await Team.load();
    const diligencePushMax = normalizeDiligencePushMax(
      resolveMemberDiligencePushMax(team, finalAgentId),
    );
    const defaultDisableDiligencePush = diligencePushMax <= 0;
    dialog.disableDiligencePush = defaultDisableDiligencePush;
    dialog.diligencePushRemainingBudget = diligencePushMax > 0 ? diligencePushMax : 0;

    // Initialize latest.yaml via the mutation API (write-back will flush).
    await DialogPersistence.mutateDialogLatest(new DialogID(dialogId.selfId), () => ({
      kind: 'replace',
      next: {
        currentCourse: 1,
        lastModified: formatUnifiedTimestamp(new Date()),
        status: 'active',
        messageCount: 0,
        functionCallCount: 0,
        subdialogCount: 0,
        runState: { kind: 'idle_waiting_user' },
        disableDiligencePush: defaultDisableDiligencePush,
      },
    }));

    // Send dialog_ready with full info so frontend can track the active dialog
    const response: DialogReadyMessage = {
      type: 'dialog_ready',
      dialog: {
        selfId: dialogId.selfId,
        rootId: dialogId.rootId,
      },
      agentId: finalAgentId,
      taskDocPath: taskDocPath,
      disableDiligencePush: defaultDisableDiligencePush,
      diligencePushMax,
    };
    ws.send(JSON.stringify(response));

    broadcastDialogsIndexMessage?.({
      type: 'dialogs_created',
      scope: { kind: 'root', rootId: dialogId.selfId },
      status: 'running',
      createdRootIds: [dialogId.selfId],
      timestamp: formatUnifiedTimestamp(new Date()),
    });
  } catch (error) {
    log.warn('Failed to create dialog', undefined, error);
    ws.send(
      JSON.stringify({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown error creating dialog',
      }),
    );
  }
}

/**
 * Handle dialog retrieval via WebSocket
 */
async function handleDisplayDialog(ws: WebSocket, packet: DisplayDialogRequest): Promise<void> {
  try {
    const { dialog: dialogIdent } = packet;

    if (!dialogIdent) {
      throw new Error('dialog is required');
    }

    // Extract dialog ID from DialogIdent
    let dialogId = dialogIdent.selfId;
    let rootDialogId = dialogIdent.rootId;

    // Handle case where dialogIdent properties might be objects instead of strings
    if (typeof dialogId !== 'string' || typeof rootDialogId !== 'string') {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'Invalid dialog identifiers for display_dialog: selfId/rootId must be strings',
        }),
      );
      return;
    }

    // IMPORTANT: cancel any existing event forwarder before emitting restoration events.
    // Otherwise, the same client can receive overlapping "replay" and "live" streams,
    // which surfaces as duplicate generation lifecycle events on the frontend.
    const existing = wsLiveDlg.get(ws);
    if (existing) {
      const existingId = existing.id;
      const isSameDialog = existingId.selfId === dialogId && existingId.rootId === rootDialogId;
      if (isSameDialog) {
        log.warn(
          'display_dialog: refreshing the same dialog; cancelling existing subscription to prevent duplicate stream events',
          undefined,
          { dialogId, rootDialogId },
        );
      } else {
        log.debug(
          'display_dialog: switching dialogs; cancelling previous subscription',
          undefined,
          {
            previousDialogId: existingId.valueOf(),
            nextDialogId: new DialogID(dialogId, rootDialogId).valueOf(),
          },
        );
      }
      cleanupWsClient(ws);
    }

    const dialogIdObj = new DialogID(dialogId, rootDialogId);
    const statuses: Array<'running' | 'completed' | 'archived'> = [
      'running',
      'completed',
      'archived',
    ];
    let foundStatus: 'running' | 'completed' | 'archived' | null = null;
    let dialogState: Awaited<ReturnType<typeof DialogPersistence.restoreDialog>> | null = null;
    let metadata: Awaited<ReturnType<typeof DialogPersistence.loadDialogMetadata>> | null = null;
    for (const status of statuses) {
      const state = await DialogPersistence.restoreDialog(dialogIdObj, status);
      if (!state) continue;
      const meta = await DialogPersistence.loadDialogMetadata(dialogIdObj, status);
      if (!meta) continue;
      foundStatus = status;
      dialogState = state;
      metadata = meta;
      break;
    }

    if (!foundStatus || !dialogState || !metadata) {
      throw new Error('Dialog not found');
    }

    const decidedCourse =
      (await DialogPersistence.getCurrentCourseNumber(dialogIdObj, foundStatus)) ||
      (dialogState.currentCourse ?? 1);

    const enableLive = foundStatus === 'running';
    const rootDialog = await getOrRestoreRootDialog(dialogIdObj.rootId, foundStatus);
    if (!rootDialog) {
      throw new Error('Root dialog not found');
    }
    if (enableLive) {
      globalDialogRegistry.register(rootDialog);
    }

    let dialog: Dialog;
    if (dialogIdObj.selfId === dialogIdObj.rootId) {
      dialog = rootDialog;
    } else {
      const loaded = await ensureDialogLoaded(rootDialog, dialogIdObj, foundStatus);
      if (!loaded) {
        throw new Error('Dialog not found');
      }
      dialog = loaded;
    }

    // CRITICAL FIX: Send dialog events directly to requesting WebSocket only
    // This bypasses PubChan to ensure only the requesting session receives restoration events
    // Pass decidedCourse explicitly since dialog.currentCourse defaults to 1 for new Dialog objects
    try {
      const dialogStore = dialog.dlgStore;
      if (dialogStore instanceof DiskFileDialogStore) {
        await dialogStore.sendDialogEventsDirectly(
          ws,
          dialog,
          decidedCourse,
          decidedCourse,
          foundStatus,
        );
      } else {
        throw new Error('Unexpected dialog store type for sendDialogEventsDirectly');
      }
    } catch (err) {
      log.warn(`Failed to send dialog events directly for ${dialogId}:`, err);
    }

    // Always subscribe for future realtime events (including cross-client revival + continued drive).
    // Live generation is still gated by dialog.status ('running') in drive handlers.
    await setupWebSocketSubscription(ws, dialog);

    // Send dialog_ready with full info so frontend knows the current dialog ID
    const team = await Team.load();
    const diligencePushMax = normalizeDiligencePushMax(
      resolveMemberDiligencePushMax(team, metadata.agentId),
    );
    const rootLatest = await DialogPersistence.loadDialogLatest(
      new DialogID(dialogIdObj.rootId),
      foundStatus,
    );
    const defaultDisableDiligencePush = diligencePushMax <= 0;
    const persistedDisableDiligencePush =
      rootLatest && typeof rootLatest.disableDiligencePush === 'boolean'
        ? rootLatest.disableDiligencePush
        : defaultDisableDiligencePush;
    const effectiveDisableDiligencePush = persistedDisableDiligencePush;
    rootDialog.disableDiligencePush = effectiveDisableDiligencePush;
    const dialogReadyResponse: DialogReadyMessage = {
      type: 'dialog_ready',
      dialog: {
        selfId: dialogId,
        rootId: rootDialogId,
      },
      agentId: metadata.agentId,
      taskDocPath: metadata.taskDocPath,
      supdialogId: metadata.supdialogId,
      tellaskSession: metadata.tellaskSession,
      assignmentFromSup: metadata.assignmentFromSup,
      disableDiligencePush: effectiveDisableDiligencePush,
      diligencePushMax,
    };
    ws.send(JSON.stringify(dialogReadyResponse));

    // Send authoritative run state for this dialog so the client can render Send↔Stop and Continue.
    try {
      const latest = await DialogPersistence.loadDialogLatest(dialogIdObj, foundStatus);
      const runState =
        latest?.runState ??
        (foundStatus === 'running'
          ? { kind: 'idle_waiting_user' }
          : foundStatus === 'completed'
            ? { kind: 'terminal', status: 'completed' }
            : { kind: 'terminal', status: 'archived' });
      const runStateEvt = dialogEventRegistry.createTypedEvent(dialogIdObj, {
        type: 'dlg_run_state_evt',
        runState,
      });
      ws.send(JSON.stringify(runStateEvt));
    } catch (err) {
      log.warn(`Failed to send dlg_run_state_evt for ${dialogIdObj.valueOf()}:`, err);
    }

    // Emit Q4H state to ensure frontend has current questions count
    // Load Q4H from ALL running dialogs for global display (not just this dialog)
    try {
      const allQuestions = await DialogPersistence.loadAllQ4HState();

      // Emit new_q4h_asked events for each question (best-effort sync on dialog display).
      // Include full dialog context (selfId/rootId/agentId/taskDocPath) so the frontend can
      // render origin info without relying on additional lookups.
      for (const q of allQuestions) {
        const newQ4HEvent: NewQ4HAskedEvent = {
          type: 'new_q4h_asked',
          question: {
            id: q.id,
            selfId: q.selfId,
            rootId: q.rootId,
            agentId: q.agentId,
            taskDocPath: q.taskDocPath,
            headLine: q.headLine,
            bodyContent: q.bodyContent,
            askedAt: q.askedAt,
            callSiteRef: q.callSiteRef,
          },
        };
        ws.send(JSON.stringify(newQ4HEvent));
      }
    } catch (err) {
      log.warn(`Failed to emit Q4H state for ${dialogIdObj}:`, err);
    }

    // Proactively emit reminders for the newly active dialog
    // todo: maybe emit only to the requestiong websocket, not publish via PubChan as curr impl
    try {
      await dialog.processReminderUpdates();
    } catch (err) {
      log.warn(`Failed to emit proactive reminders for ${dialogIdObj}:`, err);
    }
  } catch (error) {
    log.warn('Failed to handle display_dialog', error);
  }
}

/**
 * Handle Q4H state request via WebSocket
 * Fetches Q4H questions from ALL running dialogs for global display
 */
async function handleGetQ4HState(ws: WebSocket, _packet: GetQ4HStateRequest): Promise<void> {
  try {
    // Load Q4H from all running dialogs
    const allQuestions = await DialogPersistence.loadAllQ4HState();

    // Transform to wire `Q4HStateResponse` question entries.
    // `selfId` + `rootId` uniquely identify the originating dialog (including subdialogs).
    const questions = allQuestions.map((q) => ({
      id: q.id,
      selfId: q.selfId,
      rootId: q.rootId,
      agentId: q.agentId,
      taskDocPath: q.taskDocPath,
      headLine: q.headLine,
      bodyContent: q.bodyContent,
      askedAt: q.askedAt,
      callSiteRef: q.callSiteRef,
    }));

    // Send single response packet with all questions (not PubChan events)
    const response: Q4HStateResponse = {
      type: 'q4h_state_response',
      questions,
    };
    ws.send(JSON.stringify(response));
  } catch (error) {
    log.warn('Failed to handle get_q4h_state', error);
    ws.send(
      JSON.stringify({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown error getting Q4H state',
      }),
    );
  }
}

async function handleDisplayReminders(
  ws: WebSocket,
  packet: DisplayRemindersRequest,
): Promise<void> {
  try {
    const live = wsLiveDlg.get(ws);
    if (!live) {
      log.warn('No live dialog found for display_reminders');

      return;
    }

    if (live.id.selfId !== packet.dialog.selfId) {
      log.warn(
        `Dialog ${packet.dialog} for reminders is not current live (live dialog is ${live.id})`,
      );

      return;
    }

    await live.processReminderUpdates();
  } catch (error: unknown) {
    log.warn('Failed to display reminders', error);
  }
}

async function handleDisplayCourse(ws: WebSocket, packet: DisplayCourseRequest): Promise<void> {
  try {
    const { dialog, course } = packet;
    if (!dialog || typeof course !== 'number') {
      throw new Error('dialog and course are required');
    }

    // Extract dialog ID from DialogIdent
    let dialogIdStr = dialog.selfId;
    let rootDialogIdStr = dialog.rootId;

    // Handle case where dialog properties might be objects instead of strings
    if (typeof dialogIdStr !== 'string' || typeof rootDialogIdStr !== 'string') {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'Invalid dialog identifiers for display_course: selfId/rootId must be strings',
        }),
      );
      return;
    }

    const dialogId = new DialogID(dialogIdStr, rootDialogIdStr);

    try {
      const statuses: Array<'running' | 'completed' | 'archived'> = [
        'running',
        'completed',
        'archived',
      ];
      let foundStatus: 'running' | 'completed' | 'archived' | null = null;
      let metadata: Awaited<ReturnType<typeof DialogPersistence.loadDialogMetadata>> | null = null;
      for (const status of statuses) {
        const meta = await DialogPersistence.loadDialogMetadata(dialogId, status);
        if (!meta) continue;
        foundStatus = status;
        metadata = meta;
        break;
      }

      if (!foundStatus || !metadata) {
        log.warn('Metadata not found for display_course', undefined, { dialogId: dialogId.selfId });
        return;
      }

      const totalCourses =
        (await DialogPersistence.getCurrentCourseNumber(dialogId, foundStatus)) || course;

      const rootDialog = await getOrRestoreRootDialog(dialogId.rootId, foundStatus);
      if (!rootDialog) return;

      const dialog =
        dialogId.selfId === dialogId.rootId
          ? rootDialog
          : await ensureDialogLoaded(rootDialog, dialogId, foundStatus);
      if (!dialog) return;

      const store = dialog.dlgStore;
      if (!(store instanceof DiskFileDialogStore)) {
        throw new Error('Unexpected dialog store type for display_course');
      }
      // Send the requested course's persisted events directly to this WebSocket.
      // This is a UI navigation operation; do not emit via PubChan.
      await store.sendDialogEventsDirectly(ws, dialog, course, totalCourses, foundStatus);
    } catch (err) {
      log.warn('Failed to send dialog events for display_course', err);
    }
  } catch (error) {
    log.warn('Failed to handle display_course', error);
  }
}

/**
 * Handle message sending via WebSocket
 */
async function handleUserMsg2Dlg(ws: WebSocket, packet: DriveDialogRequest): Promise<void> {
  try {
    const { dialog: dialogIdent, content, msgId } = packet;
    const userLanguageCode = resolveUserLanguageCode(
      ws,
      (packet as unknown as { userLanguageCode?: unknown }).userLanguageCode,
    );

    // Basic validation
    if (!dialogIdent || !content || !msgId) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'dialog, content, and msgId are required',
        }),
      );
      return;
    }

    // Extract dialog ID from DialogIdent
    const dialogId = dialogIdent.selfId;
    const rootDialogId = dialogIdent.rootId;

    // Validate dialog identifiers
    if (typeof dialogId !== 'string' || typeof rootDialogId !== 'string') {
      ws.send(
        JSON.stringify({
          type: 'error',
          message:
            'Invalid dialog identifiers for drive_dlg_by_user_msg: selfId/rootId must be strings',
        }),
      );
      return;
    }

    // If the dialog is already active for this WebSocket, runnable (status === 'running'),
    // and has an event forwarder (subChan),
    // drive it directly to preserve in-memory state (pending subdialogs, teammate tellask tracking, etc).
    //
    // IMPORTANT: do not drive a view-only dialog instance here. When users browse a completed/archived
    // dialog, handleDisplayDialog restores it with dialog.status set to completed/archived. If that
    // dialog is later revived to running by another client, the UI may re-enable input without
    // re-issuing display_dialog. In that case, we must restore from running rather than driving the
    // cached view-only dialog (stale state, wrong hydration, etc).
    const existingDialog = wsLiveDlg.get(ws);
    const existingSub = wsSub.get(ws);
    if (
      existingDialog &&
      existingDialog.id.selfId === dialogId &&
      existingDialog.id.rootId === rootDialogId &&
      existingDialog.status === 'running' &&
      existingSub &&
      existingSub.dialogKey === existingDialog.id.valueOf()
    ) {
      await driveDialogStream(
        existingDialog,
        { content, msgId, grammar: 'tellask', userLanguageCode },
        true,
      );
      return;
    }

    // Dialog not found in wsLiveDlg - drive using the canonical root/subdialog instances.
    // This supports driving subdialogs and cross-client revival without creating duplicate dialog objects.
    try {
      const dialogIdObj = new DialogID(dialogId, rootDialogId);
      const rootDialog = await getOrRestoreRootDialog(dialogIdObj.rootId, 'running');
      if (!rootDialog) {
        ws.send(JSON.stringify({ type: 'error', message: `Dialog ${dialogId} not found` }));
        return;
      }
      globalDialogRegistry.register(rootDialog);

      const dialog =
        dialogIdObj.selfId === dialogIdObj.rootId
          ? rootDialog
          : await ensureDialogLoaded(rootDialog, dialogIdObj, 'running');
      if (!dialog) {
        ws.send(JSON.stringify({ type: 'error', message: `Dialog ${dialogId} not found` }));
        return;
      }

      await setupWebSocketSubscription(ws, dialog);
      await driveDialogStream(
        dialog,
        { content, msgId, grammar: 'tellask', userLanguageCode },
        true,
      );
      return;
    } catch (restoreError) {
      log.warn('Failed to restore dialog for message:', restoreError);
      ws.send(
        JSON.stringify({
          type: 'error',
          message: `Cannot send message to dialog ${dialogId}: dialog is not the currently active dialog and could not be restored`,
        }),
      );
      return;
    }
  } catch (error) {
    // Log the error at warning level in the backend console
    log.warn(
      `Failed to drive dialog ${packet?.dialog?.selfId} with user message: ${error instanceof Error ? error.message : 'Unknown error'}`,
      error,
    );

    // Send error response to client
    ws.send(
      JSON.stringify({
        type: 'error',
        message: `Failed to process message: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }),
    );
  }
}

async function restoreDialogForDrive(dialogIdObj: DialogID, status: 'running'): Promise<Dialog> {
  const rootDialog = await getOrRestoreRootDialog(dialogIdObj.rootId, status);
  if (!rootDialog) {
    throw new Error(`Dialog ${dialogIdObj.valueOf()} not found`);
  }
  globalDialogRegistry.register(rootDialog);

  if (dialogIdObj.selfId === dialogIdObj.rootId) {
    return rootDialog;
  }

  const sub = await ensureDialogLoaded(rootDialog, dialogIdObj, status);
  if (!sub) {
    throw new Error(`Dialog ${dialogIdObj.valueOf()} not found`);
  }
  return sub;
}

async function handleInterruptDialog(ws: WebSocket, packet: InterruptDialogRequest): Promise<void> {
  if (packet.type !== 'interrupt_dialog') {
    throw new Error(
      'Internal error: handleInterruptDialog called with non interrupt_dialog packet',
    );
  }
  const dialog = packet.dialog;
  if (!dialog || typeof dialog.selfId !== 'string' || typeof dialog.rootId !== 'string') {
    ws.send(
      JSON.stringify({ type: 'error', message: 'interrupt_dialog requires dialog.selfId/rootId' }),
    );
    return;
  }
  const dialogIdObj = new DialogID(dialog.selfId, dialog.rootId);
  const res = await requestInterruptDialog(dialogIdObj, 'user_stop');
  if (!res.applied) {
    // Stop should be idempotent: a double-click (or concurrent stop) must not surface as an error.
    // If the dialog is already not proceeding, treat as a no-op.
    return;
  }
}

async function handleEmergencyStop(ws: WebSocket, packet: EmergencyStopRequest): Promise<void> {
  if (packet.type !== 'emergency_stop') {
    throw new Error('Internal error: handleEmergencyStop called with non emergency_stop packet');
  }
  await requestEmergencyStopAll();
}

async function handleResumeDialog(ws: WebSocket, packet: ResumeDialogRequest): Promise<void> {
  if (packet.type !== 'resume_dialog') {
    throw new Error('Internal error: handleResumeDialog called with non resume_dialog packet');
  }
  const dialog = packet.dialog;
  if (!dialog || typeof dialog.selfId !== 'string' || typeof dialog.rootId !== 'string') {
    ws.send(
      JSON.stringify({ type: 'error', message: 'resume_dialog requires dialog.selfId/rootId' }),
    );
    return;
  }
  const dialogIdObj = new DialogID(dialog.selfId, dialog.rootId);
  const latest = await DialogPersistence.loadDialogLatest(dialogIdObj, 'running');
  const runState = latest?.runState;

  if (!runState || runState.kind !== 'interrupted') {
    ws.send(JSON.stringify({ type: 'error', message: 'Dialog is not eligible for resumption.' }));
    return;
  }

  const restored = await restoreDialogForDrive(dialogIdObj, 'running');
  await driveDialogStream(restored, undefined, true);
}

async function handleResumeAll(ws: WebSocket, packet: ResumeAllRequest): Promise<void> {
  if (packet.type !== 'resume_all') {
    throw new Error('Internal error: handleResumeAll called with non resume_all packet');
  }
  const dialogIds = await DialogPersistence.listAllDialogIds('running');
  for (const id of dialogIds) {
    const latest = await DialogPersistence.loadDialogLatest(id, 'running');
    const runState = latest?.runState;
    if (!runState || runState.kind !== 'interrupted') continue;
    void (async () => {
      try {
        const dlg = await restoreDialogForDrive(id, 'running');
        await driveDialogStream(dlg, undefined, true);
      } catch (err) {
        log.warn('resume_all: failed to resume dialog', err, { dialogId: id.valueOf() });
      }
    })();
  }
}

/**
 * Handle user answer to a Q4H (Questions for Human) question
 * Validates questionId, clears q4h.yaml entry, and resumes dialog with user's answer
 */
async function handleUserAnswer2Q4H(ws: WebSocket, packet: DriveDialogByUserAnswer): Promise<void> {
  try {
    const { dialog: dialogIdent, content, msgId, questionId } = packet;
    const userLanguageCode = resolveUserLanguageCode(
      ws,
      (packet as unknown as { userLanguageCode?: unknown }).userLanguageCode,
    );

    // Basic validation
    if (!dialogIdent || !content || !msgId || !questionId) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'dialog, content, msgId, and questionId are required',
        }),
      );
      return;
    }

    // Extract dialog ID from DialogIdent
    const dialogId = dialogIdent.selfId;
    const rootDialogId = dialogIdent.rootId;

    // Validate dialog identifiers
    if (typeof dialogId !== 'string' || typeof rootDialogId !== 'string') {
      ws.send(
        JSON.stringify({
          type: 'error',
          message:
            'Invalid dialog identifiers for drive_dialog_by_user_answer: selfId/rootId must be strings',
        }),
      );
      return;
    }

    const dialogIdObj = new DialogID(dialogId, rootDialogId);

    // Load current questions from q4h.yaml
    const questions = await DialogPersistence.loadQuestions4HumanState(dialogIdObj);

    // Validate questionId exists
    const questionIndex = questions.findIndex((q) => q.id === questionId);
    if (questionIndex === -1) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: `Question ${questionId} not found in dialog ${dialogId}`,
        }),
      );
      return;
    }

    // Remove answered question from the list
    questions.splice(questionIndex, 1);

    // Save updated questions to q4h.yaml
    if (questions.length > 0) {
      await DialogPersistence._saveQuestions4HumanState(dialogIdObj, questions);
    } else {
      // No more questions - remove the q4h.yaml file
      await DialogPersistence.clearQuestions4HumanState(dialogIdObj);
    }

    // Restore the canonical dialog instances (root + subdialogs) to avoid duplicates.
    const rootDialog = await getOrRestoreRootDialog(dialogIdObj.rootId, 'running');
    if (!rootDialog) {
      ws.send(JSON.stringify({ type: 'error', message: `Dialog ${dialogId} not found` }));
      return;
    }
    globalDialogRegistry.register(rootDialog);

    const dialog =
      dialogIdObj.selfId === dialogIdObj.rootId
        ? rootDialog
        : await ensureDialogLoaded(rootDialog, dialogIdObj, 'running');
    if (!dialog) {
      ws.send(JSON.stringify({ type: 'error', message: `Dialog ${dialogId} not found` }));
      return;
    }

    // Ensure the requesting WebSocket receives q4h_answered and subsequent resume stream events.
    await setupWebSocketSubscription(ws, dialog);

    // Emit q4h_answered event for answered question
    const answeredEvent: Q4HAnsweredEvent = {
      type: 'q4h_answered',
      questionId,
      selfId: dialogId,
    };
    postDialogEvent(dialog, answeredEvent);

    // Resume the dialog with the user's answer.
    await driveDialogStream(dialog, { content, msgId, grammar: 'tellask', userLanguageCode }, true);
  } catch (error) {
    log.error('Error processing Q4H user answer:', error);
    ws.send(
      JSON.stringify({
        type: 'error',
        message: `Failed to process Q4H answer: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }),
    );
  }
}

/**
 * Setup WebSocket server with dialog handling
 */
export function setupWebSocketServer(
  httpServer: Server,
  clients: Set<WebSocket>,
  auth: AuthConfig,
  serverWorkLanguage: LanguageCode,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });

  // Broadcast dialog run-state changes to all connected clients so multi-tab views converge.
  setRunStateBroadcaster((msg: WebSocketMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  });

  // Broadcast Q4H events globally: Q4H is workspace-global state in the WebUI.
  // Without this, a client can miss Q4H updates when it's not subscribed to the originating dialog stream.
  setQ4HBroadcaster((evt) => {
    const data = JSON.stringify(evt);
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  });

  // Broadcast dialog index changes (create/move/delete) so other tabs refresh their lists.
  // This ensures multi-tab/multi-browser updates stay consistent without polling.
  broadcastDialogsIndexMessage = (msg: WebSocketMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  };

  // Broadcast workspace Problems snapshots to all connected clients.
  setProblemsBroadcaster((msg: WebSocketMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  });

  wss.on('connection', (ws: WebSocket, req) => {
    const authCheck = getWebSocketAuthCheck(req, auth);
    if (authCheck.kind !== 'ok') {
      ws.close(4401, 'unauthorized');
      return;
    }

    clients.add(ws);
    wsUiLanguage.set(ws, serverWorkLanguage);

    // Send welcome message
    ws.send(
      JSON.stringify({
        type: 'welcome',
        message: 'Connected to dialog server',
        serverWorkLanguage,
        supportedLanguageCodes: [...supportedLanguageCodes],
        timestamp: formatUnifiedTimestamp(new Date()),
      }),
    );

    // Send an initial snapshot so the UI can render a stable Problems indicator immediately.
    ws.send(JSON.stringify(createProblemsSnapshotMessage()));

    ws.on('message', async (data: Buffer) => {
      try {
        const packet: unknown = JSON.parse(data.toString());
        if (!isRecord(packet) || typeof packet.type !== 'string') {
          throw new Error('Invalid packet format');
        }
        await handleWebSocketMessage(ws, packet as unknown as WebSocketMessage);
      } catch (error) {
        log.error('Error handling WebSocket packet:', error);
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Invalid packet format',
          }),
        );
      }
    });

    ws.on('close', () => {
      clients.delete(ws);

      // Clean up client subscriptions
      cleanupWsClient(ws);
    });

    ws.on('error', (error) => {
      log.error('WebSocket error:', error);
      clients.delete(ws);

      // Clean up client subscriptions on error
      cleanupWsClient(ws);
    });
  });

  return wss;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Clean up all event channels and subscriptions
 */
export function cleanupEventSystems(): void {
  // Clear all WebSocket subscriptions (WeakMap will be garbage collected)
  // Just trigger cleanup of the event channel registry
  dialogEventRegistry.cleanup();
}

// Register cleanup on process exit
process.on('SIGINT', () => {
  cleanupEventSystems();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanupEventSystems();
  process.exit(0);
});
