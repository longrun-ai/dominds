/**
 * Module: server/websocket-handler
 *
 * Common WebSocket handling functionality for dialog communication
 */
import type { Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { shutdownAppsRuntime } from '../apps/runtime';
import { Dialog, DialogID, RootDialog } from '../dialog';
import { globalDialogRegistry } from '../dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreRootDialog } from '../dialog-instance-registry';
import {
  getRunControlCountsSnapshot,
  requestEmergencyStopAll,
  requestInterruptDialog,
  setDialogRunState,
  setRunStateBroadcaster,
} from '../dialog-run-state';
import {
  dialogEventRegistry,
  postDialogEvent,
  setGlobalDialogEventBroadcaster,
} from '../evt-registry';
import { driveDialogStream, supplyResponseToSupdialog } from '../llm/kernel-driver';
import { maybePrepareDiligenceAutoContinuePrompt } from '../llm/kernel-driver/runtime';
import { createLogger } from '../log';
import { DialogPersistence, DiskFileDialogStore } from '../persistence';
import {
  applyPrimingScriptsToDialog,
  buildRootDialogPrimingMetadata,
  getRootDialogPrimingConfig,
} from '../priming';
import { createProblemsSnapshotMessage, setProblemsBroadcaster } from '../problems';
import { DEFAULT_DILIGENCE_PUSH_MAX } from '../shared/diligence';
import { EndOfStream, type SubChan } from '../shared/evt';
import { getWorkLanguage } from '../shared/runtime-language';
import type {
  CreateDialogErrorCode,
  CreateDialogRequest,
  CreateDialogResult,
  DeclareSubdialogDeadRequest,
  DialogReadyMessage,
  DialogStatusKind,
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
  RunControlRefreshMessage,
  SetDiligencePushRequest,
  WebSocketMessage,
} from '../shared/types';
import type { DialogEvent, Q4HAnsweredEvent, TypedDialogEvent } from '../shared/types/dialog';
import {
  normalizeLanguageCode,
  supportedLanguageCodes,
  type LanguageCode,
} from '../shared/types/language';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import { Team } from '../team';
import { setTeamConfigBroadcaster, startTeamConfigWatcher } from '../team-config-updates';
import { syncPendingTellaskReminderState } from '../tools/pending-tellask-reminder';
import { generateDialogID } from '../utils/id';
import type { AuthConfig } from './auth';
import { getWebSocketAuthCheck } from './auth';
import {
  makeCreateDialogFailure,
  normalizeCreateDialogErrorCode,
  parseCreateDialogInput,
} from './create-dialog-contract';

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

function parseDialogStatusKind(raw: unknown): DialogStatusKind | null {
  if (raw !== 'running' && raw !== 'completed' && raw !== 'archived') {
    return null;
  }
  return raw;
}

const log = createLogger('websocket-handler');

const wsLiveDlg = new WeakMap<WebSocket, Dialog>();
const wsSub = new WeakMap<WebSocket, { dialogKey: string; subChan: SubChan<DialogEvent> }>();
const wsUiLanguage = new WeakMap<WebSocket, LanguageCode>();

let broadcastDialogsIndexMessage: ((msg: WebSocketMessage) => void) | null = null;
let broadcastRunControlRefreshMessage: ((msg: RunControlRefreshMessage) => void) | null = null;

function emitRunControlRefresh(reason: RunControlRefreshMessage['reason']): void {
  broadcastRunControlRefreshMessage?.({
    type: 'run_control_refresh',
    reason,
    timestamp: formatUnifiedTimestamp(new Date()),
  });
}

async function syncPendingTellaskReminderBestEffort(dialog: Dialog, where: string): Promise<void> {
  try {
    await syncPendingTellaskReminderState(dialog);
  } catch (err) {
    log.warn(`Failed to sync pending tellask reminder at ${where}`, err, {
      dialogId: dialog.id.selfId,
      rootId: dialog.id.rootId,
    });
  }
}

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

function sendCreateDialogFailure(
  ws: WebSocket,
  requestId: string,
  errorCode: CreateDialogErrorCode,
  error: string,
): void {
  const payload: CreateDialogResult = makeCreateDialogFailure(requestId, errorCode, error);
  ws.send(JSON.stringify(payload));
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

      case 'declare_subdialog_dead':
        await handleDeclareSubdialogDead(ws, packet);
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

async function handleDeclareSubdialogDead(
  ws: WebSocket,
  packet: DeclareSubdialogDeadRequest,
): Promise<void> {
  const dialog = packet.dialog;
  const noteRaw = typeof packet.note === 'string' ? packet.note : '';
  const note = noteRaw.trim();
  if (!dialog || typeof dialog.selfId !== 'string' || typeof dialog.rootId !== 'string') {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'declare_subdialog_dead requires dialog.selfId/rootId',
      }),
    );
    return;
  }

  if (dialog.selfId === dialog.rootId) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'declare_subdialog_dead is allowed only for subdialogs (selfId must differ)',
      }),
    );
    return;
  }

  const dialogIdObj = new DialogID(dialog.selfId, dialog.rootId);
  const requestedStatus = parseDialogStatusKind(dialog.status) ?? 'running';
  if (requestedStatus !== 'running') {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'declare_subdialog_dead is available only for running dialogs',
      }),
    );
    return;
  }
  const latest = await DialogPersistence.loadDialogLatest(dialogIdObj, requestedStatus);
  if (!latest) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: `Dialog not found: ${dialogIdObj.valueOf()}`,
      }),
    );
    return;
  }

  if (latest.runState && latest.runState.kind === 'dead') {
    // Idempotent
    return;
  }

  // Best-effort abort if the dialog is currently proceeding.
  await requestInterruptDialog(dialogIdObj, 'emergency_stop');

  await setDialogRunState(dialogIdObj, { kind: 'dead', reason: { kind: 'declared_by_user' } });

  // If a supdialog is waiting on this subdialog (pending-subdialogs.json), supply a system-style
  // response so the supdialog can unblock and the model sees the failure reason.
  const metadata = await DialogPersistence.loadDialogMetadata(dialogIdObj, requestedStatus);
  if (!metadata) return;

  if (typeof metadata.sessionSlug === 'string' && metadata.sessionSlug.trim() !== '') {
    const rootRestored = await restoreDialogForDrive(new DialogID(dialogIdObj.rootId), 'running');
    if (!(rootRestored instanceof RootDialog)) {
      throw new Error(`Expected root dialog instance for ${dialogIdObj.rootId}`);
    }
    const removed = rootRestored.unregisterSubdialog(metadata.agentId, metadata.sessionSlug);
    if (removed) {
      await rootRestored.saveSubdialogRegistry();
    }
  }

  if (!('assignmentFromSup' in metadata)) return;
  if (!metadata.assignmentFromSup) return;

  const callerDialogId = metadata.assignmentFromSup.callerDialogId;
  if (typeof callerDialogId !== 'string' || callerDialogId.trim() === '') return;

  const callerDialogIdObj = new DialogID(callerDialogId, dialogIdObj.rootId);
  const pending = await DialogPersistence.loadPendingSubdialogs(callerDialogIdObj, requestedStatus);
  const pendingRecord = pending.find((p) => p.subdialogId === dialogIdObj.selfId);
  if (!pendingRecord) {
    // Caller is not waiting on this subdialog anymore; do not auto-revive.
    return;
  }

  const parentDialog = await restoreDialogForDrive(callerDialogIdObj, 'running');

  const responseText =
    getWorkLanguage() === 'zh'
      ? `系统反馈：支线对话 ${dialogIdObj.valueOf()} 已被用户宣布卡死（不可逆）。后续可以重用相同的 slug 发起全新支线对话；只是之前的上下文已不再，诉请正文请提供最新的完整上下文信息。`
      : `System notice: sideline dialog ${dialogIdObj.valueOf()} has been declared dead by the user (irreversible). You may reuse the same slug to start a brand-new sideline dialog, but previous context is no longer retained; include the latest complete context in the tellask body.`;
  const responseTextWithNote =
    note === ''
      ? responseText
      : getWorkLanguage() === 'zh'
        ? `${responseText}\n\n使用者补充（来自输入框）：\n${note}`
        : `${responseText}\n\nUser note (from the input box):\n${note}`;

  await supplyResponseToSupdialog(
    parentDialog,
    dialogIdObj,
    responseTextWithNote,
    pendingRecord.callType,
    metadata.assignmentFromSup.callId,
    'failed',
  );
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
    const requestedStatus = parseDialogStatusKind(dialog.status) ?? 'running';
    const rootMeta = await DialogPersistence.loadDialogMetadata(dialogIdObj, requestedStatus);
    if (!rootMeta) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: `Dialog ${dialogIdObj.valueOf()} not found in ${requestedStatus}; dialog context is stale`,
        }),
      );
      return;
    }

    const latestBefore = await DialogPersistence.loadDialogLatest(dialogIdObj, requestedStatus);
    const prevDisableDiligencePush =
      latestBefore && typeof latestBefore.disableDiligencePush === 'boolean'
        ? latestBefore.disableDiligencePush
        : false;

    await DialogPersistence.mutateDialogLatest(
      dialogIdObj,
      (previous) => ({
        kind: 'patch',
        patch: { disableDiligencePush },
      }),
      requestedStatus,
    );

    // Update live in-memory instance if it's loaded.
    const rootDialog = await getOrRestoreRootDialog(dialogIdObj.rootId, requestedStatus);
    if (rootDialog) {
      rootDialog.disableDiligencePush = disableDiligencePush;
    }

    const msg: DiligencePushUpdatedMessage = {
      type: 'diligence_push_updated',
      dialog: { selfId: dialogIdObj.selfId, rootId: dialogIdObj.rootId, status: requestedStatus },
      disableDiligencePush,
      timestamp: formatUnifiedTimestamp(new Date()),
    };
    ws.send(JSON.stringify(msg));

    const shouldTriggerImmediateDiligence =
      requestedStatus === 'running' &&
      prevDisableDiligencePush &&
      !disableDiligencePush &&
      rootDialog instanceof RootDialog;
    if (shouldTriggerImmediateDiligence) {
      void maybeTriggerImmediateDiligencePrompt(rootDialog);
    }
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

async function maybeTriggerImmediateDiligencePrompt(rootDialog: RootDialog): Promise<void> {
  try {
    if (rootDialog.disableDiligencePush) {
      return;
    }

    const latest = await DialogPersistence.loadDialogLatest(rootDialog.id, 'running');
    const runState = latest?.runState;
    if (runState && runState.kind !== 'idle_waiting_user') {
      return;
    }

    const suspension = await rootDialog.getSuspensionStatus();
    if (!suspension.canDrive) {
      return;
    }

    const team = await Team.load();
    const prepared = await maybePrepareDiligenceAutoContinuePrompt({
      dlg: rootDialog,
      isRootDialog: true,
      remainingBudget: rootDialog.diligencePushRemainingBudget,
      diligencePushMax: resolveMemberDiligencePushMax(team, rootDialog.agentId),
    });

    rootDialog.diligencePushRemainingBudget = prepared.nextRemainingBudget;
    await DialogPersistence.mutateDialogLatest(rootDialog.id, () => ({
      kind: 'patch',
      patch: { diligencePushRemainingBudget: rootDialog.diligencePushRemainingBudget },
    }));

    if (prepared.kind !== 'disabled') {
      postDialogEvent(rootDialog, {
        type: 'diligence_budget_evt',
        maxInjectCount: prepared.maxInjectCount,
        injectedCount: Math.max(0, prepared.maxInjectCount - prepared.nextRemainingBudget),
        remainingCount: Math.max(0, prepared.nextRemainingBudget),
        disableDiligencePush: rootDialog.disableDiligencePush,
      });
    }

    if (prepared.kind === 'prompt') {
      await driveDialogStream(rootDialog, prepared.prompt, true);
    }
  } catch (error) {
    log.warn('Failed to trigger immediate diligence prompt after enabling keep-going', error, {
      dialogId: rootDialog.id.valueOf(),
    });
  }
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
  const requestedStatus = parseDialogStatusKind(dialog.status) ?? 'running';
  const rootMeta = await DialogPersistence.loadDialogMetadata(rootDialogId, requestedStatus);
  if (!rootMeta) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: `Dialog ${rootDialogId.valueOf()} not found in ${requestedStatus}; dialog context is stale`,
      }),
    );
    return;
  }

  const rootDialog = await getOrRestoreRootDialog(rootDialogId.rootId, requestedStatus);
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
  await DialogPersistence.mutateDialogLatest(
    rootDialogId,
    () => ({
      kind: 'patch',
      patch: { diligencePushRemainingBudget: rootDialog.diligencePushRemainingBudget },
    }),
    requestedStatus,
  );

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
  const parsed = parseCreateDialogInput(packet as unknown as Record<string, unknown>);
  if ('status' in parsed) {
    sendCreateDialogFailure(ws, parsed.requestId, parsed.errorCode, parsed.error);
    return;
  }

  try {
    const { requestId, agentId, taskDocPath, priming } = parsed;

    const generatedId = generateDialogID();
    // For root dialogs, self and root are the same
    const dialogId = new DialogID(generatedId);

    // Import Dialog and DiskFileDialogStore

    // Create DiskFileDialogStore for file-based persistence
    const dialogUI = new DiskFileDialogStore(dialogId);

    // Create RootDialog instance with the new store
    const dialog = new RootDialog(dialogUI, taskDocPath, dialogId, agentId);
    globalDialogRegistry.register(dialog);
    // Setup WebSocket subscription for real-time events
    await setupWebSocketSubscription(ws, dialog);

    // Persist dialog metadata and latest.yaml (write-once pattern)
    const metadata = {
      id: dialogId.selfId,
      agentId,
      taskDocPath: taskDocPath,
      createdAt: formatUnifiedTimestamp(new Date()),
      priming: buildRootDialogPrimingMetadata(priming),
    };
    await DialogPersistence.saveDialogMetadata(new DialogID(dialogId.selfId), metadata);

    const team = await Team.load();
    const diligencePushMax = normalizeDiligencePushMax(
      resolveMemberDiligencePushMax(team, agentId),
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
        diligencePushRemainingBudget: dialog.diligencePushRemainingBudget,
      },
    }));

    if (priming && priming.scriptRefs.length > 0) {
      await applyPrimingScriptsToDialog({
        dialog,
        agentId,
        status: 'running',
        priming,
      });
    }

    // Send dialog_ready with full info so frontend can track the active dialog
    const response: DialogReadyMessage = {
      type: 'dialog_ready',
      dialog: {
        selfId: dialogId.selfId,
        rootId: dialogId.rootId,
      },
      agentId,
      taskDocPath: taskDocPath,
      disableDiligencePush: defaultDisableDiligencePush,
      diligencePushMax,
      diligencePushRemainingBudget: dialog.diligencePushRemainingBudget,
    };
    const createResult: CreateDialogResult = {
      kind: 'success',
      requestId,
      selfId: dialogId.selfId,
      rootId: dialogId.rootId,
      agentId,
      taskDocPath,
    };
    ws.send(JSON.stringify(createResult));
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
    const message = error instanceof Error ? error.message : 'Unknown error creating dialog';
    sendCreateDialogFailure(
      ws,
      parsed.requestId,
      normalizeCreateDialogErrorCode(getErrorCode(error)),
      message,
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
        log.debug(
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
    const requestedStatus =
      parseDialogStatusKind((dialogIdent as { status?: unknown }).status) ?? 'running';
    const dialogState = await DialogPersistence.restoreDialog(dialogIdObj, requestedStatus);
    const metadata = await DialogPersistence.loadDialogMetadata(dialogIdObj, requestedStatus);

    if (!dialogState || !metadata) {
      throw new Error(
        `Dialog ${dialogIdObj.valueOf()} not found in ${requestedStatus}; dialog context is stale`,
      );
    }
    const rootPrimingConfig =
      dialogIdObj.selfId === dialogIdObj.rootId ? getRootDialogPrimingConfig(metadata) : undefined;
    const showPrimingEventsInUi = rootPrimingConfig?.showInUi !== false;

    const decidedCourse =
      (await DialogPersistence.getCurrentCourseNumber(dialogIdObj, requestedStatus)) ||
      (dialogState.currentCourse ?? 1);

    const enableLive = requestedStatus === 'running';
    const rootDialog = await getOrRestoreRootDialog(dialogIdObj.rootId, requestedStatus);
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
      const loaded = await ensureDialogLoaded(rootDialog, dialogIdObj, requestedStatus);
      if (!loaded) {
        throw new Error('Dialog not found');
      }
      dialog = loaded;
    }

    // Subscribe BEFORE sending restoration events.
    // This avoids a race where new persisted events (e.g., Agent Priming replay) are emitted
    // between the restoration snapshot read and the subscription setup.
    // Live generation is still gated by dialog.status ('running') in drive handlers.
    await setupWebSocketSubscription(ws, dialog);

    // Send dialog events directly to requesting WebSocket only.
    // This bypasses PubChan to ensure only the requesting session receives restoration events.
    // Pass decidedCourse explicitly since dialog.currentCourse defaults to 1 for new Dialog objects.
    try {
      const dialogStore = dialog.dlgStore;
      if (dialogStore instanceof DiskFileDialogStore) {
        await dialogStore.sendDialogEventsDirectly(
          ws,
          dialog,
          decidedCourse,
          decidedCourse,
          requestedStatus,
          { showPrimingEventsInUi },
        );
      } else {
        throw new Error('Unexpected dialog store type for sendDialogEventsDirectly');
      }
    } catch (err) {
      log.warn(`Failed to send dialog events directly for ${dialogId}:`, err);
    }

    // Send dialog_ready with full info so frontend knows the current dialog ID
    const team = await Team.load();
    const diligencePushMax = normalizeDiligencePushMax(
      resolveMemberDiligencePushMax(team, metadata.agentId),
    );
    const rootLatest = await DialogPersistence.loadDialogLatest(
      new DialogID(dialogIdObj.rootId),
      requestedStatus,
    );
    const defaultDisableDiligencePush = diligencePushMax <= 0;
    const persistedDisableDiligencePush =
      rootLatest && typeof rootLatest.disableDiligencePush === 'boolean'
        ? rootLatest.disableDiligencePush
        : defaultDisableDiligencePush;
    const effectiveDisableDiligencePush = persistedDisableDiligencePush;
    rootDialog.disableDiligencePush = effectiveDisableDiligencePush;
    const derivedSupdialogId =
      metadata.assignmentFromSup?.callerDialogId &&
      metadata.assignmentFromSup.callerDialogId.trim() !== ''
        ? metadata.assignmentFromSup.callerDialogId
        : metadata.supdialogId;
    const dialogReadyResponse: DialogReadyMessage = {
      type: 'dialog_ready',
      dialog: {
        selfId: dialogId,
        rootId: rootDialogId,
        status: requestedStatus,
      },
      agentId: metadata.agentId,
      taskDocPath: metadata.taskDocPath,
      supdialogId: derivedSupdialogId,
      sessionSlug: metadata.sessionSlug,
      assignmentFromSup: metadata.assignmentFromSup,
      disableDiligencePush: effectiveDisableDiligencePush,
      diligencePushMax,
      diligencePushRemainingBudget: clampNonNegativeFiniteInt(
        rootDialog.diligencePushRemainingBudget,
        diligencePushMax > 0 ? diligencePushMax : 0,
      ),
    };
    ws.send(JSON.stringify(dialogReadyResponse));

    // Send authoritative run state for this dialog so the client can render Send↔Stop and Continue.
    try {
      const latest = await DialogPersistence.loadDialogLatest(dialogIdObj, requestedStatus);
      const runState =
        latest?.runState ??
        (requestedStatus === 'running'
          ? { kind: 'idle_waiting_user' }
          : requestedStatus === 'completed'
            ? { kind: 'terminal', status: 'completed' }
            : { kind: 'terminal', status: 'archived' });
      // `display_dialog` is a read/navigation action. Use persisted lastModified as timestamp
      // so the frontend list does not reorder as if there were new activity "now".
      const runStateEvt: TypedDialogEvent = {
        dialog: {
          selfId: dialogIdObj.selfId,
          rootId: dialogIdObj.rootId,
        },
        timestamp: latest?.lastModified ?? formatUnifiedTimestamp(new Date()),
        type: 'dlg_run_state_evt',
        runState,
      };
      ws.send(JSON.stringify(runStateEvt));
    } catch (err) {
      log.warn(`Failed to send dlg_run_state_evt for ${dialogIdObj.valueOf()}:`, err);
    }

    // Emit one Q4H snapshot to ensure frontend has current global questions state.
    // Do NOT replay per-question `new_q4h_asked` events here: those are real-time
    // incremental events and replaying them on display refresh can create duplicate
    // delivery paths and blur event semantics.
    try {
      const allQuestions = await DialogPersistence.loadAllQ4HState();
      const response: Q4HStateResponse = {
        type: 'q4h_state_response',
        questions: allQuestions.map((q) => ({
          id: q.id,
          selfId: q.selfId,
          rootId: q.rootId,
          agentId: q.agentId,
          taskDocPath: q.taskDocPath,
          tellaskContent: q.tellaskContent,
          askedAt: q.askedAt,
          callId: q.callId,
          remainingCallIds: q.remainingCallIds,
          callSiteRef: q.callSiteRef,
        })),
      };
      ws.send(JSON.stringify(response));
    } catch (err) {
      log.warn(`Failed to emit Q4H state for ${dialogIdObj}:`, err);
    }

    // Proactively emit reminders for the newly active dialog
    // todo: maybe emit only to the requestiong websocket, not publish via PubChan as curr impl
    try {
      await syncPendingTellaskReminderBestEffort(dialog, 'handleDisplayDialog');
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
      tellaskContent: q.tellaskContent,
      askedAt: q.askedAt,
      callId: q.callId,
      remainingCallIds: q.remainingCallIds,
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

    await syncPendingTellaskReminderBestEffort(live, 'handleDisplayReminders');
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
      const requestedStatus = parseDialogStatusKind(dialog.status) ?? 'running';
      const metadata = await DialogPersistence.loadDialogMetadata(dialogId, requestedStatus);
      if (!metadata) {
        log.warn('Metadata not found for display_course', undefined, {
          dialogId: dialogId.selfId,
          status: requestedStatus,
        });
        return;
      }

      const totalCourses =
        (await DialogPersistence.getCurrentCourseNumber(dialogId, requestedStatus)) || course;

      const rootDialog = await getOrRestoreRootDialog(dialogId.rootId, requestedStatus);
      if (!rootDialog) return;

      const restoredDialog =
        dialogId.selfId === dialogId.rootId
          ? rootDialog
          : await ensureDialogLoaded(rootDialog, dialogId, requestedStatus);
      if (!restoredDialog) return;

      const store = restoredDialog.dlgStore;
      if (!(store instanceof DiskFileDialogStore)) {
        throw new Error('Unexpected dialog store type for display_course');
      }
      // Send the requested course's persisted events directly to this WebSocket.
      // This is a UI navigation operation; do not emit via PubChan.
      await store.sendDialogEventsDirectly(
        ws,
        restoredDialog,
        course,
        totalCourses,
        requestedStatus,
      );
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

    const dialogIdObj = new DialogID(dialogId, rootDialogId);
    const latest = await DialogPersistence.loadDialogLatest(dialogIdObj, 'running');
    if (latest && latest.runState && latest.runState.kind === 'dead') {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'Dialog is dead and cannot be driven.',
        }),
      );
      return;
    }

    const effectivePrompt = {
      content,
      msgId,
      grammar: 'markdown' as const,
      userLanguageCode,
    };

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
        {
          content: effectivePrompt.content,
          msgId: effectivePrompt.msgId,
          grammar: effectivePrompt.grammar,
          userLanguageCode: effectivePrompt.userLanguageCode,
          origin: 'user',
        },
        true,
        undefined,
      );
      return;
    }

    // Dialog not found in wsLiveDlg - drive using the canonical root/subdialog instances.
    // This supports driving subdialogs and cross-client revival without creating duplicate dialog objects.
    try {
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
        {
          content: effectivePrompt.content,
          msgId: effectivePrompt.msgId,
          grammar: effectivePrompt.grammar,
          userLanguageCode: effectivePrompt.userLanguageCode,
          origin: 'user',
        },
        true,
        undefined,
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
  emitRunControlRefresh('emergency_stop');
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
  await driveDialogStream(restored, undefined, true, { allowResumeFromInterrupted: true });
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
        await driveDialogStream(dlg, undefined, true, { allowResumeFromInterrupted: true });
      } catch (err) {
        log.warn('resume_all: failed to resume dialog', err, { dialogId: id.valueOf() });
      }
    })();
  }
  emitRunControlRefresh('resume_all');
}

/**
 * Handle user answer to a Q4H (Questions for Human) question
 * Validates questionId, clears q4h.yaml entry, and resumes dialog with user's answer
 */
async function handleUserAnswer2Q4H(ws: WebSocket, packet: DriveDialogByUserAnswer): Promise<void> {
  try {
    const { dialog: dialogIdent, content, msgId, questionId, continuationType } = packet;
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
    const latest = await DialogPersistence.loadDialogLatest(dialogIdObj, 'running');
    if (latest && latest.runState && latest.runState.kind === 'dead') {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'Dialog is dead and cannot be driven.',
        }),
      );
      return;
    }

    const effectivePrompt = {
      content,
      msgId,
      grammar: 'markdown' as const,
      userLanguageCode,
    };

    const removed = await DialogPersistence.removeQuestion4HumanState(dialogIdObj, questionId);
    if (!removed.found) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: `Question ${questionId} not found in dialog ${dialogId}`,
        }),
      );
      return;
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

    const removedQuestion = removed.removedQuestion;
    if (!removedQuestion) {
      throw new Error(
        `Q4H remove invariant violation: found=true but removedQuestion missing (rootId=${dialog.id.rootId} selfId=${dialog.id.selfId} questionId=${questionId})`,
      );
    }

    const askHumanCallIds = Array.from(
      new Set(
        [removedQuestion.callId, ...(removedQuestion.remainingCallIds ?? [])]
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter((value) => value !== ''),
      ),
    );
    for (const callId of askHumanCallIds) {
      await dialog.receiveTeammateCallResult(
        'human',
        'askHuman',
        undefined,
        removedQuestion.tellaskContent,
        effectivePrompt.content,
        'completed',
        callId,
      );
    }

    // Emit q4h_answered event for answered question
    const answeredEvent: Q4HAnsweredEvent = {
      type: 'q4h_answered',
      questionId,
      selfId: dialogId,
    };
    postDialogEvent(dialog, answeredEvent);

    const hasPendingSubdialogs = await dialog.hasPendingSubdialogs();
    if (hasPendingSubdialogs) {
      dialog.queueUpNextPrompt({
        prompt: effectivePrompt.content,
        msgId: effectivePrompt.msgId,
        grammar: effectivePrompt.grammar,
        userLanguageCode: effectivePrompt.userLanguageCode,
        q4hAnswerCallIds: askHumanCallIds,
        runControl: undefined,
      });
      log.debug('Deferred Q4H answer until pending subdialogs resolve', undefined, {
        rootId: dialog.id.rootId,
        selfId: dialog.id.selfId,
        questionId,
        msgId: effectivePrompt.msgId,
      });
      return;
    }

    // Resume the dialog with the user's answer.
    await driveDialogStream(
      dialog,
      {
        content: effectivePrompt.content,
        msgId: effectivePrompt.msgId,
        grammar: effectivePrompt.grammar,
        userLanguageCode: effectivePrompt.userLanguageCode,
        q4hAnswerCallIds: askHumanCallIds,
        origin: 'user',
      },
      true,
      undefined,
    );
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

  // Broadcast global dialog events to all connected clients:
  // - Q4H updates are rtws-global state in WebUI
  // - subdialog creation must refresh hierarchy/list even when current subscription is elsewhere
  // - dlg_touched_evt keeps dialog list timestamps/reordering in sync across clients
  setGlobalDialogEventBroadcaster((evt) => {
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

  // Broadcast global run-control refresh hints so all clients converge from persisted dialog index.
  broadcastRunControlRefreshMessage = (msg: RunControlRefreshMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  };

  // Broadcast rtws Problems snapshots to all connected clients.
  setProblemsBroadcaster((msg: WebSocketMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  });

  // Broadcast `.minds/team.yaml` updates so multi-tab clients can refresh cached team config.
  setTeamConfigBroadcaster((msg: WebSocketMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  });
  startTeamConfigWatcher();

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
    void (async () => {
      try {
        const counts = await getRunControlCountsSnapshot();
        ws.send(
          JSON.stringify({
            type: 'run_control_counts_evt',
            proceeding: counts.proceeding,
            resumable: counts.resumable,
            timestamp: formatUnifiedTimestamp(new Date()),
          }),
        );
      } catch (error) {
        log.warn('Failed to send initial run-control counts snapshot', error);
      }
    })();

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
  void shutdownAppsRuntime().finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  cleanupEventSystems();
  void shutdownAppsRuntime().finally(() => process.exit(0));
});
