/**
 * Module: server/websocket-handler
 *
 * Common WebSocket handling functionality for dialog communication
 */
import { DEFAULT_DILIGENCE_PUSH_MAX } from '@longrun-ai/kernel/diligence';
import {
  createPubChan,
  createSubChan,
  EndOfStream,
  type PubChan,
  type SubChan,
} from '@longrun-ai/kernel/evt';
import type {
  ClearResolvedProblemsRequest,
  CreateDialogErrorCode,
  CreateDialogRequest,
  CreateDialogResult,
  DeclareSideDialogDeadRequest,
  DialogReadyMessage,
  DiligencePushUpdatedMessage,
  DisplayCourseRequest,
  DisplayDialogRequest,
  DisplayRemindersRequest,
  DomindsRuntimeMode,
  DomindsRuntimeStatusMessage,
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
  ResumeNotEligibleReason,
  RunControlRefreshMessage,
  SetDiligencePushRequest,
  UserImageAttachment,
  WebSocketMessage,
} from '@longrun-ai/kernel/types';
import type {
  DialogEvent,
  Q4HAnsweredEvent,
  TypedDialogEvent,
} from '@longrun-ai/kernel/types/dialog';
import {
  normalizeLanguageCode,
  supportedLanguageCodes,
  type LanguageCode,
} from '@longrun-ai/kernel/types/language';
import {
  toCallingCourseNumber,
  type FuncResultContentItem,
} from '@longrun-ai/kernel/types/storage';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { randomUUID } from 'crypto';
import fsPromises from 'fs/promises';
import type { Server } from 'http';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import { shutdownAppsRuntime } from '../apps/runtime';
import { installGlobalDialogEventBroadcaster } from '../bootstrap/global-dialog-event-broadcaster';
import { Dialog, DialogID, MainDialog } from '../dialog';
import {
  clearMainDialogQuarantining,
  clearMainDialogQuarantiningIfIdle,
  forceStopActiveRunsForMainDialog,
  getRunControlCountsSnapshot,
  getStopRequestedReason,
  hasActiveRun,
  isDialogLatestResumable,
  loadDialogExecutionMarker,
  markMainDialogQuarantining,
  refreshRunControlProjectionFromPersistenceFacts,
  requestEmergencyStopAll,
  requestInterruptDialog,
  setDialogDisplayState,
  setDialogExecutionMarker,
  setDisplayStateBroadcaster,
} from '../dialog-display-state';
import { globalDialogRegistry } from '../dialog-global-registry';
import {
  ensureDialogLoaded,
  getOrRestoreMainDialog,
  type DialogPersistenceStatus,
} from '../dialog-instance-registry';
import { dialogEventRegistry, postDialogEvent } from '../evt-registry';
import { driveDialogStream, supplyResponseToAskerDialog } from '../llm/kernel-driver';
import { maybePrepareDiligenceAutoContinuePrompt } from '../llm/kernel-driver/runtime';
import { createLogger } from '../log';
import {
  DialogPersistence,
  DiskFileDialogStore,
  setDialogsQuarantinedBroadcaster,
  setFinalizeDialogQuarantineHook,
  setPrepareDialogQuarantineHook,
} from '../persistence';
import { findDomindsPersistenceFileError } from '../persistence-errors';
import {
  applyPrimingScriptsToDialog,
  buildMainDialogPrimingMetadata,
  getMainDialogPrimingConfig,
} from '../priming';
import {
  clearResolvedProblems,
  createProblemsSnapshotMessage,
  setProblemsBroadcaster,
} from '../problems';
import { recoverPendingReplyTellaskCallsForDialog } from '../recovery/reply-special';
import { formatSystemNoticePrefix } from '../runtime/driver-messages';
import { formatTellaskCarryoverResultContent } from '../runtime/inter-dialog-format';
import { getWorkLanguage } from '../runtime/work-language';
import { Team } from '../team';
import {
  clearTeamConfigBroadcaster,
  setTeamConfigBroadcaster,
  startTeamConfigWatcher,
  stopTeamConfigWatcher,
} from '../team-config-updates';
import {
  clearToolAvailabilityBroadcaster,
  setToolAvailabilityBroadcaster,
} from '../tool-availability-updates';
import { syncPendingTellaskReminderState } from '../tools/pending-tellask-reminder';
import { generateDialogID } from '../utils/id';
import type { AuthConfig } from './auth';
import { getWebSocketAuthCheck } from './auth';
import {
  makeCreateDialogFailure,
  normalizeCreateDialogErrorCode,
  parseCreateDialogInput,
} from './create-dialog-contract';
import {
  createDomindsRuntimeStatusMessage,
  getDomindsRuntimeStatus,
} from './dominds-runtime-status';
import { setDomindsSelfUpdateBroadcaster } from './dominds-self-update';

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

const USER_IMAGE_ATTACHMENT_MAX_COUNT = 10;
const USER_IMAGE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

function userImageMimeTypeToExt(mimeType: string): string | null {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return null;
  }
}

function sanitizeArtifactPathSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
  const trimmed = cleaned.replace(/^_+|_+$/g, '');
  return trimmed.length > 0 ? trimmed.slice(0, 96) : 'item';
}

function parseUserImageAttachments(raw: unknown): UserImageAttachment[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error('attachments must be an array when provided');
  }
  if (raw.length > USER_IMAGE_ATTACHMENT_MAX_COUNT) {
    throw new Error(
      `at most ${String(USER_IMAGE_ATTACHMENT_MAX_COUNT)} image attachments are allowed`,
    );
  }
  return raw.map((item, index): UserImageAttachment => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`attachments[${String(index)}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const kind = record['kind'];
    const mimeType = record['mimeType'];
    const byteLength = record['byteLength'];
    const dataBase64 = record['dataBase64'];
    if (kind !== 'image') {
      throw new Error(`attachments[${String(index)}].kind must be image`);
    }
    if (typeof mimeType !== 'string' || userImageMimeTypeToExt(mimeType) === null) {
      throw new Error(`attachments[${String(index)}].mimeType is unsupported`);
    }
    if (
      typeof byteLength !== 'number' ||
      !Number.isFinite(byteLength) ||
      byteLength <= 0 ||
      byteLength > USER_IMAGE_ATTACHMENT_MAX_BYTES
    ) {
      throw new Error(
        `attachments[${String(index)}].byteLength must be between 1 and ${String(
          USER_IMAGE_ATTACHMENT_MAX_BYTES,
        )}`,
      );
    }
    if (typeof dataBase64 !== 'string' || dataBase64.trim() === '') {
      throw new Error(`attachments[${String(index)}].dataBase64 is required`);
    }
    return { kind, mimeType, byteLength, dataBase64 };
  });
}

function isStrictBase64Payload(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

type PreparedUserImageAttachment = Readonly<{
  mimeType: UserImageAttachment['mimeType'];
  bytes: Buffer;
}>;

function prepareUserImageAttachments(
  attachments: readonly UserImageAttachment[],
): PreparedUserImageAttachment[] {
  return attachments.map((attachment, index): PreparedUserImageAttachment => {
    if (!isStrictBase64Payload(attachment.dataBase64)) {
      throw new Error(`attachments[${String(index)}].dataBase64 must be strict base64`);
    }
    const bytes = Buffer.from(attachment.dataBase64, 'base64');
    if (bytes.length !== attachment.byteLength) {
      throw new Error(
        `attachments[${String(index)}].byteLength mismatch: declared=${String(
          attachment.byteLength,
        )} decoded=${String(bytes.length)}`,
      );
    }
    return {
      mimeType: attachment.mimeType,
      bytes,
    };
  });
}

async function persistPreparedUserImageAttachments(args: {
  dialog: Dialog;
  msgId: string;
  attachments: readonly PreparedUserImageAttachment[];
}): Promise<FuncResultContentItem[] | undefined> {
  if (args.attachments.length === 0) return undefined;
  const eventsBase = DialogPersistence.getDialogEventsPath(args.dialog.id, args.dialog.status);
  const safeMsgId = sanitizeArtifactPathSegment(args.msgId);
  const contentItems: FuncResultContentItem[] = [];

  for (let index = 0; index < args.attachments.length; index += 1) {
    const attachment = args.attachments[index];
    const ext = userImageMimeTypeToExt(attachment.mimeType);
    if (ext === null) {
      throw new Error(`attachments[${String(index)}].mimeType is unsupported`);
    }
    const relPath = path.posix.join(
      'artifacts',
      'user-input',
      safeMsgId,
      `${String(index + 1).padStart(2, '0')}-${randomUUID()}.${ext}`,
    );
    const absPath = path.join(eventsBase, ...relPath.split('/'));
    await fsPromises.mkdir(path.dirname(absPath), { recursive: true });
    await fsPromises.writeFile(absPath, attachment.bytes);
    contentItems.push({
      type: 'input_image',
      mimeType: attachment.mimeType,
      byteLength: attachment.bytes.length,
      artifact: {
        rootId: args.dialog.id.rootId,
        selfId: args.dialog.id.selfId,
        status: args.dialog.status,
        relPath,
      },
    });
  }

  return contentItems;
}

function parsePersistableDialogStatus(raw: unknown): DialogPersistenceStatus | null {
  if (raw !== 'running' && raw !== 'completed' && raw !== 'archived') {
    return null;
  }
  return raw;
}

function readOptionalPersistableDialogStatus(raw: unknown):
  | {
      kind: 'missing';
    }
  | {
      kind: 'invalid';
    }
  | {
      kind: 'value';
      status: DialogPersistenceStatus;
    } {
  if (raw === undefined) {
    return { kind: 'missing' };
  }
  const status = parsePersistableDialogStatus(raw);
  if (status === null) {
    return { kind: 'invalid' };
  }
  return { kind: 'value', status };
}

function formatDeclaredDeadSideDialogNotice(
  language: 'zh' | 'en',
  dialogId: string,
  callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning',
): string {
  if (language === 'zh') {
    switch (callName) {
      case 'tellask':
        return `${formatSystemNoticePrefix('zh')} 支线对话 ${dialogId} 已被用户宣布卡死（不可逆）。后续仍可重用相同的 slug 发起全新支线对话；只是此前的上下文已不再，新的诉请正文请提供最新的完整上下文信息。`;
      case 'tellaskSessionless':
        return `${formatSystemNoticePrefix('zh')} 支线对话 ${dialogId} 已被用户宣布卡死（不可逆）。这是一次性支线对话；后续若仍需继续，请重新发起新的支线对话。由于不会续接此前上下文，新的诉请正文请提供最新的完整上下文信息。`;
      case 'freshBootsReasoning':
        return `${formatSystemNoticePrefix('zh')} 支线对话 ${dialogId} 已被用户宣布卡死（不可逆）。这是一次扪心自问（FBR）支线对话；后续若仍需继续，请重新发起新的扪心自问（FBR）支线对话。由于不会续接此前上下文，新的诉请正文请提供最新的完整上下文信息。`;
    }
  }

  switch (callName) {
    case 'tellask':
      return `${formatSystemNoticePrefix('en')} Side Dialog ${dialogId} has been declared dead by the user (irreversible). You may reuse the same slug to start a brand-new Side Dialog, but previous context is no longer retained; include the latest complete context in the new tellask body.`;
    case 'tellaskSessionless':
      return `${formatSystemNoticePrefix('en')} Side Dialog ${dialogId} has been declared dead by the user (irreversible). This was a one-shot Side Dialog; if you still need the work, start a new Side Dialog. Previous context will not carry over, so include the latest complete context in the new tellask body.`;
    case 'freshBootsReasoning':
      return `${formatSystemNoticePrefix('en')} Side Dialog ${dialogId} has been declared dead by the user (irreversible). This was an FBR Side Dialog; if you still need the work, start a new FBR Side Dialog. Previous context will not carry over, so include the latest complete context in the new tellask body.`;
  }
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

function buildResumeIneligibleMessage(
  latest: Awaited<ReturnType<typeof DialogPersistence.loadDialogLatest>>,
): {
  message: string;
  reason: ResumeNotEligibleReason;
} {
  // WARNING:
  // `resume_dialog` eligibility is intentionally based on the freshly healed projection, not on a
  // naive local check of raw blocker facts. In particular, the paused-interjection stopped state
  // must remain resumable here so the user can explicitly press Continue even while the underlying
  // dialog may still be blocked.
  //
  // The actual outcome of that Continue attempt is decided later in `flow.ts` from fresh facts:
  // it may restore `blocked`, or it may immediately continue driving. Do not reinterpret a
  // resumable stopped state here as "guaranteed to run now".
  const state = latest?.displayState;
  if (!state) {
    return {
      reason: 'missing',
      message: 'Dialog is not currently eligible for resumption.',
    };
  }
  switch (state.kind) {
    case 'blocked':
      switch (state.reason.kind) {
        case 'needs_human_input_and_sideDialogs':
          return {
            reason: 'needs_human_input_and_sideDialogs',
            message:
              'Fresh state scan shows this dialog is waiting for both human input and Side Dialogs, so it cannot resume yet.',
          };
        case 'needs_human_input':
          return {
            reason: 'needs_human_input',
            message:
              'Fresh state scan shows this dialog is waiting for human input, so it cannot resume yet.',
          };
        case 'waiting_for_sideDialogs':
          return {
            reason: 'waiting_for_sideDialogs',
            message:
              'Fresh state scan shows this dialog is waiting for Side Dialogs, so it cannot resume yet.',
          };
        default: {
          const _exhaustive: never = state.reason;
          return {
            reason: 'missing',
            message: `Dialog is not currently eligible for resumption: ${String(_exhaustive)}`,
          };
        }
      }
    case 'idle_waiting_user':
      return {
        reason: 'idle_waiting_user',
        message:
          'Fresh state scan shows this dialog is no longer interrupted and is now waiting for a new user input.',
      };
    case 'proceeding':
    case 'proceeding_stop_requested':
      return {
        reason: 'already_running',
        message:
          'Fresh state scan shows this dialog is already running, so it cannot be resumed again.',
      };
    case 'stopped':
      return {
        reason: 'stopped_not_resumable',
        message: 'Fresh state scan shows this dialog is stopped but not currently resumable.',
      };
    case 'dead':
      return {
        reason: 'dead',
        message: 'Fresh state scan shows this dialog has been declared dead and cannot be resumed.',
      };
    default: {
      const _exhaustive: never = state;
      return {
        reason: 'missing',
        message: `Dialog is not currently eligible for resumption: ${String(_exhaustive)}`,
      };
    }
  }
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

function syncDialogLanguagePreference(
  dialog: Dialog,
  language: LanguageCode,
  options?: { appendSwitchNotice?: boolean },
): void {
  const previousLanguage = dialog.getLastUserLanguageCode();
  dialog.setUiLanguage(language);
  dialog.setLastUserLanguageCode(language);
  if (options?.appendSwitchNotice) {
    dialog.appendCourseLanguageChangedNotice(previousLanguage, language);
    return;
  }
  dialog.resetCourseLanguageNotice();
}

export function shouldQueueUserSupplementAtGenerationBoundary(args: {
  latestGenerating: boolean;
  inMemoryGenerating: boolean;
  isLocked: boolean;
}): boolean {
  if (!args.isLocked) {
    return false;
  }
  return args.latestGenerating || args.inMemoryGenerating;
}

async function queueUserSupplementAtGenerationBoundary(
  dialog: Dialog,
  prompt: {
    content: string;
    contentItems?: FuncResultContentItem[];
    msgId: string;
    grammar: 'markdown';
    userLanguageCode?: LanguageCode;
  },
): Promise<boolean> {
  const latest = await DialogPersistence.loadDialogLatest(dialog.id, 'running');
  const inMemoryGenerating = dialog.hasActiveGeneration;
  // Live UX can observe generating_start before latest.yaml flips generating=true, so boundary
  // queuing must honor either persisted or in-memory generation state.
  if (
    !shouldQueueUserSupplementAtGenerationBoundary({
      latestGenerating: latest?.generating === true,
      inMemoryGenerating,
      isLocked: dialog.isLocked(),
    })
  ) {
    return false;
  }
  const queued = dialog.queueUserPromptAtGenerationBoundary({
    prompt: prompt.content,
    contentItems: prompt.contentItems,
    msgId: prompt.msgId,
    grammar: prompt.grammar,
    userLanguageCode: prompt.userLanguageCode,
  });
  postDialogEvent(dialog, {
    type: 'queue_user_msg_evt',
    course: dialog.currentCourse,
    msgId: queued.msgId,
    content: queued.prompt,
    contentItems: queued.contentItems,
    grammar: queued.grammar ?? 'markdown',
    origin: 'user',
    userLanguageCode: queued.userLanguageCode,
  });

  log.debug('Queued user supplement for next generation boundary', undefined, {
    rootId: dialog.id.rootId,
    selfId: dialog.id.selfId,
    msgId: queued.msgId,
    incomingMsgId: prompt.msgId,
    latestGenerating: latest?.generating === true,
    inMemoryGenerating,
  });
  return true;
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

      case 'clear_resolved_problems':
        await handleClearResolvedProblems(ws, packet);
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
        await handleReceiveHumanReply(ws, packet);
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

      case 'declare_sideDialog_dead':
        await handleDeclareSideDialogDead(ws, packet);
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

async function handleDeclareSideDialogDead(
  ws: WebSocket,
  packet: DeclareSideDialogDeadRequest,
): Promise<void> {
  const dialog = packet.dialog;
  const noteRaw = typeof packet.note === 'string' ? packet.note : '';
  const note = noteRaw.trim();
  if (!dialog || typeof dialog.selfId !== 'string' || typeof dialog.rootId !== 'string') {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'declare_sideDialog_dead requires dialog.selfId/rootId',
      }),
    );
    return;
  }

  if (dialog.selfId === dialog.rootId) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'declare_sideDialog_dead is allowed only for sideDialogs (selfId must differ)',
      }),
    );
    return;
  }

  const dialogIdObj = new DialogID(dialog.selfId, dialog.rootId);
  const requestedStatusInput = readOptionalPersistableDialogStatus(dialog.status);
  if (requestedStatusInput.kind === 'invalid') {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'declare_sideDialog_dead requires status running, completed, or archived',
      }),
    );
    return;
  }
  const requestedStatus =
    requestedStatusInput.kind === 'missing' ? 'running' : requestedStatusInput.status;
  if (requestedStatus !== 'running') {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'declare_sideDialog_dead is available only for running dialogs',
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

  if (latest.executionMarker?.kind === 'dead') {
    // Idempotent
    return;
  }

  // Best-effort abort if the dialog is currently proceeding.
  await requestInterruptDialog(dialogIdObj, 'emergency_stop');

  await setDialogExecutionMarker(dialogIdObj, {
    kind: 'dead',
    reason: { kind: 'declared_by_user' },
  });
  await setDialogDisplayState(dialogIdObj, { kind: 'dead', reason: { kind: 'declared_by_user' } });

  // If an askerDialog is waiting on this sideDialog (pending-sideDialogs.json), supply a system-style
  // response so the askerDialog can unblock and the model sees the failure reason.
  const metadata = await DialogPersistence.loadDialogMetadata(dialogIdObj, requestedStatus);
  if (!metadata) return;

  if (typeof metadata.sessionSlug === 'string' && metadata.sessionSlug.trim() !== '') {
    const rootRestored = await restoreDialogForDrive(new DialogID(dialogIdObj.rootId), 'running');
    if (!(rootRestored instanceof MainDialog)) {
      throw new Error(`Expected main dialog instance for ${dialogIdObj.rootId}`);
    }
    const removed = rootRestored.unregisterSideDialog(metadata.agentId, metadata.sessionSlug);
    if (removed) {
      await rootRestored.saveSideDialogRegistry();
    }
  }

  if (!('assignmentFromAsker' in metadata)) return;
  if (!metadata.assignmentFromAsker) return;

  const askerDialogId = metadata.assignmentFromAsker.callerDialogId;
  if (typeof askerDialogId !== 'string' || askerDialogId.trim() === '') return;

  const askerDialogIdObj = new DialogID(askerDialogId, dialogIdObj.rootId);
  const pending = await DialogPersistence.loadPendingSideDialogs(askerDialogIdObj, requestedStatus);
  const pendingRecord = pending.find((p) => p.sideDialogId === dialogIdObj.selfId);
  if (!pendingRecord) {
    // Asker is not waiting on this sideDialog anymore; do not auto-revive.
    return;
  }

  const parentDialog = await restoreDialogForDrive(askerDialogIdObj, 'running');

  const responseText = formatDeclaredDeadSideDialogNotice(
    getWorkLanguage(),
    dialogIdObj.valueOf(),
    metadata.assignmentFromAsker.callName,
  );
  const responseTextWithNote =
    note === ''
      ? responseText
      : getWorkLanguage() === 'zh'
        ? `${responseText}\n\n使用者补充（来自输入框）：\n${note}`
        : `${responseText}\n\nUser note (from the input box):\n${note}`;

  await supplyResponseToAskerDialog(
    parentDialog,
    dialogIdObj,
    responseTextWithNote,
    pendingRecord.callType,
    metadata.assignmentFromAsker.callId,
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

    // Diligence Push is main-dialog state. Even if a sideDialog is displayed, always mutate the root.
    const dialogIdObj = new DialogID(rootId);
    const requestedStatusInput = readOptionalPersistableDialogStatus(dialog.status);
    if (requestedStatusInput.kind === 'invalid') {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'set_diligence_push requires status running, completed, or archived',
        }),
      );
      return;
    }
    const requestedStatus =
      requestedStatusInput.kind === 'missing' ? 'running' : requestedStatusInput.status;
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
    const mainDialog = await getOrRestoreMainDialog(dialogIdObj.rootId, requestedStatus);
    if (mainDialog) {
      mainDialog.disableDiligencePush = disableDiligencePush;
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
      mainDialog instanceof MainDialog;
    if (shouldTriggerImmediateDiligence) {
      void maybeTriggerImmediateDiligencePrompt(mainDialog);
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

async function maybeTriggerImmediateDiligencePrompt(mainDialog: MainDialog): Promise<void> {
  try {
    if (mainDialog.disableDiligencePush) {
      return;
    }

    if (hasActiveRun(mainDialog.id)) {
      return;
    }
    if (getStopRequestedReason(mainDialog.id) !== undefined) {
      return;
    }
    const executionMarker = await loadDialogExecutionMarker(mainDialog.id, 'running');
    if (executionMarker?.kind === 'interrupted' || executionMarker?.kind === 'dead') {
      return;
    }

    const suspension = await mainDialog.getSuspensionStatus();
    if (!suspension.canDrive) {
      return;
    }

    const team = await Team.load();
    const prepared = await maybePrepareDiligenceAutoContinuePrompt({
      dlg: mainDialog,
      isMainDialog: true,
      remainingBudget: mainDialog.diligencePushRemainingBudget,
      diligencePushMax: resolveMemberDiligencePushMax(team, mainDialog.agentId),
    });

    mainDialog.diligencePushRemainingBudget = prepared.nextRemainingBudget;
    await DialogPersistence.mutateDialogLatest(mainDialog.id, () => ({
      kind: 'patch',
      patch: { diligencePushRemainingBudget: mainDialog.diligencePushRemainingBudget },
    }));

    if (prepared.kind !== 'disabled') {
      postDialogEvent(mainDialog, {
        type: 'diligence_budget_evt',
        maxInjectCount: prepared.maxInjectCount,
        injectedCount: Math.max(0, prepared.maxInjectCount - prepared.nextRemainingBudget),
        remainingCount: Math.max(0, prepared.nextRemainingBudget),
        disableDiligencePush: mainDialog.disableDiligencePush,
      });
    }

    if (prepared.kind === 'prompt') {
      await driveDialogStream(mainDialog, prepared.prompt, true, {
        source: 'ws_diligence_push',
        reason: 'enable_keep_going_immediate_prompt',
      });
    }
  } catch (error) {
    log.warn('Failed to trigger immediate diligence prompt after enabling keep-going', error, {
      dialogId: mainDialog.id.valueOf(),
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

  const mainDialogId = new DialogID(rootId);
  const requestedStatusInput = readOptionalPersistableDialogStatus(dialog.status);
  if (requestedStatusInput.kind === 'invalid') {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'refill_diligence_push_budget requires status running, completed, or archived',
      }),
    );
    return;
  }
  const requestedStatus =
    requestedStatusInput.kind === 'missing' ? 'running' : requestedStatusInput.status;
  const rootMeta = await DialogPersistence.loadDialogMetadata(mainDialogId, requestedStatus);
  if (!rootMeta) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: `Dialog ${mainDialogId.valueOf()} not found in ${requestedStatus}; dialog context is stale`,
      }),
    );
    return;
  }

  const mainDialog = await getOrRestoreMainDialog(mainDialogId.rootId, requestedStatus);
  if (!mainDialog) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: `Main dialog ${mainDialogId.rootId} is not available for refill`,
      }),
    );
    return;
  }

  const team = await Team.load();
  const configuredMax = normalizeDiligencePushMax(
    resolveMemberDiligencePushMax(team, mainDialog.agentId),
  );

  if (configuredMax > 0) {
    mainDialog.diligencePushRemainingBudget = configuredMax;
  } else {
    mainDialog.diligencePushRemainingBudget =
      clampNonNegativeFiniteInt(mainDialog.diligencePushRemainingBudget, 0) + 3;
  }
  await DialogPersistence.mutateDialogLatest(
    mainDialogId,
    () => ({
      kind: 'patch',
      patch: { diligencePushRemainingBudget: mainDialog.diligencePushRemainingBudget },
    }),
    requestedStatus,
  );

  postDialogEvent(mainDialog, {
    type: 'diligence_budget_evt',
    maxInjectCount: configuredMax > 0 ? configuredMax : 0,
    injectedCount: 0,
    remainingCount: mainDialog.diligencePushRemainingBudget,
    disableDiligencePush: mainDialog.disableDiligencePush,
  });
}

async function handleGetProblems(ws: WebSocket, packet: WebSocketMessage): Promise<void> {
  if (packet.type !== 'get_problems') {
    throw new Error('Internal error: handleGetProblems called with non get_problems packet');
  }
  const _req: GetProblemsRequest = packet;
  ws.send(JSON.stringify(createProblemsSnapshotMessage()));
}

async function handleClearResolvedProblems(ws: WebSocket, packet: WebSocketMessage): Promise<void> {
  if (packet.type !== 'clear_resolved_problems') {
    throw new Error(
      'Internal error: handleClearResolvedProblems called with non clear_resolved_problems packet',
    );
  }
  const _req: ClearResolvedProblemsRequest = packet;
  const removedCount = clearResolvedProblems();
  ws.send(
    JSON.stringify({
      type: 'clear_resolved_problems_result',
      removedCount,
      timestamp: formatUnifiedTimestamp(new Date()),
    }),
  );
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
  const liveDialog = wsLiveDlg.get(ws);
  if (liveDialog) {
    syncDialogLanguagePreference(liveDialog, parsed, { appendSwitchNotice: true });
  }
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
    // For main dialogs, self and root are the same
    const dialogId = new DialogID(generatedId);

    // Import Dialog and DiskFileDialogStore

    // Create DiskFileDialogStore for file-based persistence
    const dialogUI = new DiskFileDialogStore(dialogId);

    // Create MainDialog instance with the new store
    const dialog = new MainDialog(dialogUI, taskDocPath, dialogId, agentId);
    // display_dialog is intentionally read-only. Do not trigger replyTellask* recovery here:
    // merely opening a dialog must not deliver persisted replies or kick off follow-up drives.
    syncDialogLanguagePreference(dialog, resolveUserLanguageCode(ws, undefined, dialog));
    globalDialogRegistry.register(dialog);
    // Setup WebSocket subscription for real-time events
    await setupWebSocketSubscription(ws, dialog);

    // Persist dialog metadata and latest.yaml (write-once pattern)
    const metadata = {
      id: dialogId.selfId,
      agentId,
      taskDocPath: taskDocPath,
      createdAt: formatUnifiedTimestamp(new Date()),
      priming: buildMainDialogPrimingMetadata(priming),
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
        sideDialogCount: 0,
        displayState: { kind: 'idle_waiting_user' },
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
    let mainDialogId = dialogIdent.rootId;

    // Handle case where dialogIdent properties might be objects instead of strings
    if (typeof dialogId !== 'string' || typeof mainDialogId !== 'string') {
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
      const isSameDialog = existingId.selfId === dialogId && existingId.rootId === mainDialogId;
      if (isSameDialog) {
        log.debug(
          'display_dialog: refreshing the same dialog; cancelling existing subscription to prevent duplicate stream events',
          undefined,
          { dialogId, mainDialogId },
        );
      } else {
        log.debug(
          'display_dialog: switching dialogs; cancelling previous subscription',
          undefined,
          {
            previousDialogId: existingId.valueOf(),
            nextDialogId: new DialogID(dialogId, mainDialogId).valueOf(),
          },
        );
      }
      cleanupWsClient(ws);
    }

    const dialogIdObj = new DialogID(dialogId, mainDialogId);
    const requestedStatusInput = readOptionalPersistableDialogStatus(
      (dialogIdent as { status?: unknown }).status,
    );
    if (requestedStatusInput.kind === 'invalid') {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'display_dialog requires status running, completed, or archived',
        }),
      );
      return;
    }
    const requestedStatus =
      requestedStatusInput.kind === 'missing' ? 'running' : requestedStatusInput.status;
    const dialogState = await DialogPersistence.restoreDialog(dialogIdObj, requestedStatus);
    const metadata = await DialogPersistence.loadDialogMetadata(dialogIdObj, requestedStatus);

    if (!dialogState || !metadata) {
      throw new Error(
        `Dialog ${dialogIdObj.valueOf()} not found in ${requestedStatus}; dialog context is stale`,
      );
    }
    const rootPrimingConfig =
      dialogIdObj.selfId === dialogIdObj.rootId ? getMainDialogPrimingConfig(metadata) : undefined;
    const showPrimingEventsInUi = rootPrimingConfig?.showInUi !== false;

    const decidedCourse =
      (await DialogPersistence.getCurrentCourseNumber(dialogIdObj, requestedStatus)) ||
      (dialogState.currentCourse ?? 1);

    const enableLive = requestedStatus === 'running';
    const mainDialog = await getOrRestoreMainDialog(dialogIdObj.rootId, requestedStatus);
    if (!mainDialog) {
      throw new Error('Main dialog not found');
    }
    if (enableLive) {
      globalDialogRegistry.register(mainDialog);
    }

    let dialog: Dialog;
    if (dialogIdObj.selfId === dialogIdObj.rootId) {
      dialog = mainDialog;
    } else {
      const loaded = await ensureDialogLoaded(mainDialog, dialogIdObj, requestedStatus);
      if (!loaded) {
        throw new Error('Dialog not found');
      }
      dialog = loaded;
    }

    syncDialogLanguagePreference(dialog, resolveUserLanguageCode(ws, undefined, dialog));

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
    mainDialog.disableDiligencePush = effectiveDisableDiligencePush;
    let derivedAskerDialogId: string | undefined;
    if (dialogIdObj.selfId !== dialogIdObj.rootId) {
      const assignmentFromAsker = metadata.assignmentFromAsker;
      derivedAskerDialogId = assignmentFromAsker ? assignmentFromAsker.callerDialogId.trim() : '';
    }
    if (dialogIdObj.selfId !== dialogIdObj.rootId && !derivedAskerDialogId) {
      const error = new Error(
        `dialog_ready invariant violation: missing assignmentFromAsker.callerDialogId ` +
          `(rootId=${dialogIdObj.rootId}, selfId=${dialogIdObj.selfId}, status=${requestedStatus})`,
      );
      log.error(
        'dialog_ready invariant violation: missing assignmentFromAsker.callerDialogId',
        error,
        {
          rootId: dialogIdObj.rootId,
          selfId: dialogIdObj.selfId,
          status: requestedStatus,
        },
      );
      throw error;
    }
    const dialogReadyResponse: DialogReadyMessage = {
      type: 'dialog_ready',
      dialog: {
        selfId: dialogId,
        rootId: mainDialogId,
        status: requestedStatus,
      },
      agentId: metadata.agentId,
      taskDocPath: metadata.taskDocPath,
      askerDialogId: derivedAskerDialogId,
      sessionSlug: metadata.sessionSlug,
      assignmentFromAsker: metadata.assignmentFromAsker,
      disableDiligencePush: effectiveDisableDiligencePush,
      diligencePushMax,
      diligencePushRemainingBudget: clampNonNegativeFiniteInt(
        mainDialog.diligencePushRemainingBudget,
        diligencePushMax > 0 ? diligencePushMax : 0,
      ),
    };
    ws.send(JSON.stringify(dialogReadyResponse));

    // Running dialogs expose a persisted display-state snapshot for viewport controls.
    if (requestedStatus === 'running') {
      try {
        const latest = await DialogPersistence.loadDialogLatest(dialogIdObj, requestedStatus);
        const displayState = latest?.displayState ?? { kind: 'idle_waiting_user' };
        // `display_dialog` is a read/navigation action. Use persisted lastModified as timestamp
        // so the frontend list does not reorder as if there were new activity "now".
        const displayStateEvt: TypedDialogEvent = {
          dialog: {
            selfId: dialogIdObj.selfId,
            rootId: dialogIdObj.rootId,
          },
          timestamp: latest?.lastModified ?? formatUnifiedTimestamp(new Date()),
          type: 'dlg_display_state_evt',
          displayState,
        };
        ws.send(JSON.stringify(displayStateEvt));
      } catch (err) {
        log.warn(`Failed to send dlg_display_state_evt for ${dialogIdObj.valueOf()}:`, err);
      }
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
    // `selfId` + `rootId` uniquely identify the originating dialog (including sideDialogs).
    const questions = allQuestions.map((q) => ({
      id: q.id,
      selfId: q.selfId,
      rootId: q.rootId,
      agentId: q.agentId,
      taskDocPath: q.taskDocPath,
      tellaskContent: q.tellaskContent,
      askedAt: q.askedAt,
      callId: q.callId,
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
    let mainDialogIdStr = dialog.rootId;

    // Handle case where dialog properties might be objects instead of strings
    if (typeof dialogIdStr !== 'string' || typeof mainDialogIdStr !== 'string') {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: 'Invalid dialog identifiers for display_course: selfId/rootId must be strings',
        }),
      );
      return;
    }

    const dialogId = new DialogID(dialogIdStr, mainDialogIdStr);

    try {
      const requestedStatusInput = readOptionalPersistableDialogStatus(dialog.status);
      if (requestedStatusInput.kind === 'invalid') {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'display_course requires status running, completed, or archived',
          }),
        );
        return;
      }
      const requestedStatus =
        requestedStatusInput.kind === 'missing' ? 'running' : requestedStatusInput.status;
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

      const mainDialog = await getOrRestoreMainDialog(dialogId.rootId, requestedStatus);
      if (!mainDialog) return;

      const restoredDialog =
        dialogId.selfId === dialogId.rootId
          ? mainDialog
          : await ensureDialogLoaded(mainDialog, dialogId, requestedStatus);
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
    const attachments = parseUserImageAttachments(packet.attachments);
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
    const mainDialogId = dialogIdent.rootId;

    // Validate dialog identifiers
    if (typeof dialogId !== 'string' || typeof mainDialogId !== 'string') {
      ws.send(
        JSON.stringify({
          type: 'error',
          message:
            'Invalid dialog identifiers for drive_dlg_by_user_msg: selfId/rootId must be strings',
        }),
      );
      return;
    }

    const dialogIdObj = new DialogID(dialogId, mainDialogId);
    const latest = await DialogPersistence.loadDialogLatest(dialogIdObj, 'running');
    if (latest?.executionMarker?.kind === 'dead') {
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
    const preparedAttachments = prepareUserImageAttachments(attachments);

    // If the dialog is already active for this WebSocket, runnable (status === 'running'),
    // and has an event forwarder (subChan),
    // drive it directly to preserve in-memory state (pending sideDialogs, teammate tellask tracking, etc).
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
      existingDialog.id.rootId === mainDialogId &&
      existingDialog.status === 'running' &&
      existingSub &&
      existingSub.dialogKey === existingDialog.id.valueOf()
    ) {
      const contentItems = await persistPreparedUserImageAttachments({
        dialog: existingDialog,
        msgId: effectivePrompt.msgId,
        attachments: preparedAttachments,
      });
      const queuedAtBoundary = await queueUserSupplementAtGenerationBoundary(existingDialog, {
        ...effectivePrompt,
        contentItems,
      });
      if (queuedAtBoundary) {
        return;
      }
      await driveDialogStream(
        existingDialog,
        {
          content: effectivePrompt.content,
          ...(contentItems === undefined ? {} : { contentItems }),
          msgId: effectivePrompt.msgId,
          grammar: effectivePrompt.grammar,
          userLanguageCode: effectivePrompt.userLanguageCode,
          origin: 'user',
        },
        true,
        {
          source: 'ws_user_message',
          reason: 'drive_dlg_by_user_msg',
        },
      );
      return;
    }

    // Dialog not found in wsLiveDlg - drive using the canonical root/sideDialog instances.
    // This supports driving sideDialogs and cross-client revival without creating duplicate dialog objects.
    try {
      const mainDialog = await getOrRestoreMainDialog(dialogIdObj.rootId, 'running');
      if (!mainDialog) {
        ws.send(JSON.stringify({ type: 'error', message: `Dialog ${dialogId} not found` }));
        return;
      }
      globalDialogRegistry.register(mainDialog);

      const dialog =
        dialogIdObj.selfId === dialogIdObj.rootId
          ? mainDialog
          : await ensureDialogLoaded(mainDialog, dialogIdObj, 'running');
      if (!dialog) {
        ws.send(JSON.stringify({ type: 'error', message: `Dialog ${dialogId} not found` }));
        return;
      }

      await setupWebSocketSubscription(ws, dialog);
      const contentItems = await persistPreparedUserImageAttachments({
        dialog,
        msgId: effectivePrompt.msgId,
        attachments: preparedAttachments,
      });
      const queuedAtBoundary = await queueUserSupplementAtGenerationBoundary(dialog, {
        ...effectivePrompt,
        contentItems,
      });
      if (queuedAtBoundary) {
        return;
      }
      await driveDialogStream(
        dialog,
        {
          content: effectivePrompt.content,
          ...(contentItems === undefined ? {} : { contentItems }),
          msgId: effectivePrompt.msgId,
          grammar: effectivePrompt.grammar,
          userLanguageCode: effectivePrompt.userLanguageCode,
          origin: 'user',
        },
        true,
        {
          source: 'ws_user_message',
          reason: 'drive_dlg_by_user_msg',
        },
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
  const mainDialog = await getOrRestoreMainDialog(dialogIdObj.rootId, status);
  if (!mainDialog) {
    throw new Error(`Dialog ${dialogIdObj.valueOf()} not found`);
  }
  globalDialogRegistry.register(mainDialog);

  // This helper is intentionally for business operations that will mutate or continue execution
  // immediately after restore (for example resume_dialog, resume_all, or dead-sideDialog recovery).
  // Because those operations are execution-oriented, we repair pending replyTellask* delivery
  // before handing the dialog back to the tellasker.
  if (dialogIdObj.selfId === dialogIdObj.rootId) {
    await recoverPendingReplyTellaskCallsForDialog(mainDialog);
    return mainDialog;
  }

  const sub = await ensureDialogLoaded(mainDialog, dialogIdObj, status);
  if (!sub) {
    throw new Error(`Dialog ${dialogIdObj.valueOf()} not found`);
  }
  await recoverPendingReplyTellaskCallsForDialog(sub);
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
  const latest = await refreshRunControlProjectionFromPersistenceFacts(
    dialogIdObj,
    'resume_dialog',
  );
  // WARNING:
  // Passing this gate only means "a manual Continue attempt is allowed". It does not mean the
  // dialog is guaranteed to re-enter proceeding immediately. For the paused-interjection flow, the
  // resumed drive itself performs a second fresh-fact decision and may land in true `blocked`
  // instead of proceeding.
  if (!isDialogLatestResumable(latest)) {
    const ineligible = buildResumeIneligibleMessage(latest);
    log.warn('resume_dialog rejected after fresh fact scan', undefined, {
      dialogId: dialogIdObj.valueOf(),
      displayState: latest?.displayState ?? null,
      executionMarker: latest?.executionMarker ?? null,
      resumeNotEligibleReason: ineligible.reason,
    });
    ws.send(
      JSON.stringify({
        type: 'error',
        code: 'resume_dialog_not_eligible',
        resumeNotEligibleReason: ineligible.reason,
        message: ineligible.message,
      }),
    );
    emitRunControlRefresh('resume_dialog');
    return;
  }

  const restored = await restoreDialogForDrive(dialogIdObj, 'running');
  await driveDialogStream(restored, undefined, true, {
    allowResumeFromInterrupted: true,
    source: 'ws_resume_dialog',
    reason: 'resume_dialog',
  });
  emitRunControlRefresh('resume_dialog');
}

async function handleResumeAll(ws: WebSocket, packet: ResumeAllRequest): Promise<void> {
  if (packet.type !== 'resume_all') {
    throw new Error('Internal error: handleResumeAll called with non resume_all packet');
  }
  const dialogIds = await DialogPersistence.listAllDialogIds('running');
  let resumableCount = 0;
  for (const id of dialogIds) {
    try {
      // listAllDialogIds() only gives candidate IDs. A malformed dialog can still quarantine itself
      // during lazy latest lookup here without preventing resume-all for the rest.
      const latest = await refreshRunControlProjectionFromPersistenceFacts(id, 'resume_all');
      if (!isDialogLatestResumable(latest)) continue;
      resumableCount += 1;
      void (async () => {
        try {
          const dlg = await restoreDialogForDrive(id, 'running');
          await driveDialogStream(dlg, undefined, true, {
            allowResumeFromInterrupted: true,
            source: 'ws_resume_all',
            reason: 'resume_all',
          });
        } catch (err) {
          log.warn('resume_all: failed to resume dialog', err, { dialogId: id.valueOf() });
        }
      })();
    } catch (error: unknown) {
      if (!findDomindsPersistenceFileError(error)) {
        throw error;
      }
      log.warn('resume_all: skipping malformed dialog during latest lookup', error, {
        dialogId: id.valueOf(),
      });
    }
  }
  if (resumableCount === 0) {
    ws.send(
      JSON.stringify({
        type: 'error',
        code: 'resume_all_not_eligible',
        message: 'No dialogs are currently eligible for resumption.',
      }),
    );
  }
  emitRunControlRefresh('resume_all');
}

/**
 * Receive a human reply for a Q4H question.
 * Validates questionId, clears q4h.yaml entry, records askHuman result/carryover,
 * and optionally queues a continuation drive input carrying the answered callId.
 *
 * Important: the human answer itself is canonicalized as askHuman tellask result/carryover first.
 * For cross-course Q4H answers, the carryover is the canonical latest-course context; it is not a
 * tool-result pair for the older-course askHuman call.
 * The follow-up drive input here is only control-flow glue for the resumed round, not a separate
 * persisted "user prompt" business fact.
 */
async function handleReceiveHumanReply(
  ws: WebSocket,
  packet: DriveDialogByUserAnswer,
): Promise<void> {
  try {
    const { dialog: dialogIdent, content, msgId, questionId, continuationType } = packet;
    const attachments = parseUserImageAttachments(packet.attachments);
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
    const mainDialogId = dialogIdent.rootId;

    // Validate dialog identifiers
    if (typeof dialogId !== 'string' || typeof mainDialogId !== 'string') {
      ws.send(
        JSON.stringify({
          type: 'error',
          message:
            'Invalid dialog identifiers for receiveHumanReply: selfId/rootId must be strings',
        }),
      );
      return;
    }

    const dialogIdObj = new DialogID(dialogId, mainDialogId);
    const latest = await DialogPersistence.loadDialogLatest(dialogIdObj, 'running');
    if (latest?.executionMarker?.kind === 'dead') {
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
    const preparedAttachments = prepareUserImageAttachments(attachments);

    // Restore the canonical dialog instances (main dialog + sideDialogs) to avoid duplicates.
    const mainDialog = await getOrRestoreMainDialog(dialogIdObj.rootId, 'running');
    if (!mainDialog) {
      ws.send(JSON.stringify({ type: 'error', message: `Dialog ${dialogId} not found` }));
      return;
    }
    globalDialogRegistry.register(mainDialog);

    const dialog =
      dialogIdObj.selfId === dialogIdObj.rootId
        ? mainDialog
        : await ensureDialogLoaded(mainDialog, dialogIdObj, 'running');
    if (!dialog) {
      ws.send(JSON.stringify({ type: 'error', message: `Dialog ${dialogId} not found` }));
      return;
    }
    // Ensure the requesting WebSocket receives q4h_answered and subsequent resume stream events.
    await setupWebSocketSubscription(ws, dialog);

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

    const removedQuestion = removed.removedQuestion;
    if (!removedQuestion) {
      throw new Error(
        `Q4H remove invariant violation: found=true but removedQuestion missing (rootId=${dialog.id.rootId} selfId=${dialog.id.selfId} questionId=${questionId})`,
      );
    }

    const askHumanCallId = removedQuestion.callId.trim();
    if (askHumanCallId === '') {
      throw new Error(
        `Q4H remove invariant violation: missing callId on answered question ` +
          `(rootId=${dialog.id.rootId} selfId=${dialog.id.selfId} questionId=${questionId})`,
      );
    }
    const contentItems = await persistPreparedUserImageAttachments({
      dialog,
      msgId: effectivePrompt.msgId,
      attachments: preparedAttachments,
    });
    const askHumanOriginCourse = removedQuestion.callSiteRef.course;
    const askHumanCarryoverContent = formatTellaskCarryoverResultContent({
      originCourse: askHumanOriginCourse,
      callName: 'askHuman',
      callId: removedQuestion.callId,
      responderId: 'human',
      tellaskContent: removedQuestion.tellaskContent,
      responseBody: effectivePrompt.content,
      status: 'completed',
      language: getWorkLanguage(),
    });
    const askHumanResultMirror = await dialog.receiveTellaskResponse(
      'human',
      'askHuman',
      undefined,
      removedQuestion.tellaskContent,
      'completed',
      undefined,
      {
        response: effectivePrompt.content,
        agentId: 'human',
        callId: askHumanCallId,
        originMemberId: dialog.agentId,
        originCourse: toCallingCourseNumber(askHumanOriginCourse),
        calling_genseq: removedQuestion.callSiteRef.callingGenseq,
        carryoverContent: askHumanCarryoverContent,
        contentItems,
      },
    );
    await dialog.addChatMessages(askHumanResultMirror);

    // Emit q4h_answered event for answered question
    const answeredEvent: Q4HAnsweredEvent = {
      type: 'q4h_answered',
      questionId,
      selfId: dialogId,
    };
    postDialogEvent(dialog, answeredEvent);

    const hasPendingSideDialogs = await dialog.hasPendingSideDialogs();
    if (hasPendingSideDialogs) {
      // This queued item is only the post-answer continuation input that resumes the suspended
      // round after sideDialogs settle. The human answer fact has already been persisted above as
      // askHuman tellask result/carryover and must not be reinterpreted as a new user prompt.
      dialog.queueDeferredQ4HAnswerPrompt({
        prompt: effectivePrompt.content,
        msgId: effectivePrompt.msgId,
        grammar: effectivePrompt.grammar,
        contentItems,
        userLanguageCode: effectivePrompt.userLanguageCode,
        q4hAnswerCallId: askHumanCallId,
      });
      log.debug(
        'Deferred post-Q4H continuation input until pending sideDialogs resolve',
        undefined,
        {
          rootId: dialog.id.rootId,
          selfId: dialog.id.selfId,
          questionId,
          msgId: effectivePrompt.msgId,
        },
      );
      return;
    }

    // Resume the dialog after the answer has been materialized as askHuman tellask result/carryover.
    // The continuation input carries correlation only; it does not persist another user prompt fact.
    await driveDialogStream(
      dialog,
      {
        content: effectivePrompt.content,
        ...(contentItems === undefined ? {} : { contentItems }),
        msgId: effectivePrompt.msgId,
        grammar: effectivePrompt.grammar,
        userLanguageCode: effectivePrompt.userLanguageCode,
        q4hAnswerCallId: askHumanCallId,
        origin: 'user',
      },
      true,
      {
        source: 'ws_user_answer',
        reason: 'drive_dialog_by_user_answer',
      },
    );
  } catch (error) {
    log.error('Error processing receiveHumanReply:', error);
    ws.send(
      JSON.stringify({
        type: 'error',
        message: `Failed to process human reply: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
  mode: DomindsRuntimeMode,
): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer });
  const runtimeStatusPubChan: PubChan<DomindsRuntimeStatusMessage> =
    createPubChan<DomindsRuntimeStatusMessage>();

  const broadcastToClients = (msg: WebSocketMessage): void => {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  };

  // Broadcast dialog display-state changes to all connected clients so multi-tab views converge.
  setDisplayStateBroadcaster(broadcastToClients);

  // Broadcast global dialog events to all connected clients:
  // - Q4H updates are rtws-global state in WebUI
  // - sideDialog creation must refresh hierarchy/list even when current subscription is elsewhere
  // - dlg_touched_evt keeps dialog list timestamps/reordering in sync across clients
  installGlobalDialogEventBroadcaster({
    label: 'websocket-server',
    publish: (evt) => {
      broadcastToClients(evt);
    },
  });

  // Broadcast dialog index changes (create/move/delete) so other tabs refresh their lists.
  // This ensures multi-tab/multi-browser updates stay consistent without polling.
  broadcastDialogsIndexMessage = (msg: WebSocketMessage) => {
    broadcastToClients(msg);
  };

  setPrepareDialogQuarantineHook(async ({ mainDialogId, status }) => {
    if (status !== 'running') {
      return;
    }
    markMainDialogQuarantining(mainDialogId);
    await forceStopActiveRunsForMainDialog(mainDialogId);
  });

  setFinalizeDialogQuarantineHook(({ mainDialogId, status, quarantined }) => {
    if (status !== 'running') {
      return;
    }
    if (quarantined) {
      clearMainDialogQuarantiningIfIdle(mainDialogId);
      return;
    }
    clearMainDialogQuarantining(mainDialogId);
  });

  setDialogsQuarantinedBroadcaster((msg) => {
    broadcastToClients(msg);
    if (msg.fromStatus !== 'running') {
      return;
    }
    void getRunControlCountsSnapshot()
      .then((counts) => {
        broadcastToClients({
          type: 'run_control_counts_evt',
          proceeding: counts.proceeding,
          resumable: counts.resumable,
          timestamp: formatUnifiedTimestamp(new Date()),
        });
      })
      .catch((error: unknown) => {
        log.warn('Failed to broadcast run-control counts after dialog quarantine', error, {
          rootId: msg.rootId,
          dialogId: msg.dialogId,
        });
      });
  });

  // Broadcast global run-control refresh hints so all clients converge from persisted dialog index.
  broadcastRunControlRefreshMessage = (msg: RunControlRefreshMessage) => {
    broadcastToClients(msg);
  };

  // Broadcast rtws Problems snapshots to all connected clients.
  setProblemsBroadcaster(broadcastToClients);

  // Broadcast `.minds/team.yaml` updates so multi-tab clients can refresh cached team config.
  setTeamConfigBroadcaster(broadcastToClients);
  setToolAvailabilityBroadcaster(broadcastToClients);
  setDomindsSelfUpdateBroadcaster((status) => {
    void createDomindsRuntimeStatusMessage(mode)
      .then((msg) => {
        runtimeStatusPubChan.write({
          ...msg,
          runtimeStatus: {
            ...msg.runtimeStatus,
            selfUpdate: status,
          },
        });
      })
      .catch((error: unknown) => {
        log.warn('Failed to broadcast Dominds runtime status update', error);
      });
  });
  startTeamConfigWatcher();

  httpServer.once('close', () => {
    stopTeamConfigWatcher();
    clearTeamConfigBroadcaster();
    clearToolAvailabilityBroadcaster();
    setDomindsSelfUpdateBroadcaster(null);
    setFinalizeDialogQuarantineHook(null);
    setPrepareDialogQuarantineHook(null);
    setDialogsQuarantinedBroadcaster(null);
    void wss.close();
  });

  wss.on('connection', (ws: WebSocket, req) => {
    const authCheck = getWebSocketAuthCheck(req, auth);
    if (authCheck.kind !== 'ok') {
      ws.close(4401, 'unauthorized');
      return;
    }

    wsUiLanguage.set(ws, serverWorkLanguage);
    const runtimeStatusSubChan = createSubChan(runtimeStatusPubChan);
    void (async () => {
      try {
        const runtimeStatus = await getDomindsRuntimeStatus(mode);
        ws.send(
          JSON.stringify({
            type: 'welcome',
            message: 'Connected to dialog server',
            serverWorkLanguage,
            supportedLanguageCodes: [...supportedLanguageCodes],
            runtimeStatus,
            timestamp: formatUnifiedTimestamp(new Date()),
          }),
        );
      } catch (error) {
        log.warn('Failed to send WebSocket welcome snapshot', error);
        ws.close(1011, 'welcome_failed');
        return;
      }

      clients.add(ws);

      try {
        // Send an initial snapshot so the UI can render a stable Problems indicator immediately.
        ws.send(JSON.stringify(createProblemsSnapshotMessage()));
      } catch (error) {
        log.warn('Failed to send initial problems snapshot', error);
      }

      void (async () => {
        try {
          for await (const runtimeStatusMsg of runtimeStatusSubChan.stream()) {
            ws.send(JSON.stringify(runtimeStatusMsg));
          }
        } catch (error) {
          log.warn('Failed to forward Dominds runtime status event', error);
        }
      })();

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
      runtimeStatusSubChan.cancel();
      clients.delete(ws);

      // Clean up client subscriptions
      cleanupWsClient(ws);
    });

    ws.on('error', (error) => {
      log.error('WebSocket error:', error);
      runtimeStatusSubChan.cancel();
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
