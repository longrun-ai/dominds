/**
 * Module: persistence
 *
 * Modern dialog persistence with strong typing and latest.yaml support.
 * Provides file-based storage with append-only events and atomic operations.
 */

import type { ContextHealthSnapshot } from '@longrun-ai/kernel/types/context-health';
import type {
  ContextHealthEvent,
  CourseEvent,
  FuncCallStartEvent,
  FunctionResultEvent,
  GeneratingFinishEvent,
  GeneratingStartEvent,
  MarkdownChunkEvent,
  MarkdownFinishEvent,
  MarkdownStartEvent,
  NativeToolCallEvent,
  NativeToolCallPayload,
  Q4HAnsweredEvent,
  RuntimeGuideEvent,
  StreamErrorEvent,
  SubdialogEvent,
  TellaskCallAnchorEvent,
  TellaskCallStartEvent,
  TellaskCarryoverEvent,
  TellaskResultEvent,
  ThinkingChunkEvent,
  ThinkingFinishEvent,
  ThinkingStartEvent,
  ToolResultImageIngestEvent,
  UiOnlyMarkdownEvent,
  WebSearchCallAction,
  WebSearchCallEvent,
  WebSearchCallSource,
} from '@longrun-ai/kernel/types/dialog';
import type {
  DialogInterruptionReason,
  DialogLlmRetryRecoveryAction,
} from '@longrun-ai/kernel/types/display-state';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { isLanguageCode } from '@longrun-ai/kernel/types/language';
import type {
  AgentThoughtRecord,
  AgentWordsRecord,
  DialogDeferredReplyReassertion,
  DialogFbrState,
  DialogLatestFile,
  DialogMetadataFile,
  FuncCallRecord,
  FuncResultRecord,
  HumanQuestion,
  HumanTextRecord,
  NativeToolCallRecord,
  PendingSubdialogsReconciledRecord,
  PendingSubdialogStateRecord,
  PersistedDialogRecord,
  ProviderData,
  Questions4HumanFile,
  Questions4HumanReconciledRecord,
  ReasoningPayload,
  ReconciledRecordWriteTarget,
  ReminderSnapshotItem,
  RemindersReconciledRecord,
  ReminderStateFile,
  RootDialogMetadataFile,
  RootGenerationAnchor,
  RuntimeGuideRecord,
  SubdialogCreatedRecord,
  SubdialogMetadataFile,
  SubdialogRegistryReconciledRecord,
  SubdialogRegistryStateRecord,
  SubdialogResponsesReconciledRecord,
  SubdialogResponseStateRecord,
  TellaskCallRecord,
  TellaskCallRecordName,
  TellaskCarryoverRecord,
  TellaskReplyDirective,
  TellaskReplyResolutionRecord,
  TellaskResultRecord,
  ToolResultImageIngestRecord,
  UiOnlyMarkdownRecord,
  WebSearchCallRecord,
} from '@longrun-ai/kernel/types/storage';
import {
  toCalleeCourseNumber,
  toCalleeGenerationSeqNumber,
  toCallingCourseNumber,
  toCallingGenerationSeqNumber,
  toDialogCourseNumber,
  toRootGenerationAnchor,
} from '@longrun-ai/kernel/types/storage';
import type { DialogsQuarantinedMessage, DialogStatusKind } from '@longrun-ai/kernel/types/wire';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import * as fs from 'fs';
import { randomUUID } from 'node:crypto';
import * as path from 'path';
import { WebSocket } from 'ws';
import * as yaml from 'yaml';
import type { PendingSubdialog } from './dialog';
import { Dialog, DialogID, DialogStore, RootDialog, SubDialog } from './dialog';
import { isInterruptionReasonManualResumeEligible } from './dialog-interruption';
import { postDialogEvent, postDialogEventById } from './evt-registry';
import { ChatMessage, FuncResultMsg, TellaskCarryoverMsg, TellaskResultMsg } from './llm/client';
import type { ToolResultImageIngest } from './llm/gen';
import { log } from './log';
import {
  DomindsPersistenceFileError,
  findDomindsPersistenceFileError,
  type DomindsPersistenceFileFormat,
  type DomindsPersistenceFileSource,
} from './persistence-errors';
import { AsyncFifoMutex } from './runtime/async-fifo-mutex';
import { isStandaloneRuntimeGuidePromptContent } from './runtime/reply-prompt-copy';
import { materializeReminder, Reminder } from './tool';
import { getReminderOwner } from './tools/registry';

type TellaskBusinessCallName = TellaskResultRecord['callName'];

let dialogsQuarantinedBroadcaster: ((msg: DialogsQuarantinedMessage) => void) | null = null;
let prepareDialogQuarantineHook:
  | ((args: {
      dialogId: DialogID;
      rootDialogId: DialogID;
      status: DialogStatusKind;
      reason: string;
      error: Error;
    }) => Promise<void> | void)
  | null = null;
let finalizeDialogQuarantineHook:
  | ((args: {
      dialogId: DialogID;
      rootDialogId: DialogID;
      status: DialogStatusKind;
      reason: string;
      error: Error;
      quarantined: boolean;
    }) => Promise<void> | void)
  | null = null;
const quarantiningRootDialogs = new Set<string>();
const PERSISTABLE_DIALOG_STATUSES = ['running', 'completed', 'archived'] as const;
type PersistableDialogStatus = (typeof PERSISTABLE_DIALOG_STATUSES)[number];
const RUN_STATUS_DIR = 'run';
const DONE_STATUS_DIR = 'done';
const ARCHIVE_STATUS_DIR = 'archive';

function assertPersistableDialogStatus(
  status: DialogStatusKind,
  context: string,
): PersistableDialogStatus {
  if (status === 'quarantining') {
    throw new Error(`${context} does not support status 'quarantining'`);
  }
  return status;
}

function getPersistableStatusDirName(status: DialogStatusKind, context: string): string {
  const persistableStatus = assertPersistableDialogStatus(status, context);
  if (persistableStatus === 'running') return RUN_STATUS_DIR;
  if (persistableStatus === 'completed') return DONE_STATUS_DIR;
  return ARCHIVE_STATUS_DIR;
}

export function setDialogsQuarantinedBroadcaster(
  fn: ((msg: DialogsQuarantinedMessage) => void) | null,
): void {
  dialogsQuarantinedBroadcaster = fn;
}

export function setPrepareDialogQuarantineHook(
  fn:
    | ((args: {
        dialogId: DialogID;
        rootDialogId: DialogID;
        status: DialogStatusKind;
        reason: string;
        error: Error;
      }) => Promise<void> | void)
    | null,
): void {
  prepareDialogQuarantineHook = fn;
}

export function setFinalizeDialogQuarantineHook(
  fn:
    | ((args: {
        dialogId: DialogID;
        rootDialogId: DialogID;
        status: DialogStatusKind;
        reason: string;
        error: Error;
        quarantined: boolean;
      }) => Promise<void> | void)
    | null,
): void {
  finalizeDialogQuarantineHook = fn;
}

function isTellaskBusinessCallName(value: string): value is TellaskBusinessCallName {
  return (
    value === 'tellask' ||
    value === 'tellaskSessionless' ||
    value === 'tellaskBack' ||
    value === 'askHuman' ||
    value === 'freshBootsReasoning'
  );
}

function isSuppressedTellaskPlaceholderFuncResult(args: {
  name: string;
  content: string;
}): boolean {
  if (!isTellaskBusinessCallName(args.name)) {
    return false;
  }
  const raw = args.content.trim();
  if (raw === '') {
    return false;
  }
  if (
    raw === 'Q4H 已结束等待状态，请参考 askHuman 结果气泡。' ||
    raw === 'Q4H wait is resolved; refer to the askHuman result bubble.'
  ) {
    return true;
  }
  if (
    raw.startsWith('Q4H 仍在等待人类回复，已持续 ') ||
    raw.startsWith('Q4H is still waiting for human reply (elapsed ')
  ) {
    return true;
  }
  if (
    raw.startsWith('支线对话仍在进行中，已持续 ') ||
    raw.startsWith('Sideline dialog is still running (elapsed ')
  ) {
    return true;
  }
  return false;
}

function isYamlUnexpectedEofLikeError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('unexpected eof') ||
    message.includes('unexpected end') ||
    message.includes('end of the stream') ||
    message.includes('unexpected end of document')
  );
}

function isJsonUnexpectedEofLikeError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('unterminated string in json') ||
    message.includes('unexpected end of json input') ||
    message.includes('unexpected eof')
  );
}

function buildTellaskResultRoute(
  route: TellaskResultMsg['route'],
  fallback?: {
    calleeDialogId?: string;
    calleeCourse?: number;
    calleeGenseq?: number;
  },
): TellaskResultRecord['route'] | undefined {
  const effective = route ?? fallback;
  if (!effective) return undefined;
  return {
    ...(effective.calleeDialogId ? { calleeDialogId: effective.calleeDialogId } : {}),
    ...(typeof effective.calleeCourse === 'number'
      ? { calleeCourse: toCalleeCourseNumber(effective.calleeCourse) }
      : {}),
    ...(typeof effective.calleeGenseq === 'number'
      ? { calleeGenseq: toCalleeGenerationSeqNumber(effective.calleeGenseq) }
      : {}),
  };
}

function requireNonEmptyTrimmedString(
  value: string | undefined,
  field: string,
  context: string,
): string {
  if (typeof value !== 'string') {
    throw new Error(`${context} invariant violation: missing ${field}`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error(`${context} invariant violation: empty ${field}`);
  }
  return trimmed;
}

function requireTellaskResultResponderId(result: TellaskResultMsg, context: string): string {
  return requireNonEmptyTrimmedString(
    result.responder?.responderId ?? result.responderId,
    'responderId',
    `${context} (callId=${result.callId}, callName=${result.callName})`,
  );
}

function requireTellaskResultContent(result: TellaskResultMsg, context: string): string {
  return requireNonEmptyTrimmedString(
    result.call?.tellaskContent ?? result.tellaskContent,
    'tellaskContent',
    `${context} (callId=${result.callId}, callName=${result.callName})`,
  );
}

function resolveTellaskResultMentionList(result: TellaskResultMsg, context: string): string[] {
  const mentionList = result.call?.mentionList ?? result.mentionList;
  if (mentionList === undefined) {
    return [];
  }
  if (!Array.isArray(mentionList) || mentionList.some((item) => typeof item !== 'string')) {
    throw new Error(
      `${context} invariant violation: invalid mentionList ` +
        `(callId=${result.callId}, callName=${result.callName})`,
    );
  }
  return [...mentionList];
}

function requireTellaskResultSessionSlug(result: TellaskResultMsg, context: string): string {
  return requireNonEmptyTrimmedString(
    result.call?.sessionSlug ?? result.sessionSlug,
    'sessionSlug',
    `${context} (callId=${result.callId}, callName=${result.callName})`,
  );
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === 'string' ? maybeCode : undefined;
}

function isGenericUnexpectedEofLikeError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('unexpected eof') || message.includes('unexpected end');
}

function isPersistenceFileUnexpectedEofLikeError(
  error: unknown,
  format: DomindsPersistenceFileFormat,
): boolean {
  if (format === 'yaml') {
    return isYamlUnexpectedEofLikeError(error) || isGenericUnexpectedEofLikeError(error);
  }
  if (format === 'json' || format === 'jsonl') {
    return isJsonUnexpectedEofLikeError(error) || isGenericUnexpectedEofLikeError(error);
  }
  return isGenericUnexpectedEofLikeError(error);
}

function buildInvalidPersistenceFileError(args: {
  source: DomindsPersistenceFileSource;
  format: DomindsPersistenceFileFormat;
  filePath: string;
  lineNumber?: number;
  cause?: unknown;
}): DomindsPersistenceFileError {
  return new DomindsPersistenceFileError({
    message: `Invalid ${path.basename(args.filePath)} in ${args.filePath}`,
    source: args.source,
    operation: 'parse',
    format: args.format,
    filePath: args.filePath,
    eofLike:
      args.cause === undefined
        ? false
        : isPersistenceFileUnexpectedEofLikeError(args.cause, args.format),
    ...(args.lineNumber !== undefined ? { lineNumber: args.lineNumber } : {}),
    ...(args.cause !== undefined ? { cause: args.cause } : {}),
  });
}

async function readPersistenceTextFile(args: {
  filePath: string;
  source: DomindsPersistenceFileSource;
  format: DomindsPersistenceFileFormat;
}): Promise<string> {
  try {
    return await fs.promises.readFile(args.filePath, 'utf-8');
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ENOENT') {
      throw error;
    }
    throw new DomindsPersistenceFileError({
      message: `Failed to read ${path.basename(args.filePath)} in ${args.filePath}`,
      source: args.source,
      operation: 'read',
      format: args.format,
      filePath: args.filePath,
      eofLike: isPersistenceFileUnexpectedEofLikeError(error, args.format),
      cause: error,
    });
  }
}

function parsePersistenceYaml(args: {
  content: string;
  filePath: string;
  source: DomindsPersistenceFileSource;
}): unknown {
  try {
    return yaml.parse(args.content);
  } catch (error: unknown) {
    throw buildInvalidPersistenceFileError({
      source: args.source,
      format: 'yaml',
      filePath: args.filePath,
      cause: error,
    });
  }
}

function parsePersistenceJson(args: {
  content: string;
  filePath: string;
  source: DomindsPersistenceFileSource;
  lineNumber?: number;
}): unknown {
  try {
    return JSON.parse(args.content);
  } catch (error: unknown) {
    throw buildInvalidPersistenceFileError({
      source: args.source,
      format: args.lineNumber === undefined ? 'json' : 'jsonl',
      filePath: args.filePath,
      cause: error,
      ...(args.lineNumber !== undefined ? { lineNumber: args.lineNumber } : {}),
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseDisplayTextI18n(
  value: unknown,
): Partial<Record<LanguageCode, string>> | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const parsed: Partial<Record<LanguageCode, string>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isLanguageCode(key) || typeof entry !== 'string') {
      return null;
    }
    parsed[key] = entry;
  }
  return parsed;
}

function parseDialogRetryDisplay(value: unknown): {
  titleTextI18n: Partial<Record<LanguageCode, string>>;
  summaryTextI18n: Partial<Record<LanguageCode, string>>;
} | null {
  if (!isRecord(value)) return null;
  const titleTextI18n = parseDisplayTextI18n(value.titleTextI18n);
  if (titleTextI18n === null || titleTextI18n === undefined) return null;
  const summaryTextI18n = parseDisplayTextI18n(value.summaryTextI18n);
  if (summaryTextI18n === null || summaryTextI18n === undefined) return null;
  return {
    titleTextI18n,
    summaryTextI18n,
  };
}

function parseDialogLlmRetryRecoveryAction(value: unknown): DialogLlmRetryRecoveryAction | null {
  if (value === undefined) {
    return { kind: 'none' };
  }
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  switch (value.kind) {
    case 'none':
      return { kind: 'none' };
    case 'diligence_push_once':
      return { kind: 'diligence_push_once' };
    default:
      return null;
  }
}

function parseDialogInterruptionReason(value: unknown): DialogInterruptionReason | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  switch (value.kind) {
    case 'user_stop':
      return { kind: 'user_stop' };
    case 'emergency_stop':
      return { kind: 'emergency_stop' };
    case 'server_restart':
      return { kind: 'server_restart' };
    case 'fork_continue_ready':
      return { kind: 'fork_continue_ready' };
    case 'system_stop': {
      const detail = value.detail;
      if (typeof detail !== 'string') return null;
      const i18nStopReason = parseDisplayTextI18n(value.i18nStopReason);
      if (i18nStopReason === null) return null;
      return i18nStopReason
        ? { kind: 'system_stop', detail, i18nStopReason }
        : { kind: 'system_stop', detail };
    }
    case 'llm_retry_stopped': {
      const error = value.error;
      if (typeof error !== 'string') return null;
      const display = parseDialogRetryDisplay(value.display);
      if (display === null) return null;
      const recoveryAction = parseDialogLlmRetryRecoveryAction(value.recoveryAction);
      if (recoveryAction === null) return null;
      return {
        kind: 'llm_retry_stopped',
        error,
        display,
        recoveryAction,
      };
    }
    default:
      return null;
  }
}

function resolveStoppedContinueEnabled(reason: DialogInterruptionReason): boolean {
  return isInterruptionReasonManualResumeEligible(reason);
}

function serializeReminderSnapshot(reminder: Reminder): ReminderSnapshotItem {
  return {
    id: reminder.id,
    content: reminder.content,
    ownerName: reminder.owner?.name,
    meta: reminder.meta,
    echoback: reminder.echoback,
    scope: reminder.scope ?? 'dialog',
    createdAt: reminder.createdAt ?? formatUnifiedTimestamp(new Date()),
    priority: reminder.priority ?? 'medium',
  };
}

function cloneReminderSnapshot(snapshot: ReminderSnapshotItem): ReminderSnapshotItem {
  return {
    id: snapshot.id,
    content: snapshot.content,
    ownerName: snapshot.ownerName,
    meta: snapshot.meta,
    echoback: snapshot.echoback,
    scope: snapshot.scope,
    createdAt: snapshot.createdAt,
    priority: snapshot.priority,
  };
}

function cloneRootGenerationAnchor(anchor: RootGenerationAnchor): RootGenerationAnchor {
  return {
    rootCourse: anchor.rootCourse,
    rootGenseq: anchor.rootGenseq,
  };
}

function buildFuncCallRecord(args: {
  id: string;
  name: string;
  rawArgumentsText: string;
  genseq: number;
}): FuncCallRecord {
  return {
    ts: formatUnifiedTimestamp(new Date()),
    type: 'func_call_record',
    genseq: args.genseq,
    id: args.id,
    name: args.name,
    rawArgumentsText: args.rawArgumentsText,
  };
}

function buildFuncResultRecord(funcResult: FuncResultMsg, genseq: number): FuncResultRecord {
  return {
    ts: formatUnifiedTimestamp(new Date()),
    type: 'func_result_record',
    id: funcResult.id,
    name: funcResult.name,
    content: funcResult.content,
    contentItems: funcResult.contentItems,
    genseq,
  };
}

function buildToolResultImageIngestRecord(
  ingest: ToolResultImageIngest,
  genseq: number,
): ToolResultImageIngestRecord {
  return {
    ts: formatUnifiedTimestamp(new Date()),
    type: 'tool_result_image_ingest_record',
    genseq,
    toolCallId: ingest.toolCallId,
    toolName: ingest.toolName,
    artifact: ingest.artifact,
    provider: ingest.provider,
    model: ingest.model,
    disposition: ingest.disposition,
    message: ingest.message,
    detail: ingest.detail,
  };
}

function buildTellaskCallRecord(args: {
  id: string;
  name: TellaskCallRecordName;
  rawArgumentsText: string;
  genseq: number;
  deliveryMode: 'tellask_call_start' | 'func_call_requested';
}): TellaskCallRecord {
  return {
    ts: formatUnifiedTimestamp(new Date()),
    type: 'tellask_call_record' as const,
    genseq: args.genseq,
    id: args.id,
    name: args.name,
    rawArgumentsText: args.rawArgumentsText,
    deliveryMode: args.deliveryMode,
  };
}

function buildTellaskResultRecord(result: TellaskResultMsg, genseq: number): TellaskResultRecord {
  if (!isTellaskBusinessCallName(result.callName)) {
    throw new Error(
      `buildTellaskResultRecord invariant violation: ${result.callName} is not a tellask business result`,
    );
  }
  const responderId = requireTellaskResultResponderId(result, 'buildTellaskResultRecord');
  const tellaskContent = requireTellaskResultContent(result, 'buildTellaskResultRecord');
  const route = buildTellaskResultRoute(result.route, {
    calleeDialogId: result.calleeDialogId,
    calleeCourse: result.calleeCourse,
    calleeGenseq: result.calleeGenseq,
  });
  const base = {
    ts: formatUnifiedTimestamp(new Date()),
    type: 'tellask_result_record' as const,
    genseq,
    callId: result.callId,
    status: result.status,
    content: result.content,
    ...(typeof result.calling_genseq === 'number'
      ? { calling_genseq: toCallingGenerationSeqNumber(result.calling_genseq) }
      : {}),
    responder: {
      responderId,
      ...((result.responder?.agentId ?? result.agentId)
        ? { agentId: result.responder?.agentId ?? result.agentId }
        : {}),
      ...((result.responder?.originMemberId ?? result.originMemberId)
        ? { originMemberId: result.responder?.originMemberId ?? result.originMemberId }
        : {}),
    },
    ...(route ? { route } : {}),
  };
  switch (result.callName) {
    case 'tellask':
      return {
        ...base,
        callName: result.callName,
        call: {
          tellaskContent,
          mentionList: resolveTellaskResultMentionList(result, 'buildTellaskResultRecord'),
          sessionSlug: requireTellaskResultSessionSlug(result, 'buildTellaskResultRecord'),
        },
      };
    case 'tellaskSessionless':
      return {
        ...base,
        callName: result.callName,
        call: {
          tellaskContent,
          mentionList: resolveTellaskResultMentionList(result, 'buildTellaskResultRecord'),
        },
      };
    case 'tellaskBack':
    case 'askHuman':
    case 'freshBootsReasoning':
      return {
        ...base,
        callName: result.callName,
        call: {
          tellaskContent,
        },
      };
  }
}

function buildTellaskCarryoverRecord(
  result: TellaskCarryoverMsg,
  genseq: number,
): TellaskCarryoverRecord {
  return {
    ts: formatUnifiedTimestamp(new Date()),
    type: 'tellask_carryover_record',
    genseq,
    originCourse: toCallingCourseNumber(result.originCourse),
    carryoverCourse: toDialogCourseNumber(result.carryoverCourse),
    responderId: result.responderId,
    callName: result.callName,
    tellaskContent: result.tellaskContent,
    status: result.status,
    response: result.response,
    content: result.content,
    agentId: result.agentId,
    callId: result.callId,
    originMemberId: result.originMemberId,
    ...(result.callName === 'tellask'
      ? {
          sessionSlug: result.sessionSlug,
          mentionList: result.mentionList,
        }
      : result.callName === 'tellaskSessionless'
        ? {
            mentionList: result.mentionList,
          }
        : {}),
    ...(result.calleeDialogId ? { calleeDialogId: result.calleeDialogId } : {}),
    ...(typeof result.calleeCourse === 'number' ? { calleeCourse: result.calleeCourse } : {}),
    ...(typeof result.calleeGenseq === 'number' ? { calleeGenseq: result.calleeGenseq } : {}),
  } as TellaskCarryoverRecord;
}

function buildTellaskResultEvent(result: TellaskResultMsg, course: number): TellaskResultEvent {
  if (!isTellaskBusinessCallName(result.callName)) {
    throw new Error(
      `buildTellaskResultEvent invariant violation: ${result.callName} is not a tellask business result`,
    );
  }
  const responderId = requireTellaskResultResponderId(result, 'buildTellaskResultEvent');
  const tellaskContent = requireTellaskResultContent(result, 'buildTellaskResultEvent');
  const route = buildTellaskResultRoute(result.route, {
    calleeDialogId: result.calleeDialogId,
    calleeCourse: result.calleeCourse,
    calleeGenseq: result.calleeGenseq,
  });
  if (result.callName === 'tellask') {
    const effectiveSessionSlug = requireTellaskResultSessionSlug(result, 'buildTellaskResultEvent');
    return {
      type: 'tellask_result_evt',
      course,
      genseq: result.genseq,
      calling_genseq:
        typeof result.calling_genseq === 'number'
          ? toCallingGenerationSeqNumber(result.calling_genseq)
          : undefined,
      callId: result.callId,
      callName: result.callName,
      status: result.status,
      content: result.content,
      call: {
        tellaskContent,
        mentionList: resolveTellaskResultMentionList(result, 'buildTellaskResultEvent'),
        sessionSlug: effectiveSessionSlug,
      },
      responder: {
        responderId,
        ...((result.responder?.agentId ?? result.agentId)
          ? { agentId: result.responder?.agentId ?? result.agentId }
          : {}),
        ...((result.responder?.originMemberId ?? result.originMemberId)
          ? { originMemberId: result.responder?.originMemberId ?? result.originMemberId }
          : {}),
      },
      ...(route ? { route } : {}),
    };
  }

  if (result.callName === 'tellaskSessionless') {
    return {
      type: 'tellask_result_evt',
      course,
      genseq: result.genseq,
      calling_genseq:
        typeof result.calling_genseq === 'number'
          ? toCallingGenerationSeqNumber(result.calling_genseq)
          : undefined,
      callId: result.callId,
      callName: result.callName,
      status: result.status,
      content: result.content,
      call: {
        tellaskContent,
        mentionList: resolveTellaskResultMentionList(result, 'buildTellaskResultEvent'),
      },
      responder: {
        responderId,
        ...((result.responder?.agentId ?? result.agentId)
          ? { agentId: result.responder?.agentId ?? result.agentId }
          : {}),
        ...((result.responder?.originMemberId ?? result.originMemberId)
          ? { originMemberId: result.responder?.originMemberId ?? result.originMemberId }
          : {}),
      },
      ...(route ? { route } : {}),
    };
  }

  return {
    type: 'tellask_result_evt',
    course,
    genseq: result.genseq,
    calling_genseq:
      typeof result.calling_genseq === 'number'
        ? toCallingGenerationSeqNumber(result.calling_genseq)
        : undefined,
    callId: result.callId,
    callName: result.callName as 'tellaskBack' | 'askHuman' | 'freshBootsReasoning',
    status: result.status,
    content: result.content,
    call: {
      tellaskContent,
    },
    responder: {
      responderId,
      ...((result.responder?.agentId ?? result.agentId)
        ? { agentId: result.responder?.agentId ?? result.agentId }
        : {}),
      ...((result.responder?.originMemberId ?? result.originMemberId)
        ? { originMemberId: result.responder?.originMemberId ?? result.originMemberId }
        : {}),
    },
    ...(route ? { route } : {}),
  };
}

function buildTellaskCarryoverEvent(
  result: TellaskCarryoverMsg,
  course: number,
): TellaskCarryoverEvent {
  if (result.callName === 'tellask') {
    const sessionSlug = result.sessionSlug?.trim();
    if (!sessionSlug) {
      throw new Error(
        `buildTellaskCarryoverEvent invariant violation: missing sessionSlug for tellask call ${result.callId}`,
      );
    }
    return {
      type: 'tellask_carryover_evt',
      course,
      genseq: result.genseq,
      originCourse: toCallingCourseNumber(result.originCourse),
      carryoverCourse: toDialogCourseNumber(result.carryoverCourse),
      responderId: result.responderId,
      callName: result.callName,
      sessionSlug,
      mentionList: result.mentionList ?? [],
      tellaskContent: result.tellaskContent,
      status: result.status,
      response: result.response,
      content: result.content,
      agentId: result.agentId,
      callId: result.callId,
      originMemberId: result.originMemberId,
      ...(result.calleeDialogId ? { calleeDialogId: result.calleeDialogId } : {}),
      ...(typeof result.calleeCourse === 'number'
        ? { calleeCourse: toCalleeCourseNumber(result.calleeCourse) }
        : {}),
      ...(typeof result.calleeGenseq === 'number'
        ? { calleeGenseq: toCalleeGenerationSeqNumber(result.calleeGenseq) }
        : {}),
    };
  }
  if (result.callName === 'tellaskSessionless') {
    return {
      type: 'tellask_carryover_evt',
      course,
      genseq: result.genseq,
      originCourse: toCallingCourseNumber(result.originCourse),
      carryoverCourse: toDialogCourseNumber(result.carryoverCourse),
      responderId: result.responderId,
      callName: result.callName,
      mentionList: result.mentionList ?? [],
      tellaskContent: result.tellaskContent,
      status: result.status,
      response: result.response,
      content: result.content,
      agentId: result.agentId,
      callId: result.callId,
      originMemberId: result.originMemberId,
      ...(result.calleeDialogId ? { calleeDialogId: result.calleeDialogId } : {}),
      ...(typeof result.calleeCourse === 'number'
        ? { calleeCourse: toCalleeCourseNumber(result.calleeCourse) }
        : {}),
      ...(typeof result.calleeGenseq === 'number'
        ? { calleeGenseq: toCalleeGenerationSeqNumber(result.calleeGenseq) }
        : {}),
    };
  }
  return {
    type: 'tellask_carryover_evt',
    course,
    genseq: result.genseq,
    originCourse: toCallingCourseNumber(result.originCourse),
    carryoverCourse: toDialogCourseNumber(result.carryoverCourse),
    responderId: result.responderId,
    callName: result.callName,
    tellaskContent: result.tellaskContent,
    status: result.status,
    response: result.response,
    content: result.content,
    agentId: result.agentId,
    callId: result.callId,
    originMemberId: result.originMemberId,
    ...(result.calleeDialogId ? { calleeDialogId: result.calleeDialogId } : {}),
    ...(typeof result.calleeCourse === 'number'
      ? { calleeCourse: toCalleeCourseNumber(result.calleeCourse) }
      : {}),
    ...(typeof result.calleeGenseq === 'number'
      ? { calleeGenseq: toCalleeGenerationSeqNumber(result.calleeGenseq) }
      : {}),
  };
}

function formatTellaskCallArguments(record: TellaskCallRecord): string {
  return record.rawArgumentsText;
}

function isReplyTellaskCallRecordName(
  name: TellaskCallRecord['name'],
): name is 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack' {
  return (
    name === 'replyTellask' || name === 'replyTellaskSessionless' || name === 'replyTellaskBack'
  );
}

function resolveRootGenerationAnchor(dialog: Dialog): RootGenerationAnchor {
  const rootDialog = dialog instanceof SubDialog ? dialog.rootDialog : dialog;
  return toRootGenerationAnchor({
    rootCourse: rootDialog.currentCourse,
    rootGenseq: rootDialog.activeGenSeqOrUndefined ?? 0,
  });
}

function resolveReconciledRecordWriteTarget(dialog: Dialog): ReconciledRecordWriteTarget {
  return {
    kind: 'dialog_course',
    rootAnchor: resolveRootGenerationAnchor(dialog),
    dialogCourse: toDialogCourseNumber(dialog.activeGenCourseOrUndefined ?? dialog.currentCourse),
  };
}

function rootAnchorWriteTarget(rootAnchor: RootGenerationAnchor): ReconciledRecordWriteTarget {
  return {
    kind: 'root_anchor',
    rootAnchor,
  };
}

function resolveTargetCourseFromWriteTarget(writeTarget: ReconciledRecordWriteTarget): number {
  if (writeTarget.kind === 'dialog_course') {
    return writeTarget.dialogCourse;
  }
  return writeTarget.rootAnchor.rootCourse;
}

function attachRootGenerationRef<T extends PersistedDialogRecord>(dialog: Dialog, record: T): T {
  const anchor = resolveRootGenerationAnchor(dialog);
  return {
    ...record,
    rootCourse: anchor.rootCourse,
    rootGenseq: anchor.rootGenseq,
  };
}

function isRootDialogMetadataFile(value: unknown): value is RootDialogMetadataFile {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (typeof value.agentId !== 'string') return false;
  if (typeof value.taskDocPath !== 'string') return false;
  if (typeof value.createdAt !== 'string') return false;
  if (value.supdialogId !== undefined) return false;
  if (value.sessionSlug !== undefined) return false;
  if (value.assignmentFromSup !== undefined) return false;
  if (value.priming !== undefined) {
    if (!isRecord(value.priming)) return false;
    if (!Array.isArray(value.priming.scriptRefs)) return false;
    if (!value.priming.scriptRefs.every((item) => typeof item === 'string')) return false;
    if (typeof value.priming.showInUi !== 'boolean') return false;
  }
  return true;
}

function isSubdialogMetadataFile(value: unknown): value is SubdialogMetadataFile {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (typeof value.agentId !== 'string') return false;
  if (typeof value.taskDocPath !== 'string') return false;
  if (typeof value.createdAt !== 'string') return false;
  if (typeof value.supdialogId !== 'string') return false;
  if (value.priming !== undefined) return false;
  if (value.sessionSlug !== undefined && typeof value.sessionSlug !== 'string') return false;
  const assignment = value.assignmentFromSup;
  if (!isRecord(assignment)) return false;
  if (typeof assignment.tellaskContent !== 'string') return false;
  if (typeof assignment.originMemberId !== 'string') return false;
  if (typeof assignment.callerDialogId !== 'string') return false;
  if (typeof assignment.callId !== 'string') return false;
  if (assignment.collectiveTargets !== undefined) {
    if (!Array.isArray(assignment.collectiveTargets)) return false;
    if (!assignment.collectiveTargets.every((item) => typeof item === 'string')) return false;
  }
  if (assignment.effectiveFbrEffort !== undefined) {
    if (
      typeof assignment.effectiveFbrEffort !== 'number' ||
      !Number.isInteger(assignment.effectiveFbrEffort)
    ) {
      return false;
    }
    if (assignment.effectiveFbrEffort < 1 || assignment.effectiveFbrEffort > 100) {
      return false;
    }
  }

  switch (assignment.callName) {
    case 'tellask':
    case 'tellaskSessionless': {
      if (!Array.isArray(assignment.mentionList)) return false;
      if (assignment.mentionList.length < 1) return false;
      if (!assignment.mentionList.every((item) => typeof item === 'string')) return false;
      if (assignment.effectiveFbrEffort !== undefined) return false;
      break;
    }
    case 'freshBootsReasoning': {
      if (assignment.mentionList !== undefined) return false;
      if (assignment.effectiveFbrEffort === undefined) return false;
      break;
    }
    default:
      return false;
  }
  return true;
}

function isDialogMetadataFile(value: unknown): value is DialogMetadataFile {
  return isRootDialogMetadataFile(value) || isSubdialogMetadataFile(value);
}

function parseDialogLatestFile(value: unknown): DialogLatestFile | null {
  if (!isRecord(value)) return null;

  if (typeof value.currentCourse !== 'number') return null;
  const currentCourse = value.currentCourse;

  if (typeof value.lastModified !== 'string') return null;
  if (value.status !== 'active' && value.status !== 'completed' && value.status !== 'archived')
    return null;
  if (value.disableDiligencePush !== undefined && typeof value.disableDiligencePush !== 'boolean')
    return null;
  if (
    value.diligencePushRemainingBudget !== undefined &&
    typeof value.diligencePushRemainingBudget !== 'number'
  )
    return null;
  if (value.messageCount !== undefined && typeof value.messageCount !== 'number') return null;
  if (value.functionCallCount !== undefined && typeof value.functionCallCount !== 'number')
    return null;
  if (value.subdialogCount !== undefined && typeof value.subdialogCount !== 'number') return null;
  if (value.generating !== undefined && typeof value.generating !== 'boolean') return null;
  if (value.needsDrive !== undefined && typeof value.needsDrive !== 'boolean') return null;

  const displayStateRaw = (value as Record<string, unknown>).displayState;
  const displayState: DialogLatestFile['displayState'] | null = (() => {
    if (displayStateRaw === undefined) return undefined;
    if (!isRecord(displayStateRaw)) return null;
    if (typeof displayStateRaw.kind !== 'string') return null;
    const kind = displayStateRaw.kind;
    if (kind === 'idle_waiting_user') return { kind: 'idle_waiting_user' } as const;
    if (kind === 'proceeding') return { kind: 'proceeding' } as const;
    if (kind === 'proceeding_stop_requested') {
      const reason = displayStateRaw.reason;
      if (reason !== 'user_stop' && reason !== 'emergency_stop') return null;
      return { kind: 'proceeding_stop_requested', reason } as const;
    }
    if (kind === 'stopped') {
      const reason = parseDialogInterruptionReason(displayStateRaw.reason);
      if (reason === null) return null;
      const continueEnabled =
        typeof displayStateRaw.continueEnabled === 'boolean'
          ? displayStateRaw.continueEnabled
          : resolveStoppedContinueEnabled(reason);
      return { kind: 'stopped', reason, continueEnabled } as const;
    }
    if (kind === 'blocked') {
      const reason = displayStateRaw.reason;
      if (!isRecord(reason) || typeof reason.kind !== 'string') return null;
      switch (reason.kind) {
        case 'needs_human_input':
          return { kind: 'blocked', reason: { kind: 'needs_human_input' } } as const;
        case 'waiting_for_subdialogs':
          return { kind: 'blocked', reason: { kind: 'waiting_for_subdialogs' } } as const;
        case 'needs_human_input_and_subdialogs':
          return { kind: 'blocked', reason: { kind: 'needs_human_input_and_subdialogs' } } as const;
        default:
          return null;
      }
    }
    if (kind === 'dead') {
      const reason = displayStateRaw.reason;
      if (!isRecord(reason) || typeof reason.kind !== 'string') return null;
      switch (reason.kind) {
        case 'declared_by_user':
          return { kind: 'dead', reason: { kind: 'declared_by_user' } } as const;
        case 'system': {
          const detail = (reason as Record<string, unknown>).detail;
          if (typeof detail !== 'string') return null;
          return { kind: 'dead', reason: { kind: 'system', detail } } as const;
        }
        default:
          return null;
      }
    }
    return null;
  })();
  if (displayState === null) return null;

  const executionMarkerRaw = (value as Record<string, unknown>).executionMarker;
  const executionMarker: DialogLatestFile['executionMarker'] | null = (() => {
    if (executionMarkerRaw === undefined) return undefined;
    if (!isRecord(executionMarkerRaw) || typeof executionMarkerRaw.kind !== 'string') return null;
    switch (executionMarkerRaw.kind) {
      case 'interrupted': {
        const reason = parseDialogInterruptionReason(executionMarkerRaw.reason);
        if (reason === null) return null;
        return { kind: 'interrupted', reason } as const;
      }
      case 'dead': {
        const reason = executionMarkerRaw.reason;
        if (!isRecord(reason) || typeof reason.kind !== 'string') return null;
        switch (reason.kind) {
          case 'declared_by_user':
            return { kind: 'dead', reason: { kind: 'declared_by_user' } } as const;
          case 'system': {
            const detail = (reason as Record<string, unknown>).detail;
            if (typeof detail !== 'string') return null;
            return { kind: 'dead', reason: { kind: 'system', detail } } as const;
          }
          default:
            return null;
        }
      }
      default:
        return null;
    }
  })();
  if (executionMarker === null) return null;

  const fbrStateRaw = (value as Record<string, unknown>).fbrState;
  const fbrState: DialogFbrState | null | undefined = (() => {
    if (fbrStateRaw === undefined) return undefined;
    if (!isRecord(fbrStateRaw)) return null;
    if (fbrStateRaw.kind !== 'serial') return null;
    if (typeof fbrStateRaw.effort !== 'number' || !Number.isInteger(fbrStateRaw.effort)) {
      return null;
    }
    if (fbrStateRaw.effort < 1) return null;
    const phase = fbrStateRaw.phase;
    if (phase !== 'divergence' && phase !== 'convergence' && phase !== 'finalization') {
      return null;
    }
    if (typeof fbrStateRaw.iteration !== 'number' || !Number.isInteger(fbrStateRaw.iteration)) {
      return null;
    }
    if (fbrStateRaw.iteration < 1 || fbrStateRaw.iteration > fbrStateRaw.effort) {
      return null;
    }
    if (typeof fbrStateRaw.promptDelivered !== 'boolean') return null;
    return {
      kind: 'serial',
      effort: fbrStateRaw.effort,
      phase,
      iteration: fbrStateRaw.iteration,
      promptDelivered: fbrStateRaw.promptDelivered,
    };
  })();
  if (fbrState === null) return null;

  const deferredReplyReassertionRaw = (value as Record<string, unknown>).deferredReplyReassertion;
  const deferredReplyReassertion: DialogDeferredReplyReassertion | null | undefined = (() => {
    if (deferredReplyReassertionRaw === undefined) return undefined;
    if (!isRecord(deferredReplyReassertionRaw)) return null;
    if (deferredReplyReassertionRaw.reason !== 'user_interjection_with_parked_original_task') {
      return null;
    }
    const directiveRaw = deferredReplyReassertionRaw.directive;
    if (!isRecord(directiveRaw)) return null;
    const resumeGuideSurfacedRaw = deferredReplyReassertionRaw.resumeGuideSurfaced;
    if (resumeGuideSurfacedRaw !== undefined && typeof resumeGuideSurfacedRaw !== 'boolean') {
      return null;
    }
    const expectedReplyCallName = directiveRaw.expectedReplyCallName;
    const targetCallId = directiveRaw.targetCallId;
    const tellaskContent = directiveRaw.tellaskContent;
    if (
      expectedReplyCallName !== 'replyTellask' &&
      expectedReplyCallName !== 'replyTellaskSessionless' &&
      expectedReplyCallName !== 'replyTellaskBack'
    ) {
      return null;
    }
    if (typeof targetCallId !== 'string' || typeof tellaskContent !== 'string') {
      return null;
    }
    if (expectedReplyCallName === 'replyTellaskBack') {
      const targetDialogId = directiveRaw.targetDialogId;
      if (typeof targetDialogId !== 'string') return null;
      return {
        reason: 'user_interjection_with_parked_original_task',
        directive: {
          expectedReplyCallName,
          targetCallId,
          targetDialogId,
          tellaskContent,
        },
        ...(resumeGuideSurfacedRaw === undefined
          ? {}
          : { resumeGuideSurfaced: resumeGuideSurfacedRaw }),
      };
    }
    return {
      reason: 'user_interjection_with_parked_original_task',
      directive: {
        expectedReplyCallName,
        targetCallId,
        tellaskContent,
      },
      ...(resumeGuideSurfacedRaw === undefined
        ? {}
        : { resumeGuideSurfaced: resumeGuideSurfacedRaw }),
    };
  })();
  if (deferredReplyReassertion === null) return null;

  return {
    currentCourse,
    lastModified: value.lastModified,
    messageCount: value.messageCount,
    functionCallCount: value.functionCallCount,
    subdialogCount: value.subdialogCount,
    status: value.status,
    generating: value.generating,
    needsDrive: value.needsDrive,
    displayState,
    executionMarker,
    fbrState,
    deferredReplyReassertion,
    disableDiligencePush: value.disableDiligencePush,
    diligencePushRemainingBudget: value.diligencePushRemainingBudget,
  };
}

function isSubdialogResponseRecord(value: unknown): value is SubdialogResponseStateRecord {
  if (!isRecord(value)) return false;
  if (typeof value.responseId !== 'string') return false;
  if (typeof value.subdialogId !== 'string') return false;
  if (typeof value.response !== 'string') return false;
  if (typeof value.completedAt !== 'string') return false;
  if (value.status !== undefined && value.status !== 'completed' && value.status !== 'failed')
    return false;
  if (value.callType !== 'A' && value.callType !== 'B' && value.callType !== 'C') return false;
  if (
    value.callName !== 'tellaskBack' &&
    value.callName !== 'tellask' &&
    value.callName !== 'tellaskSessionless' &&
    value.callName !== 'freshBootsReasoning'
  ) {
    return false;
  }
  switch (value.callName) {
    case 'tellask':
    case 'tellaskSessionless':
      if (!Array.isArray(value.mentionList)) return false;
      if (!value.mentionList.every((item) => typeof item === 'string')) return false;
      if (value.mentionList.length < 1) return false;
      break;
    case 'tellaskBack':
    case 'freshBootsReasoning':
      if (value.mentionList !== undefined) return false;
      break;
  }
  if (typeof value.tellaskContent !== 'string') return false;
  if (typeof value.responderId !== 'string') return false;
  if (typeof value.originMemberId !== 'string') return false;
  if (typeof value.callId !== 'string') return false;
  return true;
}

function isReminderPriority(value: unknown): value is 'high' | 'medium' | 'low' {
  return value === 'high' || value === 'medium' || value === 'low';
}

function isReminderScope(value: unknown): value is 'dialog' | 'personal' | 'agent_shared' {
  return value === 'dialog' || value === 'personal' || value === 'agent_shared';
}

function isReminderStateFile(value: unknown): value is ReminderStateFile {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.reminders)) return false;
  if (typeof value.updatedAt !== 'string') return false;
  return value.reminders.every((entry) => {
    if (!isRecord(entry)) return false;
    if (typeof entry.id !== 'string') return false;
    if (typeof entry.content !== 'string') return false;
    if (entry.ownerName !== undefined && typeof entry.ownerName !== 'string') return false;
    if (entry.echoback !== undefined && typeof entry.echoback !== 'boolean') return false;
    if (entry.scope !== undefined && !isReminderScope(entry.scope)) return false;
    if (typeof entry.createdAt !== 'string') return false;
    if (!isReminderPriority(entry.priority)) return false;
    return true;
  });
}

function isHumanQuestion(value: unknown): value is HumanQuestion {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (typeof value.tellaskContent !== 'string') return false;
  if (typeof value.askedAt !== 'string') return false;
  if (typeof value.callId !== 'string') return false;
  if (!isRecord(value.callSiteRef)) return false;
  if (typeof value.callSiteRef.course !== 'number') return false;
  if (typeof value.callSiteRef.messageIndex !== 'number') return false;
  return true;
}

function isQuestions4HumanFile(value: unknown): value is Questions4HumanFile {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.questions)) return false;
  if (typeof value.updatedAt !== 'string') return false;
  return value.questions.every(isHumanQuestion);
}

export interface DialogPersistenceState {
  metadata: DialogMetadataFile;
  currentCourse: number;
  messages: ChatMessage[];
  reminders: Reminder[];
  contextHealth?: ContextHealthSnapshot;
}

export interface Questions4Human {
  course: number;
  questions: HumanQuestion[];
  createdAt: string;
  updatedAt: string;
}

// Remove old type definitions - now using kernel/types/storage.ts
import { generateDialogID } from './utils/id';

type ReplayTellaskCall =
  | Readonly<{
      callName: 'tellaskBack';
      tellaskContent: string;
      callId: string;
    }>
  | Readonly<{
      callName: 'tellask';
      mentionList: string[];
      sessionSlug: string;
      tellaskContent: string;
      callId: string;
    }>
  | Readonly<{
      callName: 'tellaskSessionless';
      mentionList: string[];
      tellaskContent: string;
      callId: string;
    }>
  | Readonly<{
      callName: 'askHuman';
      tellaskContent: string;
      callId: string;
    }>
  | Readonly<{
      callName: 'freshBootsReasoning';
      tellaskContent: string;
      callId: string;
    }>;

function parseReplayTellaskCall(record: TellaskCallRecord): ReplayTellaskCall | null {
  if (record.deliveryMode !== 'tellask_call_start') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.rawArgumentsText);
  } catch (error: unknown) {
    throw new Error(
      `persisted tellask rawArgumentsText is not valid JSON for replay (callId=${record.id}, name=${record.name}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `persisted tellask rawArgumentsText must decode to an object for replay (callId=${record.id}, name=${record.name})`,
    );
  }
  const args = parsed as Record<string, unknown>;
  switch (record.name) {
    case 'tellaskBack': {
      const tellaskContent = args['tellaskContent'];
      if (typeof tellaskContent !== 'string' || tellaskContent.trim() === '') {
        throw new Error(`persisted tellaskBack missing tellaskContent (callId=${record.id})`);
      }
      return {
        callName: 'tellaskBack',
        tellaskContent,
        callId: record.id,
      };
    }
    case 'askHuman': {
      const tellaskContent = args['tellaskContent'];
      if (typeof tellaskContent !== 'string' || tellaskContent.trim() === '') {
        throw new Error(`persisted askHuman missing tellaskContent (callId=${record.id})`);
      }
      return {
        callName: 'askHuman',
        tellaskContent,
        callId: record.id,
      };
    }
    case 'freshBootsReasoning': {
      const tellaskContent = args['tellaskContent'];
      if (typeof tellaskContent !== 'string' || tellaskContent.trim() === '') {
        throw new Error(
          `persisted freshBootsReasoning missing tellaskContent (callId=${record.id})`,
        );
      }
      return {
        callName: 'freshBootsReasoning',
        tellaskContent,
        callId: record.id,
      };
    }
    case 'tellask': {
      const targetAgentId = args['targetAgentId'];
      const sessionSlug = args['sessionSlug'];
      const tellaskContent = args['tellaskContent'];
      if (typeof targetAgentId !== 'string' || targetAgentId.trim() === '') {
        throw new Error(`persisted tellask missing targetAgentId (callId=${record.id})`);
      }
      if (typeof sessionSlug !== 'string' || sessionSlug.trim() === '') {
        throw new Error(`persisted tellask missing sessionSlug (callId=${record.id})`);
      }
      if (typeof tellaskContent !== 'string' || tellaskContent.trim() === '') {
        throw new Error(`persisted tellask missing tellaskContent (callId=${record.id})`);
      }
      return {
        callName: 'tellask',
        mentionList: [`@${targetAgentId}`],
        sessionSlug,
        tellaskContent,
        callId: record.id,
      };
    }
    case 'tellaskSessionless': {
      const targetAgentId = args['targetAgentId'];
      const tellaskContent = args['tellaskContent'];
      if (typeof targetAgentId !== 'string' || targetAgentId.trim() === '') {
        throw new Error(`persisted tellaskSessionless missing targetAgentId (callId=${record.id})`);
      }
      if (typeof tellaskContent !== 'string' || tellaskContent.trim() === '') {
        throw new Error(
          `persisted tellaskSessionless missing tellaskContent (callId=${record.id})`,
        );
      }
      return {
        callName: 'tellaskSessionless',
        mentionList: [`@${targetAgentId}`],
        tellaskContent,
        callId: record.id,
      };
    }
    case 'replyTellask':
    case 'replyTellaskSessionless':
    case 'replyTellaskBack':
      return null;
    default:
      return null;
  }
}

function isTellaskCallFunctionName(name: string): name is TellaskCallRecordName {
  return (
    name === 'tellaskBack' ||
    name === 'tellask' ||
    name === 'tellaskSessionless' ||
    name === 'replyTellask' ||
    name === 'replyTellaskSessionless' ||
    name === 'replyTellaskBack' ||
    name === 'askHuman' ||
    name === 'freshBootsReasoning'
  );
}

/**
 * Uses append-only pattern for events, exceptional overwrite for reminders
 */
export class DiskFileDialogStore extends DialogStore {
  private readonly dialogId: DialogID;

  constructor(dialogId: DialogID) {
    super();
    this.dialogId = dialogId;
  }

  // === DialogStore interface methods (for compatibility) ===

  /**
   * Create subdialog with automatic persistence
   */
  public async createSubDialog(
    callerDialog: Dialog,
    targetAgentId: string,
    mentionList: string[] | undefined,
    tellaskContent: string,
    options: {
      callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
      originMemberId: string;
      callerDialogId: string;
      callId: string;
      sessionSlug?: string;
      collectiveTargets?: string[];
      effectiveFbrEffort?: number;
    },
  ): Promise<SubDialog> {
    const generatedId = generateDialogID();
    const nowTs = formatUnifiedTimestamp(new Date());
    const rootDialog =
      callerDialog instanceof RootDialog
        ? callerDialog
        : callerDialog instanceof SubDialog
          ? callerDialog.rootDialog
          : (() => {
              throw new Error(
                `createSubDialog invariant violation: unsupported caller dialog type (${callerDialog.constructor.name})`,
              );
            })();
    const subdialogId = new DialogID(generatedId, rootDialog.id.rootId);

    // Prepare subdialog store
    const subdialogStore = new DiskFileDialogStore(subdialogId);
    const subdialog = new SubDialog(
      subdialogStore,
      rootDialog,
      callerDialog.taskDocPath,
      subdialogId,
      targetAgentId,
      {
        callName: options.callName,
        mentionList,
        tellaskContent,
        originMemberId: options.originMemberId,
        callerDialogId: options.callerDialogId,
        callId: options.callId,
        collectiveTargets: options.collectiveTargets,
        effectiveFbrEffort: options.effectiveFbrEffort,
      },
      options.sessionSlug,
    );

    // Initial subdialog user prompt is now persisted at first drive (driver.ts)

    // Ensure subdialog directory and persist metadata under supdialog/.subdialogs/
    await this.ensureSubdialogDirectory(subdialogId);
    const metadata: SubdialogMetadataFile = {
      id: subdialogId.selfId,
      agentId: targetAgentId,
      taskDocPath: callerDialog.taskDocPath,
      createdAt: nowTs,
      supdialogId: callerDialog.id.selfId,
      sessionSlug: options.sessionSlug,
      assignmentFromSup: {
        callName: options.callName,
        mentionList,
        tellaskContent,
        originMemberId: options.originMemberId,
        callerDialogId: options.callerDialogId,
        callId: options.callId,
        collectiveTargets: options.collectiveTargets,
        effectiveFbrEffort: options.effectiveFbrEffort,
      },
    };
    await DialogPersistence.saveSubdialogMetadata(subdialogId, metadata);

    const rootAnchor = resolveRootGenerationAnchor(callerDialog);
    const parentCourse = callerDialog.activeGenCourseOrUndefined ?? callerDialog.currentCourse;
    const subdialogCreatedRecord: SubdialogCreatedRecord = {
      ts: nowTs,
      type: 'subdialog_created_record',
      ...cloneRootGenerationAnchor(rootAnchor),
      subdialogId: subdialogId.selfId,
      supdialogId: callerDialog.id.selfId,
      agentId: targetAgentId,
      taskDocPath: callerDialog.taskDocPath,
      createdAt: nowTs,
      sessionSlug: options.sessionSlug,
      assignmentFromSup: {
        callName: options.callName,
        mentionList,
        tellaskContent,
        originMemberId: options.originMemberId,
        callerDialogId: options.callerDialogId,
        callId: options.callId,
        collectiveTargets: options.collectiveTargets,
        effectiveFbrEffort: options.effectiveFbrEffort,
      },
    };
    await this.appendEvent(callerDialog, parentCourse, subdialogCreatedRecord);

    // Initialize latest.yaml via the mutation API (write-back will flush).
    await DialogPersistence.mutateDialogLatest(subdialogId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 1,
        lastModified: nowTs,
        status: 'active',
        messageCount: 0,
        functionCallCount: 0,
        subdialogCount: 0,
        displayState: { kind: 'idle_waiting_user' },
        disableDiligencePush: false,
      },
    }));

    // Supdialog clarification context is persisted in subdialog metadata (supdialogCall)

    const subdialogCreatedEvt: SubdialogEvent = {
      type: 'subdialog_created_evt',
      dialog: {
        selfId: subdialogId.selfId,
        rootId: subdialogId.rootId,
      },
      timestamp: new Date().toISOString(),
      course: parentCourse,
      parentDialog: {
        selfId: callerDialog.id.selfId,
        rootId: callerDialog.id.rootId,
      },
      subDialog: {
        selfId: subdialogId.selfId,
        rootId: subdialogId.rootId,
      },
      targetAgentId,
      callName: options.callName,
      mentionList,
      tellaskContent,
      subDialogNode: {
        selfId: subdialogId.selfId,
        rootId: subdialogId.rootId,
        supdialogId: callerDialog.id.selfId,
        agentId: targetAgentId,
        taskDocPath: callerDialog.taskDocPath,
        status: 'running',
        currentCourse: 1,
        createdAt: nowTs,
        lastModified: nowTs,
        displayState: { kind: 'idle_waiting_user' },
        sessionSlug: options.sessionSlug,
        assignmentFromSup: {
          callName: options.callName,
          mentionList,
          tellaskContent,
          originMemberId: options.originMemberId,
          callerDialogId: options.callerDialogId,
          callId: options.callId,
          effectiveFbrEffort: options.effectiveFbrEffort,
        },
      },
    };
    // Post subdialog_created_evt to PARENT's PubChan so frontend can receive it
    // The frontend subscribes to the parent's events, not the subdialog's
    postDialogEvent(callerDialog, subdialogCreatedEvt);

    return subdialog;
  }

  /**
   * Receive and handle function call results (includes logging)
   */
  public async receiveFuncResult(dialog: Dialog, funcResult: FuncResultMsg): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const genseq = dialog.activeGenSeqOrUndefined ?? funcResult.genseq;
    if (!Number.isFinite(genseq) || genseq <= 0) {
      throw new Error(
        `receiveFuncResult invariant violation: missing valid genseq for func result ${funcResult.id}`,
      );
    }
    const existingFuncResult = await this.findExistingFuncResultRecord(dialog, funcResult.id);
    if (existingFuncResult) {
      await this.raiseDuplicateCallResultInvariantViolation({
        dialog,
        kind: 'func_result',
        callId: funcResult.id,
        callName: funcResult.name,
        incomingCourse: course,
        incomingGenseq: genseq,
        existingCourse: existingFuncResult.course,
        existingGenseq: existingFuncResult.record.genseq,
      });
    }
    const funcResultRecord = buildFuncResultRecord(funcResult, genseq);
    await this.appendEvent(dialog, course, funcResultRecord);

    // Send event to frontend
    if (
      !isSuppressedTellaskPlaceholderFuncResult({
        name: funcResult.name,
        content: funcResult.content,
      })
    ) {
      const funcResultEvt: FunctionResultEvent = {
        type: 'func_result_evt',
        id: funcResult.id,
        name: funcResult.name,
        content: funcResult.content,
        contentItems: funcResult.contentItems,
        course,
        genseq,
      };
      postDialogEvent(dialog, funcResultEvt);
    }
  }

  public async receiveTellaskResult(dialog: Dialog, result: TellaskResultMsg): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const genseq = dialog.activeGenSeqOrUndefined ?? result.genseq;
    if (!Number.isFinite(genseq) || genseq <= 0) {
      throw new Error(
        `receiveTellaskResult invariant violation: missing valid genseq for tellask result ${result.callId}`,
      );
    }
    const normalizedResult =
      genseq === result.genseq
        ? result
        : {
            ...result,
            genseq,
          };
    const existingTellaskResult = await this.findExistingTellaskResultRecord(
      dialog,
      normalizedResult.callId,
    );
    if (existingTellaskResult) {
      await this.raiseDuplicateCallResultInvariantViolation({
        dialog,
        kind: 'tellask_result',
        callId: normalizedResult.callId,
        callName: normalizedResult.callName,
        incomingCourse: course,
        incomingGenseq: genseq,
        existingCourse: existingTellaskResult.course,
        existingGenseq: existingTellaskResult.record.genseq,
      });
    }
    const record = buildTellaskResultRecord(normalizedResult, genseq);
    await this.appendEvent(dialog, course, record);
    postDialogEvent(dialog, buildTellaskResultEvent(normalizedResult, course));
  }

  public async receiveTellaskCarryover(dialog: Dialog, result: TellaskCarryoverMsg): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const genseq = dialog.activeGenSeqOrUndefined ?? result.genseq;
    if (!Number.isFinite(genseq) || genseq <= 0) {
      throw new Error(
        `receiveTellaskCarryover invariant violation: missing valid genseq for tellask carryover ${result.callId}`,
      );
    }
    const normalizedResult =
      genseq === result.genseq
        ? result
        : {
            ...result,
            genseq,
          };
    await this.appendEvent(dialog, course, buildTellaskCarryoverRecord(normalizedResult, genseq));
    postDialogEvent(dialog, buildTellaskCarryoverEvent(normalizedResult, course));
  }

  /**
   * Ensure subdialog directory exists (delegate to DialogPersistence)
   */
  private async ensureSubdialogDirectory(dialogId: DialogID): Promise<string> {
    return await DialogPersistence.ensureSubdialogDirectory(dialogId);
  }

  private async findExistingFuncResultRecord(
    dialog: Dialog,
    callId: string,
  ): Promise<
    | {
        course: number;
        record: FuncResultRecord;
      }
    | undefined
  > {
    const latest = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
    const maxCourse = latest?.currentCourse ?? dialog.currentCourse;
    for (let course = 1; course <= maxCourse; course += 1) {
      const events = await DialogPersistence.loadCourseEvents(dialog.id, course, dialog.status);
      for (const event of events) {
        if (event.type !== 'func_result_record') {
          continue;
        }
        if (event.id !== callId) {
          continue;
        }
        return { course, record: event };
      }
    }
    return undefined;
  }

  private async findExistingTellaskResultRecord(
    dialog: Dialog,
    callId: string,
  ): Promise<
    | {
        course: number;
        record: TellaskResultRecord;
      }
    | undefined
  > {
    const latest = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
    const maxCourse = latest?.currentCourse ?? dialog.currentCourse;
    for (let course = 1; course <= maxCourse; course += 1) {
      const events = await DialogPersistence.loadCourseEvents(dialog.id, course, dialog.status);
      for (const event of events) {
        if (event.type !== 'tellask_result_record') {
          continue;
        }
        if (event.callId !== callId) {
          continue;
        }
        return { course, record: event };
      }
    }
    return undefined;
  }

  private async raiseDuplicateCallResultInvariantViolation(args: {
    dialog: Dialog;
    kind: 'func_result' | 'tellask_result';
    callId: string;
    callName: string;
    incomingCourse: number;
    incomingGenseq: number;
    existingCourse: number;
    existingGenseq: number;
  }): Promise<never> {
    // Duplicate final results are not harmless transcript noise. They mean two different program
    // paths both believed they owned the same business-level completion fact for one callId.
    // In ask-back flows this usually points to identity confusion between requester/responder or
    // canonical reply-tool delivery versus another mistaken write path. We fail fast here so the
    // second writer keeps its own stack trace instead of silently corrupting the dialog transcript.
    const err = new Error(
      `${args.kind} duplicate callId invariant violation: rootId=${args.dialog.id.rootId} selfId=${args.dialog.id.selfId} ` +
        `callId=${args.callId} callName=${args.callName} existingCourse=${args.existingCourse} ` +
        `existingGenseq=${args.existingGenseq} incomingCourse=${args.incomingCourse} incomingGenseq=${args.incomingGenseq}`,
    );
    log.error('Duplicate call result detected; rejecting second write', err, {
      rootId: args.dialog.id.rootId,
      selfId: args.dialog.id.selfId,
      callId: args.callId,
      callName: args.callName,
      kind: args.kind,
      existingCourse: args.existingCourse,
      existingGenseq: args.existingGenseq,
      incomingCourse: args.incomingCourse,
      incomingGenseq: args.incomingGenseq,
    });
    try {
      await this.streamError(args.dialog, err.message);
    } catch (streamErr) {
      log.warn('Failed to emit stream_error_evt for duplicate call result', streamErr, {
        rootId: args.dialog.id.rootId,
        selfId: args.dialog.id.selfId,
        callId: args.callId,
        callName: args.callName,
        kind: args.kind,
      });
    }
    throw err;
  }

  /**
   * Append event to course JSONL file (delegate to DialogPersistence)
   */
  private async appendEvent(
    dialog: Dialog,
    course: number,
    event: PersistedDialogRecord,
  ): Promise<void> {
    await DialogPersistence.appendEvent(
      this.dialogId,
      course,
      attachRootGenerationRef(dialog, event),
    );
  }

  private async appendEvents(
    dialog: Dialog,
    course: number,
    events: readonly PersistedDialogRecord[],
  ): Promise<void> {
    await DialogPersistence.appendEvents(
      this.dialogId,
      course,
      events.map((event) => attachRootGenerationRef(dialog, event)),
    );
  }

  /**
   * Notify start of LLM generation for frontend bubble management
   * CRITICAL: This must be called BEFORE any substream events (thinking_start, markdown_start, etc.)
   * to ensure proper event ordering on the frontend.
   */
  public async notifyGeneratingStart(dialog: Dialog, msgId?: string): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const genseq = dialog.activeGenSeq;
    try {
      const ev: PersistedDialogRecord = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'gen_start_record',
        genseq: genseq,
      };
      await this.appendEvent(dialog, course, ev);

      // Emit generating_start_evt event
      // This event MUST be emitted and processed before any substream events
      // to ensure the frontend has created the generation bubble before receiving
      // thinking/markdown/calling events
      const genStartEvt: GeneratingStartEvent = {
        type: 'generating_start_evt',
        course,
        genseq: genseq,
        msgId: typeof msgId === 'string' && msgId.trim() !== '' ? msgId : undefined,
      };
      postDialogEvent(dialog, genStartEvt);

      // Update generating flag in latest.yaml
      await DialogPersistence.mutateDialogLatest(this.dialogId, () => ({
        kind: 'patch',
        patch: { generating: true },
      }));
    } catch (err) {
      log.warn('Failed to persist gen_start event', err);
    }
  }

  /**
   * Notify end of LLM generation for frontend bubble management
   */
  public async notifyGeneratingFinish(
    dialog: Dialog,
    contextHealth?: ContextHealthSnapshot,
    llmGenModel?: string,
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const genseq = dialog.activeGenSeq;
    if (genseq === undefined) {
      throw new Error('Missing active genseq for notifyGeneratingFinish');
    }
    try {
      const ev: PersistedDialogRecord = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'gen_finish_record',
        genseq: genseq,
        contextHealth,
        llmGenModel,
      };
      await this.appendEvent(dialog, course, ev);

      // Emit generating_finish_evt event (this was missing, causing double triggering issue)
      const genFinishEvt: GeneratingFinishEvent = {
        type: 'generating_finish_evt',
        course,
        genseq: genseq,
        llmGenModel,
      };
      postDialogEvent(dialog, genFinishEvt);

      if (contextHealth) {
        const ctxEvt: ContextHealthEvent = {
          type: 'context_health_evt',
          course,
          genseq,
          contextHealth,
        };
        postDialogEvent(dialog, ctxEvt);
      }

      // Update generating flag in latest.yaml
      await DialogPersistence.mutateDialogLatest(this.dialogId, () => ({
        kind: 'patch',
        patch: { generating: false },
      }));
    } catch (err) {
      log.warn('Failed to persist gen_finish event', err);
    }
  }

  // Track saying/thinking content for persistence

  private sayingContent: string = '';
  private thinkingContent: string = '';
  private thinkingReasoning: ReasoningPayload | undefined = undefined;

  public async sayingStart(dialog: Dialog): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    // Reset saying content tracker
    this.sayingContent = '';
    const evt: MarkdownStartEvent = {
      type: 'markdown_start_evt',
      course,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, evt);
  }
  public async sayingChunk(dialog: Dialog, chunk: string): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    // Collect saying content for persistence
    this.sayingContent += chunk;
    const evt: MarkdownChunkEvent = {
      type: 'markdown_chunk_evt',
      chunk,
      course,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, evt);
  }
  public async sayingFinish(dialog: Dialog): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const sayingContent = this.sayingContent;
    // Persist saying content as a message event
    if (sayingContent) {
      const sayingMessageEvent: AgentWordsRecord = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'agent_words_record',
        genseq: dialog.activeGenSeq,
        content: sayingContent,
      };
      await this.appendEvent(dialog, course, sayingMessageEvent);
    }
    const evt: MarkdownFinishEvent = {
      type: 'markdown_finish_evt',
      course,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, evt);
  }

  public async thinkingStart(dialog: Dialog): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    // Reset thinking content tracker
    this.thinkingContent = '';
    this.thinkingReasoning = undefined;
    const thinkingStartEvt: ThinkingStartEvent = {
      type: 'thinking_start_evt',
      course,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, thinkingStartEvt);
  }
  public async thinkingChunk(dialog: Dialog, chunk: string): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    // Collect thinking content for persistence
    this.thinkingContent += chunk;
    const thinkingChunkEvt: ThinkingChunkEvent = {
      type: 'thinking_chunk_evt',
      chunk,
      course,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, thinkingChunkEvt);
  }
  public async thinkingFinish(dialog: Dialog, reasoning?: ReasoningPayload): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    // Persist thinking content as a message event
    if (reasoning) this.thinkingReasoning = reasoning;
    const thinkingContent = this.thinkingContent;
    if (thinkingContent || this.thinkingReasoning) {
      const thinkingMessageEvent: AgentThoughtRecord = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'agent_thought_record',
        genseq: dialog.activeGenSeq,
        content: thinkingContent,
        reasoning: this.thinkingReasoning,
      };
      await this.appendEvent(dialog, course, thinkingMessageEvent);
    }
    const thinkingFinishEvt: ThinkingFinishEvent = {
      type: 'thinking_finish_evt',
      course,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, thinkingFinishEvt);
  }

  public async markdownStart(dialog: Dialog): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const markdownStartEvt: MarkdownStartEvent = {
      type: 'markdown_start_evt',
      course,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, markdownStartEvt);
  }
  public async markdownChunk(dialog: Dialog, chunk: string): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const evt: MarkdownChunkEvent = {
      type: 'markdown_chunk_evt',
      chunk,
      course,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, evt);
  }
  public async markdownFinish(dialog: Dialog): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const evt: MarkdownFinishEvent = {
      type: 'markdown_finish_evt',
      course,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, evt);
  }

  // Tellask-special call lifecycle methods
  public async callingStart(
    dialog: Dialog,
    payload: {
      callName:
        | 'tellaskBack'
        | 'tellask'
        | 'tellaskSessionless'
        | 'askHuman'
        | 'freshBootsReasoning';
      callId: string;
      mentionList?: string[];
      sessionSlug?: string;
      tellaskContent: string;
    },
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const evt: TellaskCallStartEvent = (() => {
      switch (payload.callName) {
        case 'tellask':
          if (!payload.sessionSlug || payload.sessionSlug.trim() === '') {
            throw new Error(
              `callingStart invariant violation: tellask requires sessionSlug (callId=${payload.callId})`,
            );
          }
          return {
            type: 'tellask_call_start_evt',
            callName: payload.callName,
            callId: payload.callId,
            mentionList: payload.mentionList ?? [],
            sessionSlug: payload.sessionSlug,
            tellaskContent: payload.tellaskContent,
            course,
            genseq: dialog.activeGenSeq,
          };
        case 'tellaskSessionless':
          return {
            type: 'tellask_call_start_evt',
            callName: payload.callName,
            callId: payload.callId,
            mentionList: payload.mentionList ?? [],
            tellaskContent: payload.tellaskContent,
            course,
            genseq: dialog.activeGenSeq,
          };
        case 'tellaskBack':
        case 'askHuman':
        case 'freshBootsReasoning':
          return {
            type: 'tellask_call_start_evt',
            callName: payload.callName,
            callId: payload.callId,
            tellaskContent: payload.tellaskContent,
            course,
            genseq: dialog.activeGenSeq,
          };
      }
    })();
    postDialogEvent(dialog, evt);
  }

  // Function call events (non-streaming mode - single event captures entire call)
  public async funcCallRequested(
    dialog: Dialog,
    funcId: string,
    funcName: string,
    argumentsStr: string,
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const funcCallEvt: FuncCallStartEvent = {
      type: 'func_call_requested_evt',
      funcId,
      funcName,
      arguments: argumentsStr,
      course,
      genseq: dialog.activeGenSeq,
    };
    postDialogEvent(dialog, funcCallEvt);
  }

  public async webSearchCall(
    dialog: Dialog,
    payload: {
      source?: WebSearchCallSource;
      phase: 'added' | 'done';
      itemId: string;
      status?: string;
      action?: WebSearchCallAction;
    },
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const itemId = payload.itemId.trim();
    if (itemId === '') {
      log.error(
        'Protocol violation: webSearchCall called with empty itemId; dropping event',
        new Error('web_search_call_empty_item_id'),
        { dialog, phase: payload.phase, status: payload.status, action: payload.action },
      );
      return;
    }

    const record: WebSearchCallRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'web_search_call_record',
      genseq: dialog.activeGenSeq,
      source: payload.source,
      phase: payload.phase,
      itemId,
      status: payload.status,
      action: payload.action,
    };
    await this.appendEvent(dialog, course, record);

    const evt: WebSearchCallEvent = {
      type: 'web_search_call_evt',
      course,
      genseq: dialog.activeGenSeq,
      source: payload.source,
      phase: payload.phase,
      itemId,
      status: payload.status,
      action: payload.action,
    };
    postDialogEvent(dialog, evt);
  }

  public async nativeToolCall(dialog: Dialog, payload: NativeToolCallPayload): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const itemId =
      'itemId' in payload && typeof payload.itemId === 'string' ? payload.itemId.trim() : undefined;
    let record: NativeToolCallRecord;
    let evt: NativeToolCallEvent;
    if (payload.itemType === 'custom_tool_call') {
      const callId = payload.callId.trim();
      if (callId === '') {
        log.error(
          'Protocol violation: custom nativeToolCall called without callId; dropping event',
          new Error('native_tool_call_empty_call_id'),
          {
            dialog,
            itemType: payload.itemType,
            phase: payload.phase,
            itemId: payload.itemId,
            status: payload.status,
          },
        );
        return;
      }
      if (itemId !== undefined && itemId === '') {
        log.error(
          'Protocol violation: custom nativeToolCall called with empty optional itemId; dropping event',
          new Error('native_tool_call_empty_optional_item_id'),
          {
            dialog,
            itemType: payload.itemType,
            phase: payload.phase,
            callId,
            status: payload.status,
          },
        );
        return;
      }
      record = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'native_tool_call_record',
        genseq: dialog.activeGenSeq,
        source: payload.source,
        itemType: payload.itemType,
        phase: payload.phase,
        callId,
        ...(itemId !== undefined && itemId !== '' ? { itemId } : {}),
        status: payload.status,
        title: payload.title,
        summary: payload.summary,
        detail: payload.detail,
      };
      evt = {
        type: 'native_tool_call_evt',
        course,
        genseq: dialog.activeGenSeq,
        source: payload.source,
        itemType: payload.itemType,
        phase: payload.phase,
        callId,
        ...(itemId !== undefined && itemId !== '' ? { itemId } : {}),
        status: payload.status,
        title: payload.title,
        summary: payload.summary,
        detail: payload.detail,
      };
    } else {
      if ('callId' in payload) {
        log.error(
          'Protocol violation: non-custom nativeToolCall called with unexpected callId; dropping event',
          new Error('native_tool_call_unexpected_call_id'),
          {
            dialog,
            itemType: payload.itemType,
            phase: payload.phase,
            status: payload.status,
          },
        );
        return;
      }
      if (itemId === undefined || itemId === '') {
        log.error(
          'Protocol violation: non-custom nativeToolCall called without itemId; dropping event',
          new Error('native_tool_call_empty_item_id'),
          {
            dialog,
            itemType: payload.itemType,
            phase: payload.phase,
            status: payload.status,
          },
        );
        return;
      }
      record = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'native_tool_call_record',
        genseq: dialog.activeGenSeq,
        source: payload.source,
        itemType: payload.itemType,
        phase: payload.phase,
        itemId,
        status: payload.status,
        title: payload.title,
        summary: payload.summary,
        detail: payload.detail,
      };
      evt = {
        type: 'native_tool_call_evt',
        course,
        genseq: dialog.activeGenSeq,
        source: payload.source,
        itemType: payload.itemType,
        phase: payload.phase,
        itemId,
        status: payload.status,
        title: payload.title,
        summary: payload.summary,
        detail: payload.detail,
      };
    }
    await this.appendEvent(dialog, course, record);
    postDialogEvent(dialog, evt);
  }

  public async toolResultImageIngest(
    dialog: Dialog,
    payload: ToolResultImageIngest,
  ): Promise<void> {
    // This is an attempt-scoped projection diagnostic, not a durable semantic fact about the
    // transcript. We append it immediately so live UIs can explain the current request shape, and
    // rely on generation rollback + genseq_discard_evt to erase failed attempts.
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const toolCallId = payload.toolCallId.trim();
    const toolName = payload.toolName.trim();
    const model = payload.model.trim();
    const provider = payload.provider.trim();
    const relPath = payload.artifact.relPath.trim();
    if (toolCallId === '') {
      log.error(
        'Protocol violation: toolResultImageIngest called with empty toolCallId; dropping event',
        new Error('tool_result_image_ingest_empty_tool_call_id'),
        { dialog, payload },
      );
      return;
    }
    if (toolName === '') {
      log.error(
        'Protocol violation: toolResultImageIngest called with empty toolName; dropping event',
        new Error('tool_result_image_ingest_empty_tool_name'),
        { dialog, payload },
      );
      return;
    }
    if (provider === '' || model === '') {
      log.error(
        'Protocol violation: toolResultImageIngest missing provider/model; dropping event',
        new Error('tool_result_image_ingest_missing_provider_or_model'),
        { dialog, payload },
      );
      return;
    }
    if (relPath === '') {
      log.error(
        'Protocol violation: toolResultImageIngest called with empty artifact relPath; dropping event',
        new Error('tool_result_image_ingest_empty_rel_path'),
        { dialog, payload },
      );
      return;
    }

    const normalizedPayload: ToolResultImageIngest = {
      toolCallId,
      toolName,
      artifact: {
        rootId: payload.artifact.rootId,
        selfId: payload.artifact.selfId,
        status: payload.artifact.status,
        relPath,
      },
      provider,
      model,
      disposition: payload.disposition,
      message: payload.message,
      ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
    };

    const record = buildToolResultImageIngestRecord(normalizedPayload, dialog.activeGenSeq);
    await this.appendEvent(dialog, course, record);

    const evt: ToolResultImageIngestEvent = {
      type: 'tool_result_image_ingest_evt',
      course,
      genseq: dialog.activeGenSeq,
      toolCallId,
      toolName,
      artifact: normalizedPayload.artifact,
      provider,
      model,
      disposition: normalizedPayload.disposition,
      message: normalizedPayload.message,
      ...(normalizedPayload.detail !== undefined ? { detail: normalizedPayload.detail } : {}),
    };
    postDialogEvent(dialog, evt);
  }

  /**
   * Emit stream error for current generation lifecycle (uses active genseq when present)
   */
  public async streamError(dialog: Dialog, error: string): Promise<void> {
    log.error(`Dialog stream error '${error}'`, new Error(), { dialog });

    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const genseq = dialog.activeGenSeqOrUndefined;

    // Enhanced stream error event with better error classification
    const streamErrorEvent: StreamErrorEvent = {
      type: 'stream_error_evt',
      course,
      genseq,
      error,
    };

    postDialogEvent(dialog, streamErrorEvent);
  }

  /**
   * Start new course (append-only JSONL + exceptional reminder persistence)
   */
  public async startNewCourse(dialog: Dialog, _newCoursePrompt: string): Promise<void> {
    const previousCourse = dialog.currentCourse;
    const newCourse = previousCourse + 1;

    // Persist reminders state for new course (exceptional overwrite)
    // Use the currently attached dialog's reminders to avoid stale state
    await this.persistReminders(dialog, dialog.reminders || []);

    // Update latest.yaml with new course (lastModified is set by persistence layer)
    await DialogPersistence.mutateDialogLatest(this.dialogId, () => ({
      kind: 'patch',
      patch: { currentCourse: newCourse },
    }));

    // Post course update event
    const courseUpdateEvt: CourseEvent = {
      type: 'course_update',
      course: newCourse,
      totalCourses: newCourse,
    };
    postDialogEvent(dialog, courseUpdateEvt);
  }

  /**
   * Persist reminder state (exceptional overwrite pattern)
   * Note: Event emission is handled by processReminderUpdates() in Dialog
   */
  public async persistReminders(dialog: Dialog, reminders: Reminder[]): Promise<void> {
    await DialogPersistence._saveReminderState(this.dialogId, reminders);
    await DialogPersistence.appendRemindersReconciledRecord(
      this.dialogId,
      reminders,
      resolveReconciledRecordWriteTarget(dialog),
      dialog.status,
    );
  }

  /**
   * Persist a user message to storage
   * Note: The end_of_user_saying_evt is emitted by the driver after user content
   * is rendered and any tellask calls are parsed/executed.
   */
  public async persistUserMessage(
    dialog: Dialog,
    content: string,
    msgId: string,
    grammar: 'markdown',
    origin: 'user' | 'diligence_push' | 'runtime' | undefined,
    userLanguageCode?: LanguageCode,
    q4hAnswerCallId?: string,
    tellaskReplyDirective?: TellaskReplyDirective,
  ): Promise<void> {
    const course = dialog.currentCourse;
    // Use activeGenSeqOrUndefined to handle case when genseq hasn't been initialized yet
    const genseq = dialog.activeGenSeqOrUndefined ?? 1;
    const normalizedQ4HAnswerCallId =
      typeof q4hAnswerCallId === 'string' && q4hAnswerCallId.trim() !== ''
        ? q4hAnswerCallId.trim()
        : undefined;

    // `q4hAnswerCallId` marks continuation glue for a resumed round after askHuman is answered.
    // The canonical answer fact is persisted separately in tellask result/carryover records.
    const humanEv: HumanTextRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'human_text_record',
      genseq: genseq,
      content: String(content || ''),
      msgId: msgId,
      grammar,
      origin,
      userLanguageCode,
      q4hAnswerCallId: normalizedQ4HAnswerCallId,
      tellaskReplyDirective,
    };
    await this.appendEvent(dialog, course, humanEv);

    // Note: end_of_user_saying_evt is now emitted by llm/driver.ts after tellask calls complete
  }

  public async appendTellaskReplyResolution(
    dialog: Dialog,
    payload: {
      callId: string;
      replyCallName: 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack';
      targetCallId: string;
    },
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const genseq = dialog.activeGenSeqOrUndefined ?? 1;
    const record: TellaskReplyResolutionRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'tellask_reply_resolution_record',
      genseq,
      callId: payload.callId,
      replyCallName: payload.replyCallName,
      targetCallId: payload.targetCallId,
    };
    await this.appendEvent(dialog, course, record);
    const deferredReplyReassertion = await DialogPersistence.getDeferredReplyReassertion(
      dialog.id,
      dialog.status,
    );
    if (deferredReplyReassertion?.directive.targetCallId === payload.targetCallId) {
      await DialogPersistence.setDeferredReplyReassertion(dialog.id, undefined, dialog.status);
    }
  }

  /**
   * Persist an assistant message to storage
   */
  public async persistAgentMessage(
    dialog: Dialog,
    content: string,
    genseq: number,
    type: 'thinking_msg' | 'saying_msg',
    provider_data?: ProviderData,
    reasoning?: ReasoningPayload,
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;

    const event: AgentThoughtRecord | AgentWordsRecord =
      type === 'thinking_msg'
        ? {
            ts: formatUnifiedTimestamp(new Date()),
            type: 'agent_thought_record',
            genseq,
            content: content || '',
            reasoning,
            provider_data,
          }
        : {
            ts: formatUnifiedTimestamp(new Date()),
            type: 'agent_words_record',
            genseq,
            content: content || '',
          };

    await this.appendEvent(dialog, course, event);
  }

  public async persistUiOnlyMarkdown(
    dialog: Dialog,
    content: string,
    genseq: number,
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const ev: UiOnlyMarkdownRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'ui_only_markdown_record',
      genseq,
      content: content || '',
    };
    await this.appendEvent(dialog, course, ev);
  }

  public async persistRuntimeGuide(dialog: Dialog, content: string, genseq: number): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const ev: RuntimeGuideRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'runtime_guide_record',
      genseq,
      content: content || '',
    };
    await this.appendEvent(dialog, course, ev);
  }

  /**
   * Persist a function call to storage
   */
  public async persistFunctionCall(
    dialog: Dialog,
    id: string,
    name: string,
    rawArgumentsText: string,
    genseq: number,
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const funcCallEvent = buildFuncCallRecord({ id, name, rawArgumentsText, genseq });

    await this.appendEvent(dialog, course, funcCallEvent);

    // NOTE: func_call_evt REMOVED - persistence uses FuncCallRecord directly
    // UI display uses func_call_requested_evt instead
  }

  public async persistTellaskCall(
    dialog: Dialog,
    id: string,
    name:
      | 'tellaskBack'
      | 'tellask'
      | 'tellaskSessionless'
      | 'replyTellask'
      | 'replyTellaskSessionless'
      | 'replyTellaskBack'
      | 'askHuman'
      | 'freshBootsReasoning',
    rawArgumentsText: string,
    genseq: number,
    options?: {
      deliveryMode?: 'tellask_call_start' | 'func_call_requested';
    },
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const tellaskCallEvent = buildTellaskCallRecord({
      id,
      name,
      rawArgumentsText,
      genseq,
      deliveryMode:
        options?.deliveryMode ??
        (isReplyTellaskCallRecordName(name) ? 'func_call_requested' : 'tellask_call_start'),
    });

    await this.appendEvent(dialog, course, tellaskCallEvent);

    if (isReplyTellaskCallRecordName(name)) {
      const funcCallEvt: FuncCallStartEvent = {
        type: 'func_call_requested_evt',
        funcId: id,
        funcName: name,
        arguments: formatTellaskCallArguments(tellaskCallEvent),
        course,
        genseq: dialog.activeGenSeqOrUndefined ?? genseq,
      };
      postDialogEvent(dialog, funcCallEvt);
    }
  }

  public async persistFunctionCallResultPair(
    dialog: Dialog,
    id: string,
    name: string,
    rawArgumentsText: string,
    genseq: number,
    result: FuncResultMsg,
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const resultGenseq = dialog.activeGenSeqOrUndefined ?? result.genseq;
    if (!Number.isFinite(resultGenseq) || resultGenseq <= 0) {
      throw new Error(
        `persistFunctionCallResultPair invariant violation: missing valid genseq for func result ${result.id}`,
      );
    }
    await this.appendEvents(dialog, course, [
      buildFuncCallRecord({ id, name, rawArgumentsText, genseq }),
      buildFuncResultRecord(result, resultGenseq),
    ]);

    if (
      !isSuppressedTellaskPlaceholderFuncResult({
        name: result.name,
        content: result.content,
      })
    ) {
      const funcResultEvt: FunctionResultEvent = {
        type: 'func_result_evt',
        id: result.id,
        name: result.name,
        content: result.content,
        contentItems: result.contentItems,
        course,
        genseq,
      };
      postDialogEvent(dialog, funcResultEvt);
    }
  }

  public async persistTellaskCallResultPair(
    dialog: Dialog,
    args: {
      id: string;
      name: TellaskCallRecordName;
      rawArgumentsText: string;
      genseq: number;
      result: TellaskResultMsg | FuncResultMsg;
      deliveryMode: 'tellask_call_start' | 'func_call_requested';
    },
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const resultGenseq = dialog.activeGenSeqOrUndefined ?? args.result.genseq;
    if (!Number.isFinite(resultGenseq) || resultGenseq <= 0) {
      throw new Error(
        `persistTellaskCallResultPair invariant violation: missing valid genseq for tellask result ${
          args.result.type === 'func_result_msg' ? args.result.id : args.result.callId
        }`,
      );
    }
    const callRecord = buildTellaskCallRecord({
      id: args.id,
      name: args.name,
      rawArgumentsText: args.rawArgumentsText,
      genseq: args.genseq,
      deliveryMode: args.deliveryMode,
    });
    if (args.result.type === 'func_result_msg') {
      await this.appendEvents(dialog, course, [
        callRecord,
        buildFuncResultRecord(args.result, resultGenseq),
      ]);

      if (
        !isSuppressedTellaskPlaceholderFuncResult({
          name: args.result.name,
          content: args.result.content,
        })
      ) {
        const funcResultEvt: FunctionResultEvent = {
          type: 'func_result_evt',
          id: args.result.id,
          name: args.result.name,
          content: args.result.content,
          contentItems: args.result.contentItems,
          course,
          genseq: resultGenseq,
        };
        postDialogEvent(dialog, funcResultEvt);
      }
      return;
    }

    await this.appendEvents(dialog, course, [
      callRecord,
      buildTellaskResultRecord(args.result, resultGenseq),
    ]);
    postDialogEvent(dialog, buildTellaskResultEvent(args.result, course));
  }

  /**
   * Update questions for human state (exceptional overwrite pattern)
   */
  public async updateQuestions4Human(dialog: Dialog, questions: HumanQuestion[]): Promise<void> {
    await DialogPersistence._saveQuestions4HumanState(this.dialogId, questions);
    await DialogPersistence.appendQuestions4HumanReconciledRecord(
      this.dialogId,
      questions,
      resolveReconciledRecordWriteTarget(dialog),
      dialog.status,
    );
  }

  /**
   * Load Questions for Human state from storage
   */
  public async loadQuestions4Human(
    dialogId: DialogID,
    status: DialogStatusKind,
  ): Promise<HumanQuestion[]> {
    return await DialogPersistence.loadQuestions4HumanState(dialogId, status);
  }

  public async loadDialogMetadata(
    dialogId: DialogID,
    status: DialogStatusKind,
  ): Promise<DialogMetadataFile | null> {
    return await DialogPersistence.loadDialogMetadata(dialogId, status);
  }

  public async loadPendingSubdialogs(
    rootDialogId: DialogID,
    status: DialogStatusKind,
  ): Promise<PendingSubdialog[]> {
    const records = await DialogPersistence.loadPendingSubdialogs(rootDialogId, status);
    return records.map((record) => ({
      subdialogId: new DialogID(record.subdialogId, rootDialogId.rootId),
      createdAt: record.createdAt,
      mentionList: record.mentionList,
      tellaskContent: record.tellaskContent,
      targetAgentId: record.targetAgentId,
      callId: record.callId,
      callingCourse: record.callingCourse,
      callType: record.callType,
      sessionSlug: record.sessionSlug,
    }));
  }

  public async saveSubdialogRegistry(
    dialog: RootDialog,
    rootDialogId: DialogID,
    entries: Array<{
      key: string;
      subdialogId: DialogID;
      agentId: string;
      sessionSlug?: string;
    }>,
    status: DialogStatusKind,
  ): Promise<void> {
    await DialogPersistence.saveSubdialogRegistry(rootDialogId, entries, status);
    await DialogPersistence.appendSubdialogRegistryReconciledRecord(
      rootDialogId,
      entries.map((entry) => ({
        key: entry.key,
        subdialogId: entry.subdialogId.selfId,
        agentId: entry.agentId,
        sessionSlug: entry.sessionSlug,
      })),
      resolveReconciledRecordWriteTarget(dialog),
      status,
    );
  }

  public async loadSubdialogRegistry(
    rootDialog: RootDialog,
    status: DialogStatusKind,
  ): Promise<void> {
    const entries = await DialogPersistence.loadSubdialogRegistry(rootDialog.id, status);
    const shouldPruneDead = status === 'running';
    let prunedDeadRegistryEntries = false;
    const restoringSubdialogs = new Map<string, Promise<SubDialog>>();

    const ensureSubdialogLoaded = async (
      subdialogId: DialogID,
      ancestry: Set<string> = new Set(),
    ): Promise<SubDialog> => {
      if (ancestry.has(subdialogId.selfId)) {
        throw new Error(
          `Subdialog registry restore invariant violation: cyclic parent chain ` +
            `(rootId=${rootDialog.id.rootId}, selfId=${subdialogId.selfId})`,
        );
      }
      const existing = rootDialog.lookupDialog(subdialogId.selfId);
      if (existing) {
        if (!(existing instanceof SubDialog)) {
          throw new Error(
            `Dialog registry type invariant violation: expected SubDialog ` +
              `(rootId=${rootDialog.id.rootId}, selfId=${subdialogId.selfId})`,
          );
        }
        return existing;
      }

      const inFlight = restoringSubdialogs.get(subdialogId.selfId);
      if (inFlight) {
        return await inFlight;
      }

      const task = (async (): Promise<SubDialog> => {
        const nextAncestry = new Set(ancestry);
        nextAncestry.add(subdialogId.selfId);
        const subdialogState = await DialogPersistence.restoreDialog(subdialogId, status);
        if (!subdialogState) {
          throw new Error(
            `Subdialog registry restore invariant violation: missing dialog state ` +
              `(rootId=${rootDialog.id.rootId}, selfId=${subdialogId.selfId})`,
          );
        }

        const metadata = subdialogState.metadata;
        if (!isSubdialogMetadataFile(metadata)) {
          throw new Error(
            `Subdialog registry restore invariant violation: expected subdialog metadata ` +
              `(rootId=${rootDialog.id.rootId}, selfId=${subdialogId.selfId})`,
          );
        }

        const assignmentFromSup = metadata.assignmentFromSup;
        if (!assignmentFromSup) {
          throw new Error(
            `Subdialog registry restore invariant violation: missing assignmentFromSup ` +
              `(rootId=${rootDialog.id.rootId}, selfId=${subdialogId.selfId})`,
          );
        }

        const parentIds: string[] = [];
        const maybePushParentId = (candidate: string | undefined): void => {
          if (!candidate) return;
          if (candidate === rootDialog.id.rootId) return;
          if (candidate === subdialogId.selfId) return;
          if (parentIds.includes(candidate)) return;
          parentIds.push(candidate);
        };
        maybePushParentId(metadata.supdialogId);
        maybePushParentId(assignmentFromSup.callerDialogId);

        for (const parentId of parentIds) {
          if (rootDialog.lookupDialog(parentId)) {
            continue;
          }
          const parentDialogId = new DialogID(parentId, rootDialog.id.rootId);
          const parentMeta = await DialogPersistence.loadDialogMetadata(parentDialogId, status);
          if (!parentMeta) {
            throw new Error(
              `Subdialog registry restore invariant violation: missing parent metadata ` +
                `(rootId=${rootDialog.id.rootId}, childId=${subdialogId.selfId}, parentId=${parentId})`,
            );
          }
          if (!isSubdialogMetadataFile(parentMeta)) {
            throw new Error(
              `Subdialog registry restore invariant violation: parent is not a subdialog ` +
                `(rootId=${rootDialog.id.rootId}, childId=${subdialogId.selfId}, parentId=${parentId})`,
            );
          }
          await ensureSubdialogLoaded(parentDialogId, nextAncestry);
          if (!rootDialog.lookupDialog(parentId)) {
            throw new Error(
              `Subdialog registry restore invariant violation: parent restore failed ` +
                `(rootId=${rootDialog.id.rootId}, childId=${subdialogId.selfId}, parentId=${parentId})`,
            );
          }
        }

        const subdialogStore = new DiskFileDialogStore(subdialogId);
        const subdialog = new SubDialog(
          subdialogStore,
          rootDialog,
          metadata.taskDocPath,
          new DialogID(subdialogId.selfId, rootDialog.id.rootId),
          metadata.agentId,
          assignmentFromSup,
          metadata.sessionSlug,
          {
            messages: subdialogState.messages,
            reminders: subdialogState.reminders,
            currentCourse: subdialogState.currentCourse,
            contextHealth: subdialogState.contextHealth,
          },
        );
        const latest = await DialogPersistence.loadDialogLatest(subdialogId, status);
        subdialog.disableDiligencePush = latest?.disableDiligencePush ?? false;
        if (subdialog.sessionSlug) {
          rootDialog.registerSubdialog(subdialog);
        }
        return subdialog;
      })();
      restoringSubdialogs.set(subdialogId.selfId, task);
      try {
        return await task;
      } finally {
        restoringSubdialogs.delete(subdialogId.selfId);
      }
    };

    for (const entry of entries) {
      if (!entry.sessionSlug) continue;

      if (shouldPruneDead) {
        const latest = await DialogPersistence.loadDialogLatest(entry.subdialogId, status);
        const executionMarker = latest?.executionMarker;
        if (executionMarker && executionMarker.kind === 'dead') {
          prunedDeadRegistryEntries = true;
          rootDialog.unregisterSubdialog(entry.agentId, entry.sessionSlug);
          log.debug('Skip dead subdialog while loading Type B registry', undefined, {
            rootId: rootDialog.id.rootId,
            subdialogId: entry.subdialogId.selfId,
            agentId: entry.agentId,
            sessionSlug: entry.sessionSlug,
          });
          continue;
        }
      }

      const subdialog = await ensureSubdialogLoaded(entry.subdialogId);
      if (!subdialog.sessionSlug) {
        throw new Error(
          `Subdialog registry invariant violation: missing sessionSlug on loaded subdialog ` +
            `(rootId=${rootDialog.id.rootId}, selfId=${entry.subdialogId.selfId}, expectedSessionSlug=${entry.sessionSlug})`,
        );
      }
      if (subdialog.sessionSlug !== entry.sessionSlug) {
        throw new Error(
          `Subdialog registry invariant violation: sessionSlug mismatch ` +
            `(rootId=${rootDialog.id.rootId}, selfId=${entry.subdialogId.selfId}, ` +
            `expected=${entry.sessionSlug}, actual=${subdialog.sessionSlug})`,
        );
      }
      if (subdialog.agentId !== entry.agentId) {
        throw new Error(
          `Subdialog registry invariant violation: agentId mismatch ` +
            `(rootId=${rootDialog.id.rootId}, selfId=${entry.subdialogId.selfId}, ` +
            `expected=${entry.agentId}, actual=${subdialog.agentId})`,
        );
      }
      rootDialog.registerSubdialog(subdialog);
    }

    if (prunedDeadRegistryEntries) {
      await rootDialog.saveSubdialogRegistry();
    }
  }

  /**
   * Clear Questions for Human state in storage
   */
  public async clearQuestions4Human(dialog: Dialog): Promise<void> {
    const previousQuestions = await DialogPersistence.loadQuestions4HumanState(dialog.id);
    const previousCount = previousQuestions.length;

    if (previousCount > 0) {
      await DialogPersistence.clearQuestions4HumanState(dialog.id);
      await DialogPersistence.appendQuestions4HumanReconciledRecord(
        dialog.id,
        [],
        resolveReconciledRecordWriteTarget(dialog),
        dialog.status,
      );

      // Emit q4h_answered events for each removed question
      for (const q of previousQuestions) {
        const answeredEvent: Q4HAnsweredEvent = {
          type: 'q4h_answered',
          questionId: q.id,
          selfId: dialog.id.selfId,
        };
        postDialogEvent(dialog, answeredEvent);
      }
    }
  }

  /**
   * Get current questions for human count for UI decoration
   */
  public async getQuestions4HumanCount(): Promise<number> {
    const questions = await DialogPersistence.loadQuestions4HumanState(this.dialogId);
    return questions.length;
  }

  /**
   * Load current course number from persisted metadata
   */
  public async loadCurrentCourse(dialogId: DialogID): Promise<number> {
    return await DialogPersistence.getCurrentCourseNumber(dialogId, 'running');
  }

  /**
   * Get next sequence number for generation
   */
  public async getNextSeq(dialogId: DialogID, course: number): Promise<number> {
    return await DialogPersistence.getNextSeq(dialogId, course, 'running');
  }

  /**
   * Send dialog events directly to a specific WebSocket connection for dialog restoration
   * CRITICAL: This bypasses PubChan to ensure only the requesting session receives restoration events
   * Unlike replayDialogEvents(), this sends events directly to ws.send() instead of postDialogEvent()
   * @param ws - WebSocket connection to send events to
   * @param dialog - Dialog object containing metadata
   * @param course - Optional course number (uses dialog.currentCourse if not provided)
   * @param totalCourses - Optional total courses count (defaults to course/currentCourse)
   */
  public async sendDialogEventsDirectly(
    ws: WebSocket,
    dialog: Dialog,
    course?: number,
    totalCourses?: number,
    status: DialogStatusKind = 'running',
    options?: {
      showPrimingEventsInUi?: boolean;
    },
  ): Promise<void> {
    try {
      // Use provided course or fallback to dialog.currentCourse (which may be stale for new Dialog objects)
      const currentCourse = course ?? dialog.currentCourse;
      const effectiveTotalCourses = totalCourses ?? currentCourse;
      const persistenceEvents = await DialogPersistence.readCourseEvents(
        dialog.id,
        currentCourse,
        status,
      );

      // Send course_update event directly to this WebSocket only
      ws.send(
        JSON.stringify({
          type: 'course_update',
          dialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          course: currentCourse,
          totalCourses: effectiveTotalCourses,
        }),
      );

      // Events are already in chronological order from JSONL file (append-only pattern)

      // Send each persistence event directly to the requesting WebSocket
      for (const event of persistenceEvents) {
        await this.sendEventDirectlyToWebSocket(ws, dialog, currentCourse, event, status, options);
      }

      // Rehydrate reminders from dialog state
      const dialogState = await DialogPersistence.restoreDialog(dialog.id, status);
      if (!dialogState) {
        throw new Error(
          `Dialog state missing during direct event replay: ${dialog.id.valueOf()} (${status})`,
        );
      }
      // Keep typed reminder objects as-is instead of field-picking rehydrate.
      // This prevents accidental field loss (e.g. echoback) when Reminder shape evolves.
      const restoredReminders: Reminder[] = dialogState.reminders;
      dialog.reminders.length = 0;
      dialog.reminders.push(...restoredReminders);
    } catch (error) {
      log.error(`Failed to send dialog events directly for ${dialog.id.selfId}:`, error);
      throw error;
    }
  }

  /**
   * Send a single persistence event directly to a WebSocket connection
   * CRITICAL: Avoid PubChan completely for dialog restoration to the single client's display_dialog request
   */
  private async sendEventDirectlyToWebSocket(
    ws: WebSocket,
    dialog: Dialog,
    course: number,
    event: PersistedDialogRecord,
    status: DialogStatusKind,
    options?: {
      showPrimingEventsInUi?: boolean;
    },
  ): Promise<void> {
    const showPrimingEventsInUi = options?.showPrimingEventsInUi !== false;
    const sourceTag =
      typeof (event as { sourceTag?: unknown }).sourceTag === 'string'
        ? (event as { sourceTag: string }).sourceTag
        : undefined;
    if (!showPrimingEventsInUi && sourceTag === 'priming_script') {
      return;
    }

    switch (event.type) {
      case 'human_text_record': {
        if (typeof event.q4hAnswerCallId === 'string' && event.q4hAnswerCallId.trim() !== '') {
          // Q4H-annotated human_text_record is a technical continuation marker for a resumed drive.
          // The canonical answer fact already exists in tellask result/carryover records, so UI
          // replay must not emit it as another user prompt bubble.
          break;
        }
        const genseq = event.genseq;
        const content = event.content || '';
        const grammar: 'markdown' = 'markdown';
        const origin: 'user' | 'diligence_push' | 'runtime' =
          event.origin === 'diligence_push' || event.origin === 'runtime' ? event.origin : 'user';
        const userLanguageCode = event.userLanguageCode;
        const renderAsStandaloneRuntimeGuide =
          origin === 'runtime' && isStandaloneRuntimeGuidePromptContent(content);

        if (renderAsStandaloneRuntimeGuide) {
          if (ws.readyState === 1) {
            const runtimeGuideEvt: RuntimeGuideEvent = {
              type: 'runtime_guide_evt',
              course,
              genseq,
              content,
            };
            ws.send(
              JSON.stringify({
                ...runtimeGuideEvt,
                dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                timestamp: event.ts,
              }),
            );
          }
          break;
        }

        if (content) {
          if (ws.readyState === 1) {
            ws.send(
              JSON.stringify({
                type: 'markdown_start_evt',
                course,
                genseq,
                dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                timestamp: event.ts,
              }),
            );
            ws.send(
              JSON.stringify({
                type: 'markdown_chunk_evt',
                chunk: content,
                course,
                genseq,
                dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                timestamp: event.ts,
              }),
            );
            ws.send(
              JSON.stringify({
                type: 'markdown_finish_evt',
                course,
                genseq,
                dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
                timestamp: event.ts,
              }),
            );
          }
        }

        // Emit end_of_user_saying_evt to signal frontend to render <hr/> separator
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: 'end_of_user_saying_evt',
              course,
              genseq,
              msgId: event.msgId,
              content,
              grammar,
              origin,
              userLanguageCode,
              q4hAnswerCallId: event.q4hAnswerCallId,
              dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
              timestamp: event.ts,
            }),
          );
        }
        break;
      }

      case 'tellask_reply_resolution_record':
        break;

      case 'gen_start_record': {
        // Create generating_start_evt event using persisted genseq directly
        const genStartWireEvent = {
          type: 'generating_start_evt',
          course,
          genseq: event.genseq,
          dialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          timestamp: event.ts,
        };

        // Send directly to WebSocket (NO PubChan emission)
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(genStartWireEvent));
        }
        break;
      }

      case 'gen_finish_record': {
        // Create generating_finish_evt event using persisted genseq directly
        const genFinishWireEvent = {
          type: 'generating_finish_evt',
          course,
          genseq: event.genseq,
          llmGenModel: typeof event.llmGenModel === 'string' ? event.llmGenModel : undefined,
          dialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          timestamp: event.ts,
        };

        // Send directly to WebSocket (NO PubChan emission)
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(genFinishWireEvent));
        }

        if (event.contextHealth) {
          const ctxWireEvent = {
            type: 'context_health_evt',
            course,
            genseq: event.genseq,
            contextHealth: event.contextHealth,
            dialog: {
              selfId: dialog.id.selfId,
              rootId: dialog.id.rootId,
            },
            timestamp: event.ts,
          };
          if (ws.readyState === 1) {
            ws.send(JSON.stringify(ctxWireEvent));
          }
        }
        break;
      }

      case 'agent_thought_record': {
        // Replay thinking content as thinking events
        const content = event.content || '';
        if (content) {
          // Start thinking phase
          const thinkingStartEvent = {
            type: 'thinking_start_evt',
            course,
            genseq: event.genseq,
            dialog: {
              selfId: dialog.id.selfId,
              rootId: dialog.id.rootId,
            },
            timestamp: event.ts,
          };

          if (ws.readyState === 1) {
            ws.send(JSON.stringify(thinkingStartEvent));
          }

          const thinkingChunks = this.createOptimalChunks(content);
          for (const chunk of thinkingChunks) {
            const thinkingChunkEvent = {
              type: 'thinking_chunk_evt',
              chunk,
              course,
              genseq: event.genseq,
              dialog: {
                selfId: dialog.id.selfId,
                rootId: dialog.id.rootId,
              },
              timestamp: event.ts,
            };
            if (ws.readyState === 1) {
              ws.send(JSON.stringify(thinkingChunkEvent));
            }
          }

          // Finish thinking phase
          const thinkingFinishEvent = {
            type: 'thinking_finish_evt',
            course,
            genseq: event.genseq,
            dialog: {
              selfId: dialog.id.selfId,
              rootId: dialog.id.rootId,
            },
            timestamp: event.ts,
          };
          if (ws.readyState === 1) {
            ws.send(JSON.stringify(thinkingFinishEvent));
          }
        }
        break;
      }

      case 'agent_words_record': {
        const content = event.content || '';
        if (content) {
          const dialogIdent = {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          };
          if (ws.readyState === 1) {
            ws.send(
              JSON.stringify({
                type: 'markdown_start_evt',
                course,
                genseq: event.genseq,
                dialog: dialogIdent,
                timestamp: event.ts,
              }),
            );
            ws.send(
              JSON.stringify({
                type: 'markdown_chunk_evt',
                chunk: content,
                course,
                genseq: event.genseq,
                dialog: dialogIdent,
                timestamp: event.ts,
              }),
            );
            ws.send(
              JSON.stringify({
                type: 'markdown_finish_evt',
                course,
                genseq: event.genseq,
                dialog: dialogIdent,
                timestamp: event.ts,
              }),
            );
          }
        }
        break;
      }

      case 'runtime_guide_record': {
        const content = event.content || '';
        if (!content.trim()) break;
        if (ws.readyState === 1) {
          const runtimeGuideEvt: RuntimeGuideEvent = {
            type: 'runtime_guide_evt',
            course,
            genseq: event.genseq,
            content,
          };
          ws.send(
            JSON.stringify({
              ...runtimeGuideEvt,
              dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
              timestamp: event.ts,
            }),
          );
        }
        break;
      }

      case 'ui_only_markdown_record': {
        const content = event.content || '';
        if (!content.trim()) break;
        if (ws.readyState === 1) {
          const uiOnlyMarkdownEvt: UiOnlyMarkdownEvent = {
            type: 'ui_only_markdown_evt',
            course,
            genseq: event.genseq,
            content,
          };
          ws.send(
            JSON.stringify({
              ...uiOnlyMarkdownEvt,
              dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
              timestamp: event.ts,
            }),
          );
        }
        break;
      }

      case 'func_call_record': {
        // Handle normal function call events from persistence.
        const funcCall = {
          type: 'func_call_requested_evt',
          funcId: event.id,
          funcName: event.name,
          arguments: event.rawArgumentsText,
          course,
          genseq: event.genseq,
          dialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          timestamp: event.ts,
        };

        if (ws.readyState === 1) {
          ws.send(JSON.stringify(funcCall));
        }
        break;
      }

      case 'tellask_call_record': {
        if (event.deliveryMode === 'func_call_requested') {
          const replyCall = {
            type: 'func_call_requested_evt',
            funcId: event.id,
            funcName: event.name,
            arguments: formatTellaskCallArguments(event),
            course,
            genseq: event.genseq,
            dialog: {
              selfId: dialog.id.selfId,
              rootId: dialog.id.rootId,
            },
            timestamp: event.ts,
          };
          if (ws.readyState === 1) {
            ws.send(JSON.stringify(replyCall));
          }
          break;
        }
        const specialCall = parseReplayTellaskCall(event);
        if (!specialCall) {
          break;
        }
        const dialogIdent = {
          selfId: dialog.id.selfId,
          rootId: dialog.id.rootId,
        };
        const callStartEvent = (() => {
          switch (specialCall.callName) {
            case 'tellask':
              if (!specialCall.sessionSlug || specialCall.sessionSlug.trim() === '') {
                throw new Error(
                  `Replay tellask event invariant violation: missing sessionSlug (callId=${specialCall.callId})`,
                );
              }
              return {
                type: 'tellask_call_start_evt',
                callName: specialCall.callName,
                callId: specialCall.callId,
                mentionList: specialCall.mentionList,
                sessionSlug: specialCall.sessionSlug,
                tellaskContent: specialCall.tellaskContent,
                course,
                genseq: event.genseq,
                dialog: dialogIdent,
                timestamp: event.ts,
              };
            case 'tellaskSessionless':
              return {
                type: 'tellask_call_start_evt',
                callName: specialCall.callName,
                callId: specialCall.callId,
                mentionList: specialCall.mentionList,
                tellaskContent: specialCall.tellaskContent,
                course,
                genseq: event.genseq,
                dialog: dialogIdent,
                timestamp: event.ts,
              };
            case 'tellaskBack':
            case 'askHuman':
            case 'freshBootsReasoning':
              return {
                type: 'tellask_call_start_evt',
                callName: specialCall.callName,
                callId: specialCall.callId,
                tellaskContent: specialCall.tellaskContent,
                course,
                genseq: event.genseq,
                dialog: dialogIdent,
                timestamp: event.ts,
              };
          }
        })();
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(callStartEvent));
        }
        break;
      }

      case 'web_search_call_record': {
        const itemId = typeof event.itemId === 'string' ? event.itemId.trim() : '';
        if (itemId === '') {
          log.error(
            'Protocol violation: persisted web_search_call_record missing itemId; skipping WS event',
            new Error('persisted_web_search_call_record_missing_item_id'),
            { dialog, course, genseq: event.genseq, phase: event.phase },
          );
          break;
        }
        const webSearchCall = {
          type: 'web_search_call_evt',
          source: event.source,
          phase: event.phase,
          itemId,
          status: event.status,
          action: event.action,
          course,
          genseq: event.genseq,
          dialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          timestamp: event.ts,
        };

        if (ws.readyState === 1) {
          ws.send(JSON.stringify(webSearchCall));
        }
        break;
      }

      case 'native_tool_call_record': {
        let nativeToolCall: Record<string, unknown>;
        if (event.itemType === 'custom_tool_call') {
          const callId = typeof event.callId === 'string' ? event.callId.trim() : '';
          if (callId === '') {
            log.error(
              'Protocol violation: persisted custom native_tool_call_record missing callId; skipping WS event',
              new Error('persisted_native_tool_call_record_missing_call_id'),
              {
                dialog,
                course,
                genseq: event.genseq,
                itemType: event.itemType,
                phase: event.phase,
                itemId: event.itemId,
              },
            );
            break;
          }
          if (typeof event.itemId === 'string' && event.itemId.trim() === '') {
            log.error(
              'Protocol violation: persisted custom native_tool_call_record carried empty optional itemId; skipping WS event',
              new Error('persisted_native_tool_call_record_empty_optional_item_id'),
              {
                dialog,
                course,
                genseq: event.genseq,
                itemType: event.itemType,
                phase: event.phase,
                callId,
              },
            );
            break;
          }
          nativeToolCall = {
            type: 'native_tool_call_evt',
            source: event.source,
            itemType: event.itemType,
            phase: event.phase,
            callId,
            ...(typeof event.itemId === 'string' && event.itemId.trim() !== ''
              ? { itemId: event.itemId.trim() }
              : {}),
            status: event.status,
            title: event.title,
            summary: event.summary,
            detail: event.detail,
            course,
            genseq: event.genseq,
            dialog: {
              selfId: dialog.id.selfId,
              rootId: dialog.id.rootId,
            },
            timestamp: event.ts,
          };
        } else {
          if ('callId' in event) {
            log.error(
              'Protocol violation: persisted non-custom native_tool_call_record carried unexpected callId; skipping WS event',
              new Error('persisted_native_tool_call_record_unexpected_call_id'),
              {
                dialog,
                course,
                genseq: event.genseq,
                itemType: event.itemType,
                phase: event.phase,
                callId: event.callId,
              },
            );
            break;
          }
          const itemId = typeof event.itemId === 'string' ? event.itemId.trim() : '';
          if (itemId === '') {
            log.error(
              'Protocol violation: persisted native_tool_call_record missing itemId; skipping WS event',
              new Error('persisted_native_tool_call_record_missing_item_id'),
              {
                dialog,
                course,
                genseq: event.genseq,
                itemType: event.itemType,
                phase: event.phase,
              },
            );
            break;
          }
          nativeToolCall = {
            type: 'native_tool_call_evt',
            source: event.source,
            itemType: event.itemType,
            phase: event.phase,
            itemId,
            status: event.status,
            title: event.title,
            summary: event.summary,
            detail: event.detail,
            course,
            genseq: event.genseq,
            dialog: {
              selfId: dialog.id.selfId,
              rootId: dialog.id.rootId,
            },
            timestamp: event.ts,
          };
        }

        if (ws.readyState === 1) {
          ws.send(JSON.stringify(nativeToolCall));
        }
        break;
      }

      case 'func_result_record': {
        if (
          isSuppressedTellaskPlaceholderFuncResult({
            name: event.name,
            content: event.content,
          })
        ) {
          break;
        }
        // Handle function result events from persistence
        const funcResult = {
          type: 'func_result_evt',
          id: event.id,
          name: event.name,
          content: event.content,
          contentItems: event.contentItems,
          course,
          genseq: event.genseq,
          dialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          timestamp: event.ts,
        };

        if (ws.readyState === 1) {
          ws.send(JSON.stringify(funcResult));
        }
        break;
      }

      case 'tool_result_image_ingest_record': {
        const toolResultImageIngestEvt: ToolResultImageIngestEvent = {
          type: 'tool_result_image_ingest_evt',
          course,
          genseq: event.genseq,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          artifact: event.artifact,
          provider: event.provider,
          model: event.model,
          disposition: event.disposition,
          message: event.message,
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
        };
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              ...toolResultImageIngestEvt,
              dialog: {
                selfId: dialog.id.selfId,
                rootId: dialog.id.rootId,
              },
              timestamp: event.ts,
            }),
          );
        }
        break;
      }

      case 'tellask_result_record': {
        const base = {
          type: 'tellask_result_evt' as const,
          course,
          genseq: event.genseq,
          callId: event.callId,
          status: event.status,
          content: event.content,
          ...(event.calling_genseq !== undefined ? { calling_genseq: event.calling_genseq } : {}),
          responder: event.responder,
          ...(event.route ? { route: event.route } : {}),
          dialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          timestamp: event.ts,
        };
        const tellaskResultEvent: TellaskResultEvent & {
          dialog: {
            selfId: string;
            rootId: string;
          };
          timestamp: string;
        } =
          event.callName === 'tellask'
            ? {
                ...base,
                callName: event.callName,
                call: event.call,
              }
            : event.callName === 'tellaskSessionless'
              ? {
                  ...base,
                  callName: event.callName,
                  call: event.call,
                }
              : {
                  ...base,
                  callName: event.callName,
                  call: event.call,
                };

        if (ws.readyState === 1) {
          ws.send(JSON.stringify(tellaskResultEvent));
        }
        break;
      }

      case 'quest_for_sup_record': {
        // Handle subdialog creation requests
        const subdialogId = new DialogID(event.subDialogId, dialog.id.rootId);
        const metadata = await DialogPersistence.loadDialogMetadata(subdialogId, status);
        if (!metadata || !isSubdialogMetadataFile(metadata)) {
          throw new Error(
            `subdialog_created_evt replay invariant violation: metadata missing for ${subdialogId.valueOf()} in ${status}`,
          );
        }
        const subMeta = metadata;
        const subLatest = await DialogPersistence.loadDialogLatest(subdialogId, status);

        const derivedSupdialogId =
          subMeta.assignmentFromSup?.callerDialogId &&
          subMeta.assignmentFromSup.callerDialogId.trim() !== ''
            ? subMeta.assignmentFromSup.callerDialogId
            : typeof subMeta.supdialogId === 'string' && subMeta.supdialogId.trim() !== ''
              ? subMeta.supdialogId
              : dialog.id.selfId;

        const subdialogCreatedEvent = {
          type: 'subdialog_created_evt',
          course,
          dialog: {
            // Add dialog field for proper event routing
            selfId: subdialogId.selfId,
            rootId: subdialogId.rootId,
          },
          parentDialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          subDialog: {
            selfId: subdialogId.selfId,
            rootId: subdialogId.rootId,
          },
          targetAgentId: subMeta.agentId,
          mentionList: event.mentionList,
          tellaskContent: event.tellaskContent,
          subDialogNode: {
            selfId: subMeta.id,
            rootId: subdialogId.rootId,
            supdialogId: derivedSupdialogId,
            agentId: subMeta.agentId,
            taskDocPath: subMeta.taskDocPath,
            status,
            currentCourse: subLatest?.currentCourse || 1,
            createdAt: subMeta.createdAt,
            lastModified: subLatest?.lastModified || subMeta.createdAt,
            displayState: subLatest?.displayState,
            sessionSlug: subMeta.sessionSlug,
            assignmentFromSup: subMeta.assignmentFromSup,
          },
          timestamp: event.ts,
        };

        if (ws.readyState === 1) {
          ws.send(JSON.stringify(subdialogCreatedEvent));
        }
        break;
      }

      case 'tellask_call_anchor_record': {
        const anchorEvent: TellaskCallAnchorEvent & {
          dialog: {
            selfId: string;
            rootId: string;
          };
          timestamp: string;
        } =
          event.anchorRole === 'assignment'
            ? {
                type: 'tellask_call_anchor_evt',
                course,
                genseq: event.genseq,
                anchorRole: 'assignment',
                callId: event.callId,
                assignmentCourse: event.assignmentCourse,
                assignmentGenseq: event.assignmentGenseq,
                dialog: {
                  selfId: dialog.id.selfId,
                  rootId: dialog.id.rootId,
                },
                timestamp: event.ts,
              }
            : {
                type: 'tellask_call_anchor_evt',
                course,
                genseq: event.genseq,
                anchorRole: 'response',
                callId: event.callId,
                assignmentCourse: event.assignmentCourse,
                assignmentGenseq: event.assignmentGenseq,
                callerDialogId: event.callerDialogId,
                callerCourse: event.callerCourse,
                dialog: {
                  selfId: dialog.id.selfId,
                  rootId: dialog.id.rootId,
                },
                timestamp: event.ts,
              };
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(anchorEvent));
        }
        break;
      }

      case 'subdialog_created_record':
      case 'reminders_reconciled_record':
      case 'questions4human_reconciled_record':
      case 'pending_subdialogs_reconciled_record':
      case 'subdialog_registry_reconciled_record':
      case 'subdialog_responses_reconciled_record':
        break;

      case 'tellask_carryover_record': {
        const base = {
          type: 'tellask_carryover_evt' as const,
          course,
          genseq: event.genseq,
          originCourse: event.originCourse,
          carryoverCourse: event.carryoverCourse,
          responderId: event.responderId,
          tellaskContent: event.tellaskContent,
          status: event.status,
          response: event.response,
          content: event.content,
          agentId: event.agentId,
          callId: event.callId,
          originMemberId: event.originMemberId,
          ...(event.calleeDialogId ? { calleeDialogId: event.calleeDialogId } : {}),
          ...(event.calleeCourse !== undefined ? { calleeCourse: event.calleeCourse } : {}),
          ...(event.calleeGenseq !== undefined ? { calleeGenseq: event.calleeGenseq } : {}),
          dialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          timestamp: event.ts,
        };
        const tellaskCarryoverEvent: TellaskCarryoverEvent & {
          dialog: {
            selfId: string;
            rootId: string;
          };
          timestamp: string;
        } =
          event.callName === 'tellask'
            ? {
                ...base,
                callName: event.callName,
                sessionSlug: event.sessionSlug,
                mentionList: event.mentionList,
              }
            : event.callName === 'tellaskSessionless'
              ? {
                  ...base,
                  callName: event.callName,
                  mentionList: event.mentionList,
                }
              : {
                  ...base,
                  callName: event.callName,
                };
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(tellaskCarryoverEvent));
        }
        break;
      }

      default:
        // Unknown event type - log but don't crash
        log.warn(`Unknown persistence event type during direct WebSocket send`, undefined, event);
        break;
    }
  }

  /**
   * Create optimal text chunks for websocket transmission
   * Splits content into 1MB pieces for efficient websocket streaming
   */
  private createOptimalChunks(content: string, maxChunk: number = 1000000): string[] {
    const chunks: string[] = [];
    let remaining = content.trim();

    while (remaining.length > 0) {
      // Use 1MB chunks for optimal websocket transmission
      const targetSize = Math.min(remaining.length, maxChunk);
      const chunk = remaining.slice(0, targetSize);

      chunks.push(chunk);
      remaining = remaining.slice(chunk.length).trim();
    }

    return chunks.filter((chunk) => chunk.length > 0);
  }
}

type LatestWriteBackEntry =
  | {
      kind: 'scheduled';
      dialogId: DialogID;
      status: DialogStatusKind;
      latest: DialogLatestFile;
      timer: NodeJS.Timeout;
    }
  | {
      kind: 'flushing';
      dialogId: DialogID;
      status: DialogStatusKind;
      latest: DialogLatestFile;
      dirty: boolean;
      inFlight: Promise<void>;
    };

type Q4HWriteBackState = { kind: 'file'; file: Questions4HumanFile } | { kind: 'deleted' };

type Q4HWriteBackEntry =
  | {
      kind: 'scheduled';
      dialogId: DialogID;
      status: DialogStatusKind;
      state: Q4HWriteBackState;
      timer: NodeJS.Timeout;
    }
  | {
      kind: 'flushing';
      dialogId: DialogID;
      status: DialogStatusKind;
      state: Q4HWriteBackState;
      dirty: boolean;
      inFlight: Promise<void>;
    };

type PendingSubdialogsWriteBackState =
  | { kind: 'file'; records: PendingSubdialogStateRecord[] }
  | { kind: 'deleted' };

type PendingSubdialogsWriteBackEntry =
  | {
      kind: 'scheduled';
      dialogId: DialogID;
      status: DialogStatusKind;
      state: PendingSubdialogsWriteBackState;
      timer: NodeJS.Timeout;
    }
  | {
      kind: 'flushing';
      dialogId: DialogID;
      status: DialogStatusKind;
      state: PendingSubdialogsWriteBackState;
      dirty: boolean;
      inFlight: Promise<void>;
    };

type Q4HMutation =
  | { kind: 'noop' }
  | { kind: 'append'; question: HumanQuestion }
  | { kind: 'remove'; questionId: string }
  | { kind: 'replace'; questions: HumanQuestion[] }
  | { kind: 'clear' };

type Q4HMutateOutcome = {
  previousQuestions: HumanQuestion[];
  questions: HumanQuestion[];
  removedQuestion?: HumanQuestion;
};

type PendingSubdialogsMutation =
  | { kind: 'noop' }
  | { kind: 'append'; record: PendingSubdialogStateRecord }
  | { kind: 'removeBySubdialogId'; subdialogId: string }
  | { kind: 'removeBySubdialogIds'; subdialogIds: string[] }
  | { kind: 'replace'; records: PendingSubdialogStateRecord[] }
  | { kind: 'clear' };

type PendingSubdialogsMutateOutcome = {
  previousRecords: PendingSubdialogStateRecord[];
  records: PendingSubdialogStateRecord[];
  removedRecords: PendingSubdialogStateRecord[];
};

type DialogLatestPatch = Partial<Omit<DialogLatestFile, 'currentCourse' | 'lastModified'>> & {
  currentCourse?: number;
  lastModified?: string;
};

type DialogLatestMutation =
  | { kind: 'noop' }
  | { kind: 'patch'; patch: DialogLatestPatch }
  | { kind: 'replace'; next: DialogLatestFile };

type RootDialogWriteBackCancellationToken = Readonly<{
  scopeKey: string;
  generation: number;
  rootDialogId: string;
  status: DialogStatusKind;
}>;

class DialogWriteBackCanceledError extends Error {
  constructor(token: RootDialogWriteBackCancellationToken, phase: string) {
    super(`Dialog writeback canceled for ${token.rootDialogId} (${token.status}) during ${phase}`);
    this.name = 'DialogWriteBackCanceledError';
  }
}

function isDialogWriteBackCanceledError(error: unknown): error is DialogWriteBackCanceledError {
  return error instanceof DialogWriteBackCanceledError;
}

/**
 * Utility class for managing dialog persistence
 */
export class DialogPersistence {
  private static readonly DIALOGS_DIR = '.dialogs';
  private static readonly MALFORMED_DIR = 'malformed';
  private static readonly RUN_DIR = 'run';
  private static readonly DONE_DIR = 'done';
  private static readonly ARCHIVE_DIR = 'archive';
  private static readonly SUBDIALOGS_DIR = 'subdialogs';
  private static readonly quarantinedRootDialogScopes = new Set<string>();

  private static readonly LATEST_WRITEBACK_WINDOW_MS = 300;
  private static readonly Q4H_WRITEBACK_WINDOW_MS = 300;
  private static readonly PENDING_SUBDIALOGS_WRITEBACK_WINDOW_MS = 300;

  private static readonly latestWriteBackMutexes: Map<string, AsyncFifoMutex> = new Map();
  private static readonly latestWriteBack: Map<string, LatestWriteBackEntry> = new Map();

  private static readonly q4hWriteBackMutexes: Map<string, AsyncFifoMutex> = new Map();
  private static readonly q4hWriteBack: Map<string, Q4HWriteBackEntry> = new Map();

  private static readonly pendingSubdialogsWriteBackMutexes: Map<string, AsyncFifoMutex> =
    new Map();
  private static readonly pendingSubdialogsWriteBack: Map<string, PendingSubdialogsWriteBackEntry> =
    new Map();

  private static readonly courseAppendMutexes: Map<string, AsyncFifoMutex> = new Map();
  private static readonly rootDialogWriteBackCancelGenerations: Map<string, number> = new Map();

  private static getLatestWriteBackMutex(key: string): AsyncFifoMutex {
    const existing = this.latestWriteBackMutexes.get(key);
    if (existing) return existing;
    const created = new AsyncFifoMutex();
    this.latestWriteBackMutexes.set(key, created);
    return created;
  }

  private static getQ4HWriteBackMutex(key: string): AsyncFifoMutex {
    const existing = this.q4hWriteBackMutexes.get(key);
    if (existing) return existing;
    const created = new AsyncFifoMutex();
    this.q4hWriteBackMutexes.set(key, created);
    return created;
  }

  private static getCourseAppendMutex(key: string): AsyncFifoMutex {
    const existing = this.courseAppendMutexes.get(key);
    if (existing) return existing;
    const created = new AsyncFifoMutex();
    this.courseAppendMutexes.set(key, created);
    return created;
  }

  private static getCourseAppendMutexKey(
    dialogId: DialogID,
    course: number,
    status: DialogStatusKind,
  ): string {
    return `${this.getDialogsRootDir()}|${status}|${dialogId.valueOf()}|course:${course}`;
  }

  private static getPendingSubdialogsWriteBackMutex(key: string): AsyncFifoMutex {
    const existing = this.pendingSubdialogsWriteBackMutexes.get(key);
    if (existing) return existing;
    const created = new AsyncFifoMutex();
    this.pendingSubdialogsWriteBackMutexes.set(key, created);
    return created;
  }

  private static getLatestWriteBackKey(dialogId: DialogID, status: DialogStatusKind): string {
    // Include dialogs root dir to avoid cross-test/process.cwd collisions.
    return `${this.getDialogsRootDir()}|${status}|${dialogId.valueOf()}`;
  }

  private static getQ4HWriteBackKey(dialogId: DialogID, status: DialogStatusKind): string {
    // Include dialogs root dir to avoid cross-test/process.cwd collisions.
    return `${this.getDialogsRootDir()}|${status}|${dialogId.valueOf()}|q4h`;
  }

  private static getPendingSubdialogsWriteBackKey(
    rootDialogId: DialogID,
    status: DialogStatusKind,
  ): string {
    return `${this.getDialogsRootDir()}|${status}|${rootDialogId.valueOf()}|pending-subdialogs`;
  }

  private static getRootDialogWriteBackCancelScopeKey(
    rootDialogId: DialogID,
    status: DialogStatusKind,
  ): string {
    return `${this.getDialogsRootDir()}|${status}|${rootDialogId.selfId}|writeback-cancel`;
  }

  private static createRootDialogWriteBackCancellationToken(
    dialogId: DialogID,
    status: DialogStatusKind,
  ): RootDialogWriteBackCancellationToken {
    const rootDialogId =
      dialogId.rootId === dialogId.selfId ? dialogId : new DialogID(dialogId.rootId);
    const scopeKey = this.getRootDialogWriteBackCancelScopeKey(rootDialogId, status);
    return {
      scopeKey,
      generation: this.rootDialogWriteBackCancelGenerations.get(scopeKey) ?? 0,
      rootDialogId: rootDialogId.selfId,
      status,
    };
  }

  private static assertRootDialogWriteBackNotCanceled(
    token: RootDialogWriteBackCancellationToken,
    phase: string,
  ): void {
    if (this.quarantinedRootDialogScopes.has(token.scopeKey)) {
      throw new DialogWriteBackCanceledError(token, phase);
    }
    const currentGeneration = this.rootDialogWriteBackCancelGenerations.get(token.scopeKey) ?? 0;
    if (currentGeneration !== token.generation) {
      throw new DialogWriteBackCanceledError(token, phase);
    }
  }

  private static async rethrowWriteBackPathMissingAsCanceled(
    error: unknown,
    dialogPath: string,
    cancellationToken: RootDialogWriteBackCancellationToken | undefined,
    phase: string,
  ): Promise<void> {
    if (getErrorCode(error) !== 'ENOENT') {
      throw error;
    }
    if (cancellationToken) {
      this.assertRootDialogWriteBackNotCanceled(cancellationToken, phase);
      if (!(await this.pathExists(dialogPath))) {
        throw new DialogWriteBackCanceledError(cancellationToken, `${phase}:dialog-path-missing`);
      }
    }
    throw error;
  }

  private static cancelRootDialogWriteBacks(
    rootDialogId: DialogID,
    status: DialogStatusKind,
  ): void {
    const scopeKey = this.getRootDialogWriteBackCancelScopeKey(rootDialogId, status);
    const nextGeneration = (this.rootDialogWriteBackCancelGenerations.get(scopeKey) ?? 0) + 1;
    this.rootDialogWriteBackCancelGenerations.set(scopeKey, nextGeneration);
    this.clearWriteBackEntriesForRootDialog(rootDialogId, status);
  }

  private static getDialogMetadataPath(dialogId: DialogID, status: DialogStatusKind): string {
    const dialogPath =
      dialogId.rootId === dialogId.selfId
        ? this.getRootDialogPath(dialogId, status)
        : this.getSubdialogPath(dialogId, status);
    return path.join(dialogPath, 'dialog.yaml');
  }

  private static async assertDialogMetadataExistsForAppend(
    dialogId: DialogID,
    status: DialogStatusKind,
    cancellationToken: RootDialogWriteBackCancellationToken,
    phase: string,
  ): Promise<void> {
    this.assertRootDialogWriteBackNotCanceled(cancellationToken, phase);
    const metadataPath = this.getDialogMetadataPath(dialogId, status);
    try {
      await fs.promises.access(metadataPath);
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') {
        this.assertRootDialogWriteBackNotCanceled(cancellationToken, `${phase}:metadata-missing`);
        throw new Error(
          `Refusing to append events for dialog ${dialogId.valueOf()}: missing dialog metadata at ${metadataPath}`,
        );
      }
      throw error;
    }
  }

  private static async cleanupCanceledAppendPlaceholder(
    dialogId: DialogID,
    status: DialogStatusKind,
  ): Promise<void> {
    const rootDialogId =
      dialogId.rootId === dialogId.selfId ? dialogId : new DialogID(dialogId.rootId);
    const rootPath = this.getRootDialogPath(rootDialogId, status);
    await fs.promises.rm(rootPath, { recursive: true, force: true });
  }

  private static clonePendingSubdialogRecords(
    records: readonly PendingSubdialogStateRecord[],
  ): PendingSubdialogStateRecord[] {
    return records.map((record) => ({
      ...record,
      mentionList: record.mentionList ? [...record.mentionList] : undefined,
    }));
  }

  private static cloneQuestions4Human(questions: readonly HumanQuestion[]): HumanQuestion[] {
    return questions.map((question) => ({
      ...question,
      callSiteRef: { ...question.callSiteRef },
    }));
  }

  private static cloneRegistryEntries(
    entries: readonly SubdialogRegistryStateRecord[],
  ): SubdialogRegistryStateRecord[] {
    return entries.map((entry) => ({
      ...entry,
    }));
  }

  private static cloneSubdialogResponses(
    responses: readonly SubdialogResponseStateRecord[],
  ): SubdialogResponseStateRecord[] {
    return responses.map((response) => ({
      ...response,
      mentionList: response.mentionList ? [...response.mentionList] : undefined,
    }));
  }

  static async appendRemindersReconciledRecord(
    dialogId: DialogID,
    reminders: readonly Reminder[],
    writeTarget: ReconciledRecordWriteTarget,
    status: DialogStatusKind,
  ): Promise<void> {
    const record: RemindersReconciledRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'reminders_reconciled_record',
      ...cloneRootGenerationAnchor(writeTarget.rootAnchor),
      reminders: reminders.map((reminder) => serializeReminderSnapshot(reminder)),
    };
    await this.appendEvent(
      dialogId,
      resolveTargetCourseFromWriteTarget(writeTarget),
      record,
      status,
    );
  }

  static async appendQuestions4HumanReconciledRecord(
    dialogId: DialogID,
    questions: readonly HumanQuestion[],
    writeTarget: ReconciledRecordWriteTarget,
    status: DialogStatusKind,
  ): Promise<void> {
    const record: Questions4HumanReconciledRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'questions4human_reconciled_record',
      ...cloneRootGenerationAnchor(writeTarget.rootAnchor),
      questions: this.cloneQuestions4Human(questions),
    };
    await this.appendEvent(
      dialogId,
      resolveTargetCourseFromWriteTarget(writeTarget),
      record,
      status,
    );
  }

  static async appendPendingSubdialogsReconciledRecord(
    dialogId: DialogID,
    pendingSubdialogs: readonly PendingSubdialogStateRecord[],
    writeTarget: ReconciledRecordWriteTarget,
    status: DialogStatusKind,
  ): Promise<void> {
    const record: PendingSubdialogsReconciledRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'pending_subdialogs_reconciled_record',
      ...cloneRootGenerationAnchor(writeTarget.rootAnchor),
      pendingSubdialogs: this.clonePendingSubdialogRecords(pendingSubdialogs),
    };
    await this.appendEvent(
      dialogId,
      resolveTargetCourseFromWriteTarget(writeTarget),
      record,
      status,
    );
  }

  static async appendSubdialogRegistryReconciledRecord(
    dialogId: DialogID,
    entries: readonly SubdialogRegistryStateRecord[],
    writeTarget: ReconciledRecordWriteTarget,
    status: DialogStatusKind,
  ): Promise<void> {
    const record: SubdialogRegistryReconciledRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'subdialog_registry_reconciled_record',
      ...cloneRootGenerationAnchor(writeTarget.rootAnchor),
      entries: this.cloneRegistryEntries(entries),
    };
    await this.appendEvent(
      dialogId,
      resolveTargetCourseFromWriteTarget(writeTarget),
      record,
      status,
    );
  }

  static async appendSubdialogResponsesReconciledRecord(
    dialogId: DialogID,
    responses: readonly SubdialogResponseStateRecord[],
    writeTarget: ReconciledRecordWriteTarget,
    status: DialogStatusKind,
  ): Promise<void> {
    const record: SubdialogResponsesReconciledRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'subdialog_responses_reconciled_record',
      ...cloneRootGenerationAnchor(writeTarget.rootAnchor),
      responses: this.cloneSubdialogResponses(responses),
    };
    await this.appendEvent(
      dialogId,
      resolveTargetCourseFromWriteTarget(writeTarget),
      record,
      status,
    );
  }

  /**
   * Get the base dialogs directory path
   */
  static getDialogsRootDir(): string {
    return path.join(process.cwd(), this.DIALOGS_DIR);
  }

  /**
   * Get the full path for a dialog directory
   */
  static getRootDialogPath(dialogId: DialogID, status: DialogStatusKind = 'running'): string {
    if (dialogId.rootId !== dialogId.selfId) {
      throw new Error('Expected root dialog id');
    }
    const statusDir = getPersistableStatusDirName(status, 'DialogPersistence.getRootDialogPath');
    return path.join(this.getDialogsRootDir(), statusDir, dialogId.selfId);
  }

  /**
   * Get the events/state directory for a dialog (composite ID for subdialogs)
   */
  static getDialogEventsPath(dialogId: DialogID, status: DialogStatusKind = 'running'): string {
    // Root dialogs store events under their own directory.
    // Subdialogs store events under the root's subdialogs/<self> directory.
    if (dialogId.rootId === dialogId.selfId) {
      return this.getRootDialogPath(dialogId, status);
    }
    return this.getSubdialogPath(dialogId, status);
  }

  /**
   * Get the path for a subdialog within a supdialog
   */
  static getSubdialogPath(dialogId: DialogID, status: DialogStatusKind = 'running'): string {
    if (dialogId.rootId === dialogId.selfId) {
      throw new Error('Expected subdialog id (self differs from root)');
    }
    const rootPath = this.getRootDialogPath(new DialogID(dialogId.rootId), status);
    return path.join(rootPath, this.SUBDIALOGS_DIR, dialogId.selfId);
  }

  private static getMalformedRootDialogPath(dialogId: DialogID, status: DialogStatusKind): string {
    if (dialogId.rootId !== dialogId.selfId) {
      throw new Error('Expected root dialog id');
    }
    void status;
    return path.join(this.getDialogsRootDir(), this.MALFORMED_DIR, dialogId.selfId);
  }

  private static inferRootDialogIdFromMetadataRelativeDir(relativeDir: string): DialogID | null {
    const dir = relativeDir.trim();
    if (dir === '' || dir === '.' || dir === path.sep) {
      return null;
    }
    const segments = dir.split(path.sep).filter((seg) => seg.length > 0 && seg !== '.');
    if (segments.length === 0) {
      return null;
    }
    const subdialogsIndex = segments.indexOf(this.SUBDIALOGS_DIR);
    const rootSegments = subdialogsIndex === -1 ? segments : segments.slice(0, subdialogsIndex);
    if (rootSegments.length === 0) {
      return null;
    }
    return new DialogID(rootSegments.join('/'));
  }

  private static inferExpectedDialogIdFromMetadataRelativeDir(relativeDir: string): string | null {
    const dir = relativeDir.trim();
    if (dir === '' || dir === '.' || dir === path.sep) {
      return null;
    }
    const segments = dir.split(path.sep).filter((seg) => seg.length > 0 && seg !== '.');
    if (segments.length === 0) {
      return null;
    }
    const subdialogsIndex = segments.indexOf(this.SUBDIALOGS_DIR);
    if (subdialogsIndex === -1) {
      return segments.join('/');
    }
    const subdialogSegments = segments.slice(subdialogsIndex + 1);
    if (subdialogSegments.length === 0) {
      return null;
    }
    return subdialogSegments.join('/');
  }

  private static async listSubdialogIdsUnderRoot(
    rootDialogId: DialogID,
    status: DialogStatusKind,
  ): Promise<string[]> {
    const subdialogsPath = path.join(
      this.getRootDialogPath(rootDialogId, status),
      this.SUBDIALOGS_DIR,
    );
    const subdialogIds = new Set<string>();

    const visit = async (dirPath: string, relativePath: string = ''): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch (error: unknown) {
        if (getErrorCode(error) === 'ENOENT') {
          return;
        }
        throw error;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const fullPath = path.join(dirPath, entry.name);
        const entryRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
        const dialogYamlPath = path.join(fullPath, 'dialog.yaml');

        try {
          await fs.promises.access(dialogYamlPath);
          const inferredId = this.inferExpectedDialogIdFromMetadataRelativeDir(
            path.join(this.SUBDIALOGS_DIR, entryRelativePath),
          );
          if (!inferredId) {
            throw new Error(
              `Failed to infer subdialog id from relative path ${entryRelativePath} under root ${rootDialogId.selfId}`,
            );
          }
          subdialogIds.add(inferredId);
          continue;
        } catch (error: unknown) {
          if (getErrorCode(error) !== 'ENOENT') {
            throw error;
          }
        }

        await visit(fullPath, entryRelativePath);
      }
    };

    await visit(subdialogsPath);
    return [...subdialogIds];
  }

  private static async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.promises.access(targetPath);
      return true;
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  private static clearLatestWriteBackState(dialogId: DialogID, status: DialogStatusKind): void {
    const key = this.getLatestWriteBackKey(dialogId, status);
    const entry = this.latestWriteBack.get(key);
    if (entry?.kind === 'scheduled') {
      clearTimeout(entry.timer);
    }
    this.latestWriteBack.delete(key);
    this.latestWriteBackMutexes.delete(key);
  }

  private static clearWriteBackEntriesForRootDialog(
    rootDialogId: DialogID,
    status: DialogStatusKind,
  ): void {
    const basePrefix = `${this.getDialogsRootDir()}|${status}|${rootDialogId.selfId}`;
    const matchesRootDialogKey = (key: string): boolean =>
      key === basePrefix || key.startsWith(`${basePrefix}#`) || key.startsWith(`${basePrefix}|`);

    for (const [key, entry] of this.latestWriteBack.entries()) {
      if (!matchesRootDialogKey(key)) continue;
      if (entry.kind === 'scheduled') {
        clearTimeout(entry.timer);
      }
      this.latestWriteBack.delete(key);
    }
    for (const key of this.latestWriteBackMutexes.keys()) {
      if (matchesRootDialogKey(key)) {
        this.latestWriteBackMutexes.delete(key);
      }
    }

    for (const [key, entry] of this.q4hWriteBack.entries()) {
      if (!matchesRootDialogKey(key)) continue;
      if (entry.kind === 'scheduled') {
        clearTimeout(entry.timer);
      }
      this.q4hWriteBack.delete(key);
    }
    for (const key of this.q4hWriteBackMutexes.keys()) {
      if (matchesRootDialogKey(key)) {
        this.q4hWriteBackMutexes.delete(key);
      }
    }

    for (const [key, entry] of this.pendingSubdialogsWriteBack.entries()) {
      if (!matchesRootDialogKey(key)) continue;
      if (entry.kind === 'scheduled') {
        clearTimeout(entry.timer);
      }
      this.pendingSubdialogsWriteBack.delete(key);
    }
    for (const key of this.pendingSubdialogsWriteBackMutexes.keys()) {
      if (matchesRootDialogKey(key)) {
        this.pendingSubdialogsWriteBackMutexes.delete(key);
      }
    }

    for (const key of this.courseAppendMutexes.keys()) {
      if (matchesRootDialogKey(key)) {
        this.courseAppendMutexes.delete(key);
      }
    }
  }

  private static async quarantineMalformedDialog(
    dialogId: DialogID,
    status: DialogStatusKind,
    reason: string,
    error: Error,
  ): Promise<void> {
    const rootDialogId =
      dialogId.rootId === dialogId.selfId ? dialogId : new DialogID(dialogId.rootId);
    const quarantineKey = `${status}|${rootDialogId.selfId}`;
    if (quarantiningRootDialogs.has(quarantineKey)) {
      return;
    }
    quarantiningRootDialogs.add(quarantineKey);
    let quarantined = false;
    try {
      await prepareDialogQuarantineHook?.({
        dialogId,
        rootDialogId,
        status,
        reason,
        error,
      });
      this.quarantinedRootDialogScopes.add(
        this.getRootDialogWriteBackCancelScopeKey(rootDialogId, status),
      );
      this.cancelRootDialogWriteBacks(rootDialogId, status);

      const sourcePath = this.getRootDialogPath(rootDialogId, status);
      if (!(await this.pathExists(sourcePath))) {
        return;
      }

      let destinationPath = this.getMalformedRootDialogPath(rootDialogId, status);
      if (await this.pathExists(destinationPath)) {
        destinationPath = path.join(
          this.getDialogsRootDir(),
          this.MALFORMED_DIR,
          `${rootDialogId.selfId}__${randomUUID()}`,
        );
      }

      await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.promises.rename(sourcePath, destinationPath);
      quarantined = true;
      log.warn(`Quarantined malformed dialog ${rootDialogId.selfId}`, undefined, {
        status,
        reason,
        sourcePath,
        destinationPath,
        errorMessage: error.message,
        dialogId: dialogId.valueOf(),
        rootDialogId: rootDialogId.valueOf(),
      });
      dialogsQuarantinedBroadcaster?.({
        type: 'dialogs_quarantined',
        status: 'quarantining',
        fromStatus: assertPersistableDialogStatus(
          status,
          'DialogPersistence.quarantineMalformedDialog(fromStatus)',
        ),
        rootId: rootDialogId.selfId,
        dialogId: dialogId.selfId,
        reason,
        timestamp: formatUnifiedTimestamp(new Date()),
      });
    } finally {
      try {
        await finalizeDialogQuarantineHook?.({
          dialogId,
          rootDialogId,
          status,
          reason,
          error,
          quarantined,
        });
      } finally {
        quarantiningRootDialogs.delete(quarantineKey);
      }
    }
  }

  private static async rethrowAfterQuarantiningDialogPersistenceProblem(
    dialogId: DialogID,
    status: DialogStatusKind,
    reason: string,
    error: unknown,
  ): Promise<never> {
    const persistenceError = findDomindsPersistenceFileError(error);
    if (persistenceError) {
      await this.quarantineMalformedDialog(dialogId, status, reason, persistenceError);
      throw persistenceError;
    }
    throw error;
  }

  private static parseDialogLatestYaml(content: string, latestFilePath: string): DialogLatestFile {
    const parsed = parsePersistenceYaml({
      content,
      filePath: latestFilePath,
      source: 'dialog_latest',
    });
    const latest = parseDialogLatestFile(parsed);
    if (!latest) {
      throw buildInvalidPersistenceFileError({
        source: 'dialog_latest',
        format: 'yaml',
        filePath: latestFilePath,
      });
    }
    return latest;
  }

  /**
   * Ensure dialog directory structure exists
   */
  static async ensureRootDialogDirectory(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<string> {
    const dialogPath = this.getRootDialogPath(dialogId, status);

    try {
      await fs.promises.mkdir(dialogPath, { recursive: true });
      return dialogPath;
    } catch (error) {
      log.error(`Failed to create dialog directory ${dialogPath}:`, error);
      throw error;
    }
  }

  /**
   * Ensure subdialog directory structure exists
   */
  static async ensureSubdialogDirectory(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<string> {
    const subdialogPath = this.getSubdialogPath(dialogId, status);

    try {
      await fs.promises.mkdir(subdialogPath, { recursive: true });
      return subdialogPath;
    } catch (error) {
      log.error(`Failed to create subdialog directory ${subdialogPath}:`, error);
      throw error;
    }
  }

  /**
   * Mark a dialog as completed
   */
  static async markDialogCompleted(dialogId: DialogID): Promise<void> {
    try {
      const dialogPath = this.getRootDialogPath(dialogId, 'running');
      const completedPath = this.getRootDialogPath(dialogId, 'completed');

      await fs.promises.mkdir(completedPath, { recursive: true });

      // Move files from current to completed
      const files = await fs.promises.readdir(dialogPath);
      for (const file of files) {
        const src = path.join(dialogPath, file);
        const dest = path.join(completedPath, file);
        await fs.promises.rename(src, dest);
      }
    } catch (error) {
      log.error(`Failed to mark dialog ${dialogId} as completed:`, error);
      throw error;
    }
  }

  /**
   * List candidate root dialog IDs by scanning `dialog.yaml`.
   *
   * This scanner intentionally stays lightweight: it only validates the path<->id identity needed
   * for safe enumeration, and leaves full metadata shape validation to the subsequent lazy-load
   * step. Callers iterating these candidate IDs must therefore tolerate per-dialog load failures
   * and continue after a malformed dialog is quarantined.
   */
  static async listDialogs(status: DialogStatusKind = 'running'): Promise<string[]> {
    try {
      const statusDir = this.getDialogsRootDir();
      const specificDir = path.join(
        statusDir,
        getPersistableStatusDirName(status, 'DialogPersistence.listDialogs'),
      );

      const validDialogIds: string[] = [];

      // Recursively find all dialog.yaml files
      const findDialogYamls = async (dirPath: string, relativePath: string = ''): Promise<void> => {
        try {
          const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

          for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            const entryRelativePath = path.join(relativePath, entry.name);

            if (entry.isDirectory()) {
              // Recursively search subdirectories
              await findDialogYamls(fullPath, entryRelativePath);
            } else if (entry.name === 'dialog.yaml') {
              // Found a dialog.yaml file. We only validate path<->id identity here; full metadata
              // shape remains lazy-loaded by the caller-specific read path.
              try {
                const content = await readPersistenceTextFile({
                  filePath: fullPath,
                  source: 'dialog_metadata',
                  format: 'yaml',
                });
                const parsed = parsePersistenceYaml({
                  content,
                  filePath: fullPath,
                  source: 'dialog_metadata',
                });
                if (!isRecord(parsed) || typeof parsed.id !== 'string' || parsed.id.trim() === '') {
                  throw buildInvalidPersistenceFileError({
                    source: 'dialog_metadata',
                    format: 'yaml',
                    filePath: fullPath,
                  });
                }
                const expectedDialogId = this.inferExpectedDialogIdFromMetadataRelativeDir(
                  path.dirname(entryRelativePath),
                );
                if (expectedDialogId === null || parsed.id !== expectedDialogId) {
                  throw buildInvalidPersistenceFileError({
                    source: 'dialog_metadata',
                    format: 'yaml',
                    filePath: fullPath,
                  });
                }
                validDialogIds.push(parsed.id);
              } catch (yamlError: unknown) {
                const persistenceError = findDomindsPersistenceFileError(yamlError);
                if (persistenceError) {
                  const rootDialogId = this.inferRootDialogIdFromMetadataRelativeDir(
                    path.dirname(entryRelativePath),
                  );
                  if (rootDialogId) {
                    await this.quarantineMalformedDialog(
                      rootDialogId,
                      status,
                      'listDialogs',
                      persistenceError,
                    );
                  }
                }
                log.warn(`🔍 listDialogs: Failed to parse dialog.yaml at ${fullPath}:`, yamlError);
              }
            }
          }
        } catch (error) {
          // Directory enumeration failures are filesystem-level access/I/O problems, not evidence
          // that a specific dialog record is malformed. If we cannot even read this directory,
          // attempting to quarantine a child dialog via move/rename is unlikely to be reliable.
          log.warn(`🔍 listDialogs: Error reading directory ${dirPath}:`, error);
        }
      };

      try {
        // Only ENOENT means "status directory absent". Other stat failures are loud environment
        // errors and must flow into the warning path below instead of being silently downgraded.
        try {
          await fs.promises.stat(specificDir);
        } catch (error: unknown) {
          if (getErrorCode(error) === 'ENOENT') {
            return validDialogIds;
          }
          throw error;
        }
        await findDialogYamls(specificDir);
        return validDialogIds;
      } catch (error) {
        // Same rationale as the inner readdir catch above: keep the failure loud in logs, but do
        // not pretend we have actionable malformed-dialog evidence when the status directory itself
        // is not readable.
        log.warn(`🔍 listDialogs: Error processing directory ${specificDir}:`, error);
        return [];
      }
    } catch (error) {
      log.error('Failed to list dialogs:', error);
      return [];
    }
  }

  /**
   * List all dialog IDs (root + subdialogs) together with their root IDs.
   * This is the only safe way to enumerate subdialogs because their directory names
   * are not guaranteed to be their selfId.
   *
   * Like `listDialogs()`, this is a candidate scanner rather than a full metadata validator.
   * Callers must treat later metadata/latest loads as lazy, per-dialog operations that can still
   * quarantine one dialog without invalidating the rest of the enumeration.
   */
  static async listAllDialogIds(status: DialogStatusKind = 'running'): Promise<DialogID[]> {
    const statusDir = this.getDialogsRootDir();
    const specificDir = path.join(
      statusDir,
      getPersistableStatusDirName(status, 'DialogPersistence.listAllDialogIds'),
    );

    const result: DialogID[] = [];
    const rootDialogIdByDialogYamlPath = new Map<string, string | null>();

    const readDialogYamlId = async (dialogYamlPath: string): Promise<string | null> => {
      const cached = rootDialogIdByDialogYamlPath.get(dialogYamlPath);
      if (cached !== undefined) return cached;
      try {
        const content = await readPersistenceTextFile({
          filePath: dialogYamlPath,
          source: 'dialog_metadata',
          format: 'yaml',
        });
        const parsed: unknown = parsePersistenceYaml({
          content,
          filePath: dialogYamlPath,
          source: 'dialog_metadata',
        });
        if (typeof parsed !== 'object' || parsed === null) {
          throw buildInvalidPersistenceFileError({
            source: 'dialog_metadata',
            format: 'yaml',
            filePath: dialogYamlPath,
          });
        }
        const idValue = (parsed as { id?: unknown }).id;
        if (typeof idValue !== 'string' || idValue.trim() === '') {
          throw buildInvalidPersistenceFileError({
            source: 'dialog_metadata',
            format: 'yaml',
            filePath: dialogYamlPath,
          });
        }
        const normalized = idValue.trim();
        rootDialogIdByDialogYamlPath.set(dialogYamlPath, normalized);
        return normalized;
      } catch (error: unknown) {
        const persistenceError = findDomindsPersistenceFileError(error);
        if (persistenceError) {
          const relativeDir = path.relative(specificDir, path.dirname(dialogYamlPath));
          const rootDialogId = this.inferRootDialogIdFromMetadataRelativeDir(relativeDir);
          if (rootDialogId) {
            await this.quarantineMalformedDialog(
              rootDialogId,
              status,
              'listAllDialogIds:readDialogYamlId',
              persistenceError,
            );
          }
        }
        rootDialogIdByDialogYamlPath.set(dialogYamlPath, null);
        return null;
      }
    };

    const inferRootIdFromRelativeDir = async (relativeDir: string): Promise<string | null> => {
      const dir = relativeDir.trim();
      if (dir === '' || dir === '.' || dir === path.sep) return null;
      const segments = dir.split(path.sep).filter((seg) => seg.length > 0 && seg !== '.');
      if (segments.length === 0) return null;

      // Root dialog IDs in this repo can contain path separators (e.g. "f4/44/cd85c4e2").
      // The root dialog directory is therefore nested (RUN_DIR/<rootId>/dialog.yaml).
      //
      // To infer the rootId for any dialog.yaml we find (root or subdialog), scan prefixes of the
      // directory path and pick the first prefix that is itself a valid root dialog directory:
      // - it has a dialog.yaml
      // - its dialog.yaml id matches the prefix joined with '/'
      for (let i = 1; i <= segments.length; i++) {
        const prefixSegs = segments.slice(0, i);
        const candidateDialogYamlPath = path.join(specificDir, ...prefixSegs, 'dialog.yaml');
        const id = await readDialogYamlId(candidateDialogYamlPath);
        const expectedId = prefixSegs.join('/');
        if (id === expectedId) return expectedId;
      }
      return null;
    };

    const findDialogYamls = async (dirPath: string, relativePath: string = ''): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch (err) {
        // This is an environment/filesystem failure rather than confirmed dialog corruption. We log
        // loudly and keep enumeration partial instead of fabricating a quarantine target that may
        // not even be reachable through the same broken directory path.
        log.warn(`🔍 listAllDialogIds: Error reading directory ${dirPath}:`, err);
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const entryRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;

        if (entry.isDirectory()) {
          await findDialogYamls(fullPath, entryRelativePath);
          continue;
        }
        if (entry.name !== 'dialog.yaml') continue;

        const relDir = path.dirname(entryRelativePath);
        const rootId = await inferRootIdFromRelativeDir(relDir);
        if (!rootId) continue;

        try {
          const content = await readPersistenceTextFile({
            filePath: fullPath,
            source: 'dialog_metadata',
            format: 'yaml',
          });
          const parsed: unknown = parsePersistenceYaml({
            content,
            filePath: fullPath,
            source: 'dialog_metadata',
          });
          if (typeof parsed !== 'object' || parsed === null) {
            throw buildInvalidPersistenceFileError({
              source: 'dialog_metadata',
              format: 'yaml',
              filePath: fullPath,
            });
          }
          const idValue = (parsed as { id?: unknown }).id;
          if (typeof idValue !== 'string' || idValue.trim() === '') {
            throw buildInvalidPersistenceFileError({
              source: 'dialog_metadata',
              format: 'yaml',
              filePath: fullPath,
            });
          }
          const expectedDialogId = this.inferExpectedDialogIdFromMetadataRelativeDir(relDir);
          if (expectedDialogId === null || idValue !== expectedDialogId) {
            throw buildInvalidPersistenceFileError({
              source: 'dialog_metadata',
              format: 'yaml',
              filePath: fullPath,
            });
          }
          result.push(new DialogID(idValue, rootId));
        } catch (yamlError: unknown) {
          const persistenceError = findDomindsPersistenceFileError(yamlError);
          if (persistenceError) {
            const rootDialogId = this.inferRootDialogIdFromMetadataRelativeDir(relDir);
            if (rootDialogId) {
              await this.quarantineMalformedDialog(
                rootDialogId,
                status,
                'listAllDialogIds',
                persistenceError,
              );
            }
          }
          log.warn(`🔍 listAllDialogIds: Failed to parse dialog.yaml at ${fullPath}:`, yamlError);
        }
      }
    };

    try {
      // Only ENOENT is the benign "no dialogs under this status" case. Permission/I/O failures
      // must stay loud so operators can tell the difference between "missing" and "inaccessible".
      await fs.promises.stat(specificDir);
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') {
        return [];
      }
      throw error;
    }

    await findDialogYamls(specificDir);
    return result;
  }

  // === NEW JSONL COURSE-BASED METHODS ===

  /**
   * Append event to course JSONL file (append-only pattern)
   */
  static async appendEvents(
    dialogId: DialogID,
    course: number,
    events: readonly PersistedDialogRecord[],
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    const appendMutexKey = this.getCourseAppendMutexKey(dialogId, course, status);
    const release = await this.getCourseAppendMutex(appendMutexKey).acquire();
    const cancellationToken = this.createRootDialogWriteBackCancellationToken(dialogId, status);
    try {
      if (events.length === 0) {
        return;
      }
      await this.assertDialogMetadataExistsForAppend(
        dialogId,
        status,
        cancellationToken,
        'appendEvents:start',
      );
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const courseFilename = this.getCourseFilename(course);
      const courseFilePath = path.join(dialogPath, courseFilename);

      // Serialize appends per dialog+course file. Concurrent `appendFile` calls can interleave and
      // corrupt JSONL lines (e.g. tool results appended in parallel), which later manifests as
      // `Unterminated string in JSON ...` during resume.
      const serialized = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
      try {
        await fs.promises.appendFile(courseFilePath, serialized, 'utf-8');
      } catch (error: unknown) {
        await this.rethrowWriteBackPathMissingAsCanceled(
          error,
          dialogPath,
          cancellationToken,
          'appendEvents:append-file',
        );
        throw error;
      }
      await this.assertDialogMetadataExistsForAppend(
        dialogId,
        status,
        cancellationToken,
        'appendEvents:after-append',
      );

      // Update latest.yaml with new lastModified timestamp
      await this.mutateDialogLatest(
        dialogId,
        () => ({
          kind: 'patch',
          patch: {
            lastModified: formatUnifiedTimestamp(new Date()),
            currentCourse: course,
          },
        }),
        status,
        cancellationToken,
      );
    } catch (error) {
      if (isDialogWriteBackCanceledError(error)) {
        await this.cleanupCanceledAppendPlaceholder(dialogId, status);
        return;
      }
      log.error(`Failed to append events to dialog ${dialogId} course ${course}:`, error);
      throw error;
    } finally {
      release();
    }
  }

  static async appendEvent(
    dialogId: DialogID,
    course: number,
    event: PersistedDialogRecord,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    await this.appendEvents(dialogId, course, [event], status);
  }

  static async persistRuntimeGuide(dialog: Dialog, content: string, genseq: number): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const ev: RuntimeGuideRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'runtime_guide_record',
      genseq,
      content,
    };
    await this.appendEvent(dialog.id, course, ev, dialog.status);
  }

  /**
   * Capture the current byte offset of a course JSONL file.
   * Used as rollback checkpoint before a streaming LLM attempt.
   */
  static async captureCourseFileOffset(
    dialogId: DialogID,
    course: number,
    status: DialogStatusKind = 'running',
  ): Promise<number> {
    const appendMutexKey = this.getCourseAppendMutexKey(dialogId, course, status);
    const release = await this.getCourseAppendMutex(appendMutexKey).acquire();
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const courseFilePath = path.join(dialogPath, this.getCourseFilename(course));
      try {
        const st = await fs.promises.stat(courseFilePath);
        return st.size;
      } catch (err) {
        if (getErrorCode(err) === 'ENOENT') {
          return 0;
        }
        throw err;
      }
    } finally {
      release();
    }
  }

  /**
   * Rollback a course JSONL file to a previously captured byte offset.
   * This is used to discard partial streaming artifacts before retrying.
   */
  static async rollbackCourseFileToOffset(
    dialogId: DialogID,
    course: number,
    offset: number,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    if (!Number.isFinite(offset) || offset < 0) {
      throw new Error(
        `Invalid rollback offset: dialog=${dialogId.valueOf()} course=${String(course)} offset=${String(
          offset,
        )}`,
      );
    }
    const normalizedOffset = Math.floor(offset);
    const appendMutexKey = this.getCourseAppendMutexKey(dialogId, course, status);
    const release = await this.getCourseAppendMutex(appendMutexKey).acquire();
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const courseFilePath = path.join(dialogPath, this.getCourseFilename(course));
      let currentSize = 0;
      try {
        const st = await fs.promises.stat(courseFilePath);
        currentSize = st.size;
      } catch (err) {
        if (getErrorCode(err) !== 'ENOENT') {
          throw err;
        }
        if (normalizedOffset === 0) {
          return;
        }
        throw new Error(
          `Rollback target missing: dialog=${dialogId.valueOf()} course=${String(course)} offset=${String(
            normalizedOffset,
          )}`,
        );
      }

      if (normalizedOffset > currentSize) {
        throw new Error(
          `Rollback offset beyond file size: dialog=${dialogId.valueOf()} course=${String(
            course,
          )} offset=${String(normalizedOffset)} size=${String(currentSize)}`,
        );
      }
      if (normalizedOffset === currentSize) {
        return;
      }

      await fs.promises.truncate(courseFilePath, normalizedOffset);
      await this.mutateDialogLatest(
        dialogId,
        () => ({
          kind: 'patch',
          patch: { lastModified: formatUnifiedTimestamp(new Date()) },
        }),
        status,
      );
      log.warn('Rolled back course JSONL after streaming retry', undefined, {
        dialogId: dialogId.valueOf(),
        course,
        status,
        fromSize: currentSize,
        toSize: normalizedOffset,
      });
    } finally {
      release();
    }
  }

  /**
   * Read all events from course JSONL file
   */
  static async readCourseEvents(
    dialogId: DialogID,
    course: number,
    status: DialogStatusKind = 'running',
  ): Promise<PersistedDialogRecord[]> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const courseFilePath = path.join(dialogPath, this.getCourseFilename(course));

      try {
        const content = await readPersistenceTextFile({
          filePath: courseFilePath,
          source: 'dialog_course_events',
          format: 'jsonl',
        });
        const events: PersistedDialogRecord[] = [];

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.trim()) continue;
          try {
            events.push(
              parsePersistenceJson({
                content: line,
                filePath: courseFilePath,
                source: 'dialog_course_events',
                lineNumber: i + 1,
              }) as PersistedDialogRecord,
            );
          } catch (err) {
            const isLastNonEmptyLine = (() => {
              for (let j = lines.length - 1; j > i; j--) {
                if (lines[j].trim().length > 0) return false;
              }
              return true;
            })();
            const persistenceFileError =
              err instanceof DomindsPersistenceFileError ? err : undefined;
            const msg = err instanceof Error ? err.message : String(err);
            // If the last JSONL line was truncated (e.g. process crash mid-append), ignore it so
            // dialogs remain resumable. Do not mask corruption in the middle of the file.
            if (
              isLastNonEmptyLine &&
              (persistenceFileError?.eofLike === true ||
                msg.includes('Unterminated string in JSON') ||
                msg.includes('Unexpected end of JSON input'))
            ) {
              log.warn(
                `Ignoring truncated JSONL tail for dialog ${dialogId} course ${course} at line ${i + 1}: ${msg}`,
              );
              break;
            }
            if (persistenceFileError) {
              throw persistenceFileError;
            }
            throw buildInvalidPersistenceFileError({
              source: 'dialog_course_events',
              format: 'jsonl',
              filePath: courseFilePath,
              lineNumber: i + 1,
              cause: err,
            });
          }
        }

        return events;
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          // Course file doesn't exist - return empty array
          return [];
        }
        throw error;
      }
    } catch (error) {
      log.error(`Failed to read course events for dialog ${dialogId} course ${course}:`, error);
      throw error;
    }
  }

  /**
   * Compute next sequence number for a course by scanning existing events
   */
  static async getNextSeq(
    dialogId: DialogID,
    course: number,
    status: DialogStatusKind = 'running',
  ): Promise<number> {
    const events = await this.readCourseEvents(dialogId, course, status);
    let maxSeq = 0;
    for (const ev of events) {
      if ('genseq' in ev && typeof ev.genseq === 'number' && ev.genseq > maxSeq) {
        maxSeq = ev.genseq;
      }
    }
    return maxSeq + 1;
  }

  /**
   * Get current course number from latest.yaml (performance optimization)
   * UI navigation can assume natural numbering schema back to 1
   */
  static async getCurrentCourseNumber(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<number> {
    try {
      const latest = await this.loadDialogLatest(dialogId, status);
      return latest?.currentCourse || 1;
    } catch (error) {
      log.error(`Failed to get current course for dialog ${dialogId}:`, error);
      return 1;
    }
  }

  /**
   * Save reminder state (exceptional overwrite pattern) (internal use only)
   */
  public static async _saveReminderState(
    dialogId: DialogID,
    reminders: Reminder[],
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const remindersFilePath = path.join(dialogPath, 'reminders.json');

      const reminderState: ReminderStateFile = {
        reminders: reminders.map((r) => ({
          id: r.id,
          content: r.content,
          ownerName: r.owner ? r.owner.name : undefined,
          meta: r.meta,
          echoback: r.echoback,
          scope: r.scope ?? 'dialog',
          createdAt: r.createdAt ?? formatUnifiedTimestamp(new Date()),
          priority: r.priority ?? 'medium',
        })),
        updatedAt: formatUnifiedTimestamp(new Date()),
      };

      // Atomic write operation
      const jsonContent = JSON.stringify(reminderState, null, 2);
      const tempFile = path.join(
        dialogPath,
        `.${path.basename(remindersFilePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      await fs.promises.writeFile(tempFile, jsonContent, 'utf-8');
      await this.renameWithRetry(tempFile, remindersFilePath);
    } catch (error) {
      log.error(`Failed to save reminder state for dialog ${dialogId}:`, error);
      throw error;
    }
  }

  /**
   * Load reminder state
   */
  static async loadReminderState(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<Reminder[]> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const remindersFilePath = path.join(dialogPath, 'reminders.json');

      try {
        const content = await readPersistenceTextFile({
          filePath: remindersFilePath,
          source: 'reminder_state',
          format: 'json',
        });
        const reminderState = parsePersistenceJson({
          content,
          filePath: remindersFilePath,
          source: 'reminder_state',
        });
        if (!isReminderStateFile(reminderState)) {
          throw buildInvalidPersistenceFileError({
            source: 'reminder_state',
            format: 'json',
            filePath: remindersFilePath,
          });
        }
        return reminderState.reminders.map((r) => {
          const ownerNameFromFile = typeof r.ownerName === 'string' ? r.ownerName : undefined;
          // Reminder metadata is owner-private. Rebind strictly through persisted ownerName.
          const owner = ownerNameFromFile ? getReminderOwner(ownerNameFromFile) : undefined;
          return materializeReminder({
            id: r.id,
            content: r.content,
            owner,
            meta: r.meta,
            echoback: r.echoback,
            scope: r.scope ?? 'dialog',
            createdAt: r.createdAt,
            priority: r.priority,
          });
        });
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          // reminders.json doesn't exist - return empty array
          return [];
        }
        throw error;
      }
    } catch (error: unknown) {
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        dialogId,
        status,
        'loadReminderState',
        error,
      );
      throw new Error('unreachable after loadReminderState persistence rethrow');
    }
  }

  /**
   * Save questions for human state (exceptional overwrite pattern) (internal use only)
   */
  public static async _saveQuestions4HumanState(
    dialogId: DialogID,
    questions: HumanQuestion[],
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    const nextQuestions = [...questions];
    await this.mutateQuestions4HumanState(
      dialogId,
      () => ({ kind: 'replace', questions: nextQuestions }),
      status,
    );
  }

  /**
   * Load questions for human state
   */
  static async loadQuestions4HumanState(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<HumanQuestion[]> {
    const key = this.getQ4HWriteBackKey(dialogId, status);
    const staged = this.q4hWriteBack.get(key);
    if (staged) {
      if (staged.state.kind === 'deleted') return [];
      return staged.state.file.questions;
    }

    try {
      return await this.loadQuestions4HumanStateFromDisk(dialogId, status);
    } catch (error: unknown) {
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        dialogId,
        status,
        'loadQuestions4HumanState',
        error,
      );
      throw new Error('unreachable after loadQuestions4HumanState persistence rethrow');
    }
  }

  private static async loadQuestions4HumanStateFromDisk(
    dialogId: DialogID,
    status: DialogStatusKind,
  ): Promise<HumanQuestion[]> {
    const dialogPath = this.getDialogEventsPath(dialogId, status);
    const questionsFilePath = path.join(dialogPath, 'q4h.yaml');

    try {
      const content = await readPersistenceTextFile({
        filePath: questionsFilePath,
        source: 'questions4human_state',
        format: 'yaml',
      });
      const parsed = parsePersistenceYaml({
        content,
        filePath: questionsFilePath,
        source: 'questions4human_state',
      });
      if (!isQuestions4HumanFile(parsed)) {
        throw buildInvalidPersistenceFileError({
          source: 'questions4human_state',
          format: 'yaml',
          filePath: questionsFilePath,
        });
      }
      return parsed.questions;
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  static async mutateQuestions4HumanState(
    dialogId: DialogID,
    mutator: (previous: HumanQuestion[]) => Q4HMutation,
    status: DialogStatusKind = 'running',
  ): Promise<Q4HMutateOutcome> {
    const key = this.getQ4HWriteBackKey(dialogId, status);
    const mutex = this.getQ4HWriteBackMutex(key);

    const release = await mutex.acquire();
    try {
      const staged = this.q4hWriteBack.get(key);
      const previousQuestions =
        staged && staged.state.kind === 'file'
          ? staged.state.file.questions
          : staged && staged.state.kind === 'deleted'
            ? []
            : await this.loadQuestions4HumanStateFromDisk(dialogId, status);

      const mutation = mutator(previousQuestions);

      let removedQuestion: HumanQuestion | undefined;
      let nextState: Q4HWriteBackState | undefined;
      let nextQuestions: HumanQuestion[] = previousQuestions;

      if (mutation.kind === 'noop') {
        return { previousQuestions, questions: previousQuestions };
      } else if (mutation.kind === 'append') {
        nextQuestions = [...previousQuestions, mutation.question];
      } else if (mutation.kind === 'remove') {
        const idx = previousQuestions.findIndex((q) => q.id === mutation.questionId);
        if (idx === -1) {
          return { previousQuestions, questions: previousQuestions };
        }
        removedQuestion = previousQuestions[idx];
        nextQuestions = previousQuestions.filter((q) => q.id !== mutation.questionId);
      } else if (mutation.kind === 'replace') {
        nextQuestions = [...mutation.questions];
      } else if (mutation.kind === 'clear') {
        nextQuestions = [];
      } else {
        const _exhaustive: never = mutation;
        throw new Error(`Unhandled q4h mutation: ${String(_exhaustive)}`);
      }

      if (nextQuestions.length === 0) {
        nextState = { kind: 'deleted' };
      } else {
        nextState = {
          kind: 'file',
          file: { questions: nextQuestions, updatedAt: formatUnifiedTimestamp(new Date()) },
        };
      }

      const pending = this.q4hWriteBack.get(key);
      if (!pending) {
        const timer = setTimeout(() => {
          void this.flushQ4HWriteBack(key);
        }, this.Q4H_WRITEBACK_WINDOW_MS);

        this.q4hWriteBack.set(key, {
          kind: 'scheduled',
          dialogId,
          status,
          state: nextState,
          timer,
        });
        return { previousQuestions, questions: nextQuestions, removedQuestion };
      }

      pending.state = nextState;
      if (pending.kind === 'flushing') {
        pending.dirty = true;
      }

      return { previousQuestions, questions: nextQuestions, removedQuestion };
    } finally {
      release();
    }
  }

  static async appendQuestion4HumanState(
    dialogId: DialogID,
    question: HumanQuestion,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    const questionId = question.id;
    const normalizedCallId = question.callId.trim();
    if (normalizedCallId === '') {
      throw new Error(
        `Q4H append invariant violation: empty callId (dialog=${dialogId.valueOf()} questionId=${questionId})`,
      );
    }

    await this.mutateQuestions4HumanState(
      dialogId,
      (previousQuestions) => {
        const byId = previousQuestions.find((q) => q.id === questionId);
        if (byId) {
          throw new Error(
            `Q4H duplicate question id violation: dialog=${dialogId.valueOf()} status=${status} questionId=${questionId} existingAskedAt=${byId.askedAt} incomingAskedAt=${question.askedAt}`,
          );
        }

        const byCallId = previousQuestions.find((q) => q.callId.trim() === normalizedCallId);
        if (byCallId) {
          throw new Error(
            `Q4H duplicate call id violation: dialog=${dialogId.valueOf()} status=${status} callId=${normalizedCallId} existingQuestionId=${byCallId.id} incomingQuestionId=${questionId} existingAskedAt=${byCallId.askedAt} incomingAskedAt=${question.askedAt}`,
          );
        }

        if (previousQuestions.length > 0) {
          const existingIds = previousQuestions.map((q) => q.id).join(',');
          const existingCallIds = previousQuestions
            .map((q) => q.callId.trim())
            .filter((value) => value !== '')
            .join(',');
          throw new Error(
            `Q4H multi-pending violation: dialog=${dialogId.valueOf()} status=${status} existingCount=${previousQuestions.length} existingQuestionIds=${existingIds} existingCallIds=${existingCallIds} incomingQuestionId=${questionId} incomingCallId=${normalizedCallId}`,
          );
        }

        return { kind: 'append', question };
      },
      status,
    );
  }

  static async removeQuestion4HumanState(
    dialogId: DialogID,
    questionId: string,
    status: DialogStatusKind = 'running',
  ): Promise<{
    found: boolean;
    remainingQuestions: HumanQuestion[];
    removedQuestion?: HumanQuestion;
  }> {
    const out = await this.mutateQuestions4HumanState(
      dialogId,
      () => ({ kind: 'remove', questionId }),
      status,
    );
    return {
      found: typeof out.removedQuestion !== 'undefined',
      remainingQuestions: out.questions,
      removedQuestion: out.removedQuestion,
    };
  }

  private static async flushQ4HWriteBack(key: string): Promise<void> {
    const mutex = this.getQ4HWriteBackMutex(key);

    let captured:
      | {
          dialogId: DialogID;
          status: DialogStatusKind;
          stateToWrite: Q4HWriteBackState;
          inFlight: Promise<void>;
        }
      | undefined;

    {
      const release = await mutex.acquire();
      try {
        const entry = this.q4hWriteBack.get(key);
        if (!entry) return;
        if (entry.kind === 'flushing') return;
        if (entry.kind !== 'scheduled') return;

        clearTimeout(entry.timer);

        const cancellationToken = this.createRootDialogWriteBackCancellationToken(
          entry.dialogId,
          entry.status,
        );
        const inFlight = this.writeQ4HStateToDisk(
          entry.dialogId,
          entry.state,
          entry.status,
          cancellationToken,
        );
        captured = {
          dialogId: entry.dialogId,
          status: entry.status,
          stateToWrite: entry.state,
          inFlight,
        };

        this.q4hWriteBack.set(key, {
          kind: 'flushing',
          dialogId: entry.dialogId,
          status: entry.status,
          state: entry.state,
          dirty: false,
          inFlight,
        });
      } finally {
        release();
      }
    }

    if (!captured) return;

    try {
      await captured.inFlight;
    } catch (error) {
      const release = await mutex.acquire();
      try {
        const entry = this.q4hWriteBack.get(key);
        if (!entry) return;
        if (entry.kind !== 'flushing') return;
        if (entry.inFlight !== captured.inFlight) return;
        if (isDialogWriteBackCanceledError(error)) {
          this.q4hWriteBack.delete(key);
          return;
        }

        const timer = setTimeout(() => {
          void this.flushQ4HWriteBack(key);
        }, this.Q4H_WRITEBACK_WINDOW_MS);

        this.q4hWriteBack.set(key, {
          kind: 'scheduled',
          dialogId: entry.dialogId,
          status: entry.status,
          state: entry.state,
          timer,
        });
      } finally {
        release();
      }
      return;
    }

    const release = await mutex.acquire();
    try {
      const entry = this.q4hWriteBack.get(key);
      if (!entry) return;
      if (entry.kind !== 'flushing') return;
      if (entry.inFlight !== captured.inFlight) return;

      if (!entry.dirty) {
        this.q4hWriteBack.delete(key);
        return;
      }

      const timer = setTimeout(() => {
        void this.flushQ4HWriteBack(key);
      }, this.Q4H_WRITEBACK_WINDOW_MS);

      this.q4hWriteBack.set(key, {
        kind: 'scheduled',
        dialogId: entry.dialogId,
        status: entry.status,
        state: entry.state,
        timer,
      });
    } finally {
      release();
    }
  }

  private static async writeQ4HStateToDisk(
    dialogId: DialogID,
    state: Q4HWriteBackState,
    status: DialogStatusKind,
    cancellationToken?: RootDialogWriteBackCancellationToken,
  ): Promise<void> {
    if (cancellationToken) {
      this.assertRootDialogWriteBackNotCanceled(cancellationToken, 'writeQ4HStateToDisk:start');
    }
    const dialogPath = this.getDialogEventsPath(dialogId, status);
    const questionsFilePath = path.join(dialogPath, 'q4h.yaml');

    if (state.kind === 'deleted') {
      await fs.promises.rm(questionsFilePath, { force: true });
      return;
    }

    const yamlContent = yaml.stringify(state.file);
    const tempFile = path.join(
      dialogPath,
      `.${path.basename(questionsFilePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await fs.promises.writeFile(tempFile, yamlContent, 'utf-8');
    } catch (error: unknown) {
      await this.rethrowWriteBackPathMissingAsCanceled(
        error,
        dialogPath,
        cancellationToken,
        'writeQ4HStateToDisk:write-temp',
      );
      throw error;
    }
    await this.renameWithRetry(tempFile, questionsFilePath, 5, cancellationToken);
  }

  /**
   * Load all Q4H questions from all running dialogs (for global Q4H display)
   * Returns array of questions with their dialog context for frontend display
   */
  static async loadAllQ4HState(): Promise<
    Array<{
      id: string;
      selfId: string;
      rootId: string;
      agentId: string;
      taskDocPath: string;
      tellaskContent: string;
      askedAt: string;
      callId: string;
      callSiteRef: { course: number; messageIndex: number };
    }>
  > {
    try {
      // Get all running dialogs (root + subdialogs) with correct rootId association.
      const dialogIds = await this.listAllDialogIds('running');
      const allQuestions: Array<{
        id: string;
        selfId: string;
        rootId: string;
        agentId: string;
        taskDocPath: string;
        tellaskContent: string;
        askedAt: string;
        callId: string;
        callSiteRef: { course: number; messageIndex: number };
      }> = [];

      for (const dialogIdObj of dialogIds) {
        try {
          const questions = await this.loadQuestions4HumanState(dialogIdObj, 'running');
          if (questions.length === 0) {
            continue;
          }

          const metadata = await this.loadDialogMetadata(dialogIdObj, 'running');

          if (metadata) {
            for (const q of questions) {
              allQuestions.push({
                ...q,
                selfId: dialogIdObj.selfId,
                rootId: dialogIdObj.rootId,
                agentId: metadata.agentId,
                taskDocPath: metadata.taskDocPath,
              });
            }
          }
        } catch (err) {
          log.warn(`Failed to load Q4H for dialog ${dialogIdObj.valueOf()}:`, err);
        }
      }

      return allQuestions;
    } catch (error) {
      log.error('Failed to load all Q4H state:', error);
      return [];
    }
  }

  public static async clearQuestions4HumanState(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    try {
      const { previousQuestions } = await this.mutateQuestions4HumanState(
        dialogId,
        () => ({ kind: 'clear' }),
        status,
      );
      const existingQuestions = previousQuestions;

      // Emit q4h_answered events for each removed question
      for (const q of existingQuestions) {
        const answeredEvent: Q4HAnsweredEvent = {
          type: 'q4h_answered',
          questionId: q.id,
          selfId: dialogId.selfId,
        };
        postDialogEventById(dialogId, answeredEvent);
      }
    } catch (error) {
      log.error(`Failed to clear q4h.yaml for dialog ${dialogId}:`, error);
    }
  }

  // === PHASE 6: SUBDIALOG SUPPLY PERSISTENCE ===

  /**
   * Save pending subdialogs for Type A supply mechanism.
   * Tracks subdialogs that were created but not yet completed.
   */
  static async savePendingSubdialogs(
    rootDialogId: DialogID,
    pendingSubdialogs: PendingSubdialogStateRecord[],
    rootAnchor?: RootGenerationAnchor,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    const next = pendingSubdialogs.map((r) => ({ ...r }));
    await this.mutatePendingSubdialogs(
      rootDialogId,
      () => ({ kind: 'replace', records: next }),
      rootAnchor,
      status,
    );
  }

  /**
   * Load pending subdialogs for Type A supply mechanism.
   */
  static async loadPendingSubdialogs(
    rootDialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<PendingSubdialogStateRecord[]> {
    const key = this.getPendingSubdialogsWriteBackKey(rootDialogId, status);
    const staged = this.pendingSubdialogsWriteBack.get(key);
    if (staged) {
      return staged.state.kind === 'deleted' ? [] : staged.state.records;
    }

    try {
      return await this.loadPendingSubdialogsFromDisk(rootDialogId, status);
    } catch (error: unknown) {
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        rootDialogId,
        status,
        'loadPendingSubdialogs',
        error,
      );
      throw new Error('unreachable after loadPendingSubdialogs persistence rethrow');
    }
  }

  private static isPendingSubdialogRecord(value: unknown): value is PendingSubdialogStateRecord {
    if (!isRecord(value)) return false;
    if (typeof value.subdialogId !== 'string') return false;
    if (typeof value.createdAt !== 'string') return false;
    if (
      value.callName !== 'tellask' &&
      value.callName !== 'tellaskSessionless' &&
      value.callName !== 'freshBootsReasoning'
    ) {
      return false;
    }
    switch (value.callName) {
      case 'tellask':
      case 'tellaskSessionless':
        if (!Array.isArray(value.mentionList)) return false;
        if (!value.mentionList.every((item) => typeof item === 'string')) return false;
        if (value.mentionList.length < 1) return false;
        break;
      case 'freshBootsReasoning':
        if (value.mentionList !== undefined) return false;
        break;
    }
    if (typeof value.tellaskContent !== 'string') return false;
    if (typeof value.targetAgentId !== 'string') return false;
    if (typeof value.callId !== 'string') return false;
    if ('callingCourse' in value) {
      const callingCourse = value.callingCourse;
      if (callingCourse !== undefined) {
        if (typeof callingCourse !== 'number') return false;
        if (!Number.isFinite(callingCourse)) return false;
        if (Math.floor(callingCourse) <= 0) return false;
      }
    }
    if (value.callType !== 'A' && value.callType !== 'B' && value.callType !== 'C') return false;
    if ('sessionSlug' in value) {
      const sessionSlug = value.sessionSlug;
      if (sessionSlug !== undefined && typeof sessionSlug !== 'string') return false;
    }
    return true;
  }

  private static async loadPendingSubdialogsFromDisk(
    rootDialogId: DialogID,
    status: DialogStatusKind,
  ): Promise<PendingSubdialogStateRecord[]> {
    const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
    const filePath = path.join(dialogPath, 'pending-subdialogs.json');
    try {
      const content = await readPersistenceTextFile({
        filePath,
        source: 'pending_subdialogs',
        format: 'json',
      });
      const parsed: unknown = parsePersistenceJson({
        content,
        filePath,
        source: 'pending_subdialogs',
      });
      if (!Array.isArray(parsed) || !parsed.every((item) => this.isPendingSubdialogRecord(item))) {
        throw buildInvalidPersistenceFileError({
          source: 'pending_subdialogs',
          format: 'json',
          filePath,
        });
      }
      return parsed;
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  static async mutatePendingSubdialogs(
    rootDialogId: DialogID,
    mutator: (previous: PendingSubdialogStateRecord[]) => PendingSubdialogsMutation,
    rootAnchor?: RootGenerationAnchor,
    status: DialogStatusKind = 'running',
  ): Promise<PendingSubdialogsMutateOutcome> {
    const key = this.getPendingSubdialogsWriteBackKey(rootDialogId, status);
    const mutex = this.getPendingSubdialogsWriteBackMutex(key);

    const release = await mutex.acquire();
    try {
      const staged = this.pendingSubdialogsWriteBack.get(key);
      const previousRecords =
        staged && staged.state.kind === 'file'
          ? staged.state.records
          : staged && staged.state.kind === 'deleted'
            ? []
            : await this.loadPendingSubdialogsFromDisk(rootDialogId, status);

      const mutation = mutator(previousRecords);
      let nextRecords: PendingSubdialogStateRecord[] = previousRecords;
      const removedRecords: PendingSubdialogStateRecord[] = [];

      if (mutation.kind === 'noop') {
        return { previousRecords, records: previousRecords, removedRecords: [] };
      } else if (mutation.kind === 'append') {
        nextRecords = [...previousRecords, mutation.record];
      } else if (mutation.kind === 'removeBySubdialogId') {
        for (const r of previousRecords) {
          if (r.subdialogId === mutation.subdialogId) removedRecords.push(r);
        }
        nextRecords = previousRecords.filter((r) => r.subdialogId !== mutation.subdialogId);
      } else if (mutation.kind === 'removeBySubdialogIds') {
        const remove = new Set(mutation.subdialogIds);
        for (const r of previousRecords) {
          if (remove.has(r.subdialogId)) removedRecords.push(r);
        }
        nextRecords = previousRecords.filter((r) => !remove.has(r.subdialogId));
      } else if (mutation.kind === 'replace') {
        nextRecords = [...mutation.records];
      } else if (mutation.kind === 'clear') {
        nextRecords = [];
        removedRecords.push(...previousRecords);
      } else {
        const _exhaustive: never = mutation;
        throw new Error(`Unhandled pending-subdialogs mutation: ${String(_exhaustive)}`);
      }

      const nextState: PendingSubdialogsWriteBackState =
        nextRecords.length === 0 ? { kind: 'deleted' } : { kind: 'file', records: nextRecords };

      const pending = this.pendingSubdialogsWriteBack.get(key);
      if (!pending) {
        const timer = setTimeout(() => {
          void this.flushPendingSubdialogsWriteBack(key);
        }, this.PENDING_SUBDIALOGS_WRITEBACK_WINDOW_MS);

        this.pendingSubdialogsWriteBack.set(key, {
          kind: 'scheduled',
          dialogId: rootDialogId,
          status,
          state: nextState,
          timer,
        });
      } else {
        pending.state = nextState;
        if (pending.kind === 'flushing') pending.dirty = true;
      }

      if (rootAnchor) {
        await this.appendPendingSubdialogsReconciledRecord(
          rootDialogId,
          nextRecords,
          rootAnchorWriteTarget(rootAnchor),
          status,
        );
      }

      return { previousRecords, records: nextRecords, removedRecords };
    } finally {
      release();
    }
  }

  static async appendPendingSubdialog(
    rootDialogId: DialogID,
    record: PendingSubdialogStateRecord,
    rootAnchor?: RootGenerationAnchor,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    await this.mutatePendingSubdialogs(
      rootDialogId,
      () => ({ kind: 'append', record }),
      rootAnchor,
      status,
    );
  }

  static async removePendingSubdialog(
    rootDialogId: DialogID,
    subdialogId: string,
    rootAnchor?: RootGenerationAnchor,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    await this.mutatePendingSubdialogs(
      rootDialogId,
      () => ({ kind: 'removeBySubdialogId', subdialogId }),
      rootAnchor,
      status,
    );
  }

  static async clearPendingSubdialogs(
    rootDialogId: DialogID,
    rootAnchor?: RootGenerationAnchor,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    await this.mutatePendingSubdialogs(rootDialogId, () => ({ kind: 'clear' }), rootAnchor, status);
  }

  private static async flushPendingSubdialogsWriteBack(key: string): Promise<void> {
    const mutex = this.getPendingSubdialogsWriteBackMutex(key);

    let captured:
      | {
          dialogId: DialogID;
          status: DialogStatusKind;
          stateToWrite: PendingSubdialogsWriteBackState;
          inFlight: Promise<void>;
        }
      | undefined;

    {
      const release = await mutex.acquire();
      try {
        const entry = this.pendingSubdialogsWriteBack.get(key);
        if (!entry) return;
        if (entry.kind === 'flushing') return;
        if (entry.kind !== 'scheduled') return;
        clearTimeout(entry.timer);

        const cancellationToken = this.createRootDialogWriteBackCancellationToken(
          entry.dialogId,
          entry.status,
        );
        const inFlight = this.writePendingSubdialogsToDisk(
          entry.dialogId,
          entry.state,
          entry.status,
          cancellationToken,
        );
        captured = {
          dialogId: entry.dialogId,
          status: entry.status,
          stateToWrite: entry.state,
          inFlight,
        };
        this.pendingSubdialogsWriteBack.set(key, {
          kind: 'flushing',
          dialogId: entry.dialogId,
          status: entry.status,
          state: entry.state,
          dirty: false,
          inFlight,
        });
      } finally {
        release();
      }
    }

    if (!captured) return;

    try {
      await captured.inFlight;
    } catch (error) {
      const release = await mutex.acquire();
      try {
        const entry = this.pendingSubdialogsWriteBack.get(key);
        if (!entry) return;
        if (entry.kind !== 'flushing') return;
        if (entry.inFlight !== captured.inFlight) return;
        if (isDialogWriteBackCanceledError(error)) {
          this.pendingSubdialogsWriteBack.delete(key);
          return;
        }

        const timer = setTimeout(() => {
          void this.flushPendingSubdialogsWriteBack(key);
        }, this.PENDING_SUBDIALOGS_WRITEBACK_WINDOW_MS);

        this.pendingSubdialogsWriteBack.set(key, {
          kind: 'scheduled',
          dialogId: entry.dialogId,
          status: entry.status,
          state: entry.state,
          timer,
        });
      } finally {
        release();
      }
      return;
    }

    const release = await mutex.acquire();
    try {
      const entry = this.pendingSubdialogsWriteBack.get(key);
      if (!entry) return;
      if (entry.kind !== 'flushing') return;
      if (entry.inFlight !== captured.inFlight) return;

      if (!entry.dirty) {
        this.pendingSubdialogsWriteBack.delete(key);
        return;
      }

      const timer = setTimeout(() => {
        void this.flushPendingSubdialogsWriteBack(key);
      }, this.PENDING_SUBDIALOGS_WRITEBACK_WINDOW_MS);
      this.pendingSubdialogsWriteBack.set(key, {
        kind: 'scheduled',
        dialogId: entry.dialogId,
        status: entry.status,
        state: entry.state,
        timer,
      });
    } finally {
      release();
    }
  }

  private static async writePendingSubdialogsToDisk(
    rootDialogId: DialogID,
    state: PendingSubdialogsWriteBackState,
    status: DialogStatusKind,
    cancellationToken?: RootDialogWriteBackCancellationToken,
  ): Promise<void> {
    if (cancellationToken) {
      this.assertRootDialogWriteBackNotCanceled(
        cancellationToken,
        'writePendingSubdialogsToDisk:start',
      );
    }
    const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
    const filePath = path.join(dialogPath, 'pending-subdialogs.json');

    if (state.kind === 'deleted') {
      await fs.promises.rm(filePath, { force: true });
      return;
    }

    const jsonContent = JSON.stringify(state.records, null, 2);
    const tempFile = path.join(
      dialogPath,
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await fs.promises.writeFile(tempFile, jsonContent, 'utf-8');
    } catch (error: unknown) {
      await this.rethrowWriteBackPathMissingAsCanceled(
        error,
        dialogPath,
        cancellationToken,
        'writePendingSubdialogsToDisk:write-temp',
      );
      throw error;
    }
    await this.renameWithRetry(tempFile, filePath, 5, cancellationToken);
  }

  /**
   * Get the path for storing subdialog responses (supports both root and subdialog parents).
   * For Type C subdialogs created inside another subdialog, responses are stored at the parent's level.
   */
  static getDialogResponsesPath(dialogId: DialogID, status: DialogStatusKind = 'running'): string {
    // Root dialogs store responses in their own directory.
    // Subdialogs store responses in the parent's location (root or subdialog).
    if (dialogId.rootId === dialogId.selfId) {
      // Root dialog: use root's directory
      return this.getRootDialogPath(dialogId, status);
    }
    // Subdialog: store in parent's subdialogs directory
    // The parent is always identified by rootId (could be root or parent subdialog)
    const parentSelfId = dialogId.rootId;
    const rootPath = this.getRootDialogPath(new DialogID(parentSelfId), status);
    return path.join(rootPath, this.SUBDIALOGS_DIR, dialogId.selfId);
  }

  /**
   * Save subdialog responses for Type A supply mechanism.
   * Tracks responses from completed subdialogs.
   */
  static async saveSubdialogResponses(
    rootDialogId: DialogID,
    responses: SubdialogResponseStateRecord[],
    rootAnchor?: RootGenerationAnchor,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
      const filePath = path.join(dialogPath, 'subdialog-responses.json');

      // Atomic write operation
      const jsonContent = JSON.stringify(responses, null, 2);
      const tempFile = path.join(
        dialogPath,
        `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      await fs.promises.writeFile(tempFile, jsonContent, 'utf-8');
      await this.renameWithRetry(tempFile, filePath);
      if (rootAnchor) {
        await this.appendSubdialogResponsesReconciledRecord(
          rootDialogId,
          responses,
          rootAnchorWriteTarget(rootAnchor),
          status,
        );
      }
    } catch (error) {
      log.error(`Failed to save subdialog responses for dialog ${rootDialogId}:`, error);
      throw error;
    }
  }

  /**
   * Load subdialog responses for Type A supply mechanism.
   */
  static async loadSubdialogResponses(
    rootDialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<SubdialogResponseStateRecord[]> {
    try {
      const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
      const filePath = path.join(dialogPath, 'subdialog-responses.json');
      const inflightPath = path.join(dialogPath, 'subdialog-responses.processing.json');

      try {
        const results: SubdialogResponseStateRecord[] = [];

        const tryReadArray = async (p: string): Promise<unknown[]> => {
          try {
            const content = await readPersistenceTextFile({
              filePath: p,
              source: 'subdialog_responses',
              format: 'json',
            });
            const parsed: unknown = parsePersistenceJson({
              content,
              filePath: p,
              source: 'subdialog_responses',
            });
            if (!Array.isArray(parsed)) {
              throw buildInvalidPersistenceFileError({
                source: 'subdialog_responses',
                format: 'json',
                filePath: p,
              });
            }
            return parsed;
          } catch (error) {
            if (getErrorCode(error) === 'ENOENT') {
              return [];
            }
            throw error;
          }
        };

        const primary = await tryReadArray(filePath);
        const inflight = await tryReadArray(inflightPath);
        for (const item of [...primary, ...inflight]) {
          if (!isSubdialogResponseRecord(item)) {
            throw buildInvalidPersistenceFileError({
              source: 'subdialog_responses',
              format: 'json',
              filePath,
            });
          }
          results.push(item);
        }

        // Deduplicate by responseId (primary wins over inflight order is irrelevant)
        const byId = new Map<string, (typeof results)[number]>();
        for (const r of results) {
          byId.set(r.responseId, r);
        }
        return Array.from(byId.values());
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return [];
        }
        throw error;
      }
    } catch (error: unknown) {
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        rootDialogId,
        status,
        'loadSubdialogResponses',
        error,
      );
      throw new Error('unreachable after loadSubdialogResponses persistence rethrow');
    }
  }

  static async loadSubdialogResponsesQueue(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<SubdialogResponseStateRecord[]> {
    try {
      const dialogPath = this.getDialogResponsesPath(dialogId, status);
      const filePath = path.join(dialogPath, 'subdialog-responses.json');
      const content = await readPersistenceTextFile({
        filePath,
        source: 'subdialog_responses',
        format: 'json',
      });
      const parsed: unknown = parsePersistenceJson({
        content,
        filePath,
        source: 'subdialog_responses',
      });
      if (!Array.isArray(parsed) || !parsed.every((item) => isSubdialogResponseRecord(item))) {
        throw buildInvalidPersistenceFileError({
          source: 'subdialog_responses',
          format: 'json',
          filePath,
        });
      }
      return parsed;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return [];
      }
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        dialogId,
        status,
        'loadSubdialogResponsesQueue',
        error,
      );
      throw new Error('unreachable after loadSubdialogResponsesQueue persistence rethrow');
    }
  }

  static async appendSubdialogResponse(
    dialogId: DialogID,
    response: SubdialogResponseStateRecord,
    rootAnchor?: RootGenerationAnchor,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    const existing = await this.loadSubdialogResponsesQueue(dialogId, status);
    existing.push(response);
    await this.saveSubdialogResponses(dialogId, existing, rootAnchor, status);
  }

  static async takeSubdialogResponses(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<
    Array<{
      responseId: string;
      subdialogId: string;
      response: string;
      completedAt: string;
      status?: 'completed' | 'failed';
      callType: 'A' | 'B' | 'C';
      callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
      mentionList?: string[];
      tellaskContent: string;
      responderId: string;
      originMemberId: string;
      callId: string;
    }>
  > {
    try {
      const dialogPath = this.getDialogResponsesPath(dialogId, status);

      const filePath = path.join(dialogPath, 'subdialog-responses.json');
      const inflightPath = path.join(dialogPath, 'subdialog-responses.processing.json');

      // If a previous processing file exists, merge it back so it will be re-processed.
      try {
        await fs.promises.access(inflightPath);
      } catch (error: unknown) {
        if (getErrorCode(error) !== 'ENOENT') {
          throw error;
        }
      }
      if (await this.pathExists(inflightPath)) {
        await this.rollbackTakenSubdialogResponses(dialogId, status);
      }

      try {
        await fs.promises.rename(filePath, inflightPath);
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return [];
        }
        throw error;
      }

      const raw = await readPersistenceTextFile({
        filePath: inflightPath,
        source: 'subdialog_responses',
        format: 'json',
      });
      const parsed: unknown = parsePersistenceJson({
        content: raw,
        filePath: inflightPath,
        source: 'subdialog_responses',
      });
      if (!Array.isArray(parsed) || !parsed.every((item) => isSubdialogResponseRecord(item))) {
        throw buildInvalidPersistenceFileError({
          source: 'subdialog_responses',
          format: 'json',
          filePath: inflightPath,
        });
      }
      return parsed;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return [];
      }
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        dialogId,
        status,
        'takeSubdialogResponses',
        error,
      );
      throw new Error('unreachable after takeSubdialogResponses persistence rethrow');
    }
  }

  static async commitTakenSubdialogResponses(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    const dialogPath = this.getDialogResponsesPath(dialogId, status);
    const inflightPath = path.join(dialogPath, 'subdialog-responses.processing.json');
    await fs.promises.rm(inflightPath, { force: true });
  }

  static async rollbackTakenSubdialogResponses(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogResponsesPath(dialogId, status);

      const filePath = path.join(dialogPath, 'subdialog-responses.json');
      const inflightPath = path.join(dialogPath, 'subdialog-responses.processing.json');

      let inflight: SubdialogResponseStateRecord[] = [];
      try {
        const raw = await readPersistenceTextFile({
          filePath: inflightPath,
          source: 'subdialog_responses',
          format: 'json',
        });
        const parsed: unknown = parsePersistenceJson({
          content: raw,
          filePath: inflightPath,
          source: 'subdialog_responses',
        });
        if (!Array.isArray(parsed) || !parsed.every((item) => isSubdialogResponseRecord(item))) {
          throw buildInvalidPersistenceFileError({
            source: 'subdialog_responses',
            format: 'json',
            filePath: inflightPath,
          });
        }
        inflight = parsed;
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return;
        }
        throw error;
      }

      let primary: SubdialogResponseStateRecord[] = [];
      try {
        const raw = await readPersistenceTextFile({
          filePath,
          source: 'subdialog_responses',
          format: 'json',
        });
        const parsed: unknown = parsePersistenceJson({
          content: raw,
          filePath,
          source: 'subdialog_responses',
        });
        if (!Array.isArray(parsed) || !parsed.every((item) => isSubdialogResponseRecord(item))) {
          throw buildInvalidPersistenceFileError({
            source: 'subdialog_responses',
            format: 'json',
            filePath,
          });
        }
        primary = parsed;
      } catch (error) {
        if (getErrorCode(error) !== 'ENOENT') {
          throw error;
        }
      }

      const merged = [...inflight, ...primary];
      const byId = new Map<string, (typeof merged)[number]>();
      for (const r of merged) {
        byId.set(r.responseId, r);
      }
      const result = Array.from(byId.values());

      const jsonContent = JSON.stringify(result, null, 2);
      const tempFile = path.join(
        dialogPath,
        `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      await fs.promises.writeFile(tempFile, jsonContent, 'utf-8');
      await this.renameWithRetry(tempFile, filePath);
      await fs.promises.rm(inflightPath, { force: true });
    } catch (error: unknown) {
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        dialogId,
        status,
        'rollbackTakenSubdialogResponses',
        error,
      );
      throw new Error('unreachable after rollbackTakenSubdialogResponses persistence rethrow');
    }
  }

  /**
   * Save root dialog metadata (write-once pattern)
   */
  static async saveRootDialogMetadata(
    dialogId: DialogID,
    metadata: RootDialogMetadataFile,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getRootDialogPath(dialogId, status);

      // Ensure dialog directory exists first
      await fs.promises.mkdir(dialogPath, { recursive: true });

      // Atomic write operation
      const metadataFilePath = path.join(dialogPath, 'dialog.yaml');
      const yamlContent = yaml.stringify(metadata);
      const tempFile = path.join(
        dialogPath,
        `.${path.basename(metadataFilePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      await fs.promises.writeFile(tempFile, yamlContent, 'utf-8');
      await this.renameWithRetry(tempFile, metadataFilePath);
    } catch (error) {
      log.error(`Failed to save dialog YAML for dialog ${dialogId}:`, error);
      throw error;
    }
  }

  /**
   * Save dialog metadata (universal - works with any DialogID)
   */
  static async saveDialogMetadata(
    dialogId: DialogID,
    metadata: DialogMetadataFile,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    if (dialogId.rootId === dialogId.selfId) {
      if (!isRootDialogMetadataFile(metadata)) {
        throw new Error(`Expected root dialog metadata for ${dialogId.selfId}`);
      }
      return this.saveRootDialogMetadata(dialogId, metadata, status);
    }

    // For subdialogs, delegate to saveSubdialogMetadata
    if (!isSubdialogMetadataFile(metadata)) {
      throw new Error(`Expected subdialog metadata for ${dialogId.selfId}`);
    }
    return this.saveSubdialogMetadata(dialogId, metadata, status);
  }

  /**
   * Save dialog metadata (legacy - use saveRootDialogMetadata instead)
   * @deprecated
   */
  static async _saveDialogMetadata(
    dialogId: DialogID,
    metadata: RootDialogMetadataFile,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    return this.saveRootDialogMetadata(dialogId, metadata, status);
  }

  /**
   * Save subdialog metadata under the supdialog's .subdialogs directory
   */
  static async saveSubdialogMetadata(
    dialogId: DialogID,
    metadata: SubdialogMetadataFile,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    try {
      const subPath = this.getSubdialogPath(dialogId, status);
      const metadataFilePath = path.join(subPath, 'dialog.yaml');

      // Creation sites must ensure the directory exists first. Update paths intentionally do not
      // recreate missing directories so quarantine can use "directory disappeared" as cancellation.
      const yamlContent = yaml.stringify(metadata);
      const tempFile = path.join(
        subPath,
        `.${path.basename(metadataFilePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      await fs.promises.writeFile(tempFile, yamlContent, 'utf-8');
      await this.renameWithRetry(tempFile, metadataFilePath);
    } catch (error) {
      log.error(
        `Failed to save subdialog YAML for ${dialogId.selfId} under root dialog ${dialogId.rootId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Update assignmentFromSup for an existing subdialog.
   */
  static async updateSubdialogAssignment(
    dialogId: DialogID,
    assignment: SubdialogMetadataFile['assignmentFromSup'],
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    if (dialogId.rootId === dialogId.selfId) {
      throw new Error('updateSubdialogAssignment expects a subdialog id');
    }
    const metadata = await this.loadDialogMetadata(dialogId, status);
    if (!metadata || !isSubdialogMetadataFile(metadata)) {
      throw new Error(`Missing dialog metadata for subdialog ${dialogId.selfId}`);
    }
    const next: SubdialogMetadataFile = {
      ...metadata,
      assignmentFromSup: assignment,
    };
    await this.saveSubdialogMetadata(dialogId, next, status);
  }

  /**
   * Load root dialog metadata
   */
  static async loadRootDialogMetadata(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<DialogMetadataFile | null> {
    try {
      const dialogPath = this.getRootDialogPath(dialogId, status);
      const metadataFilePath = path.join(dialogPath, 'dialog.yaml');

      try {
        const content = await readPersistenceTextFile({
          filePath: metadataFilePath,
          source: 'dialog_metadata',
          format: 'yaml',
        });
        const parsed = parsePersistenceYaml({
          content,
          filePath: metadataFilePath,
          source: 'dialog_metadata',
        });

        if (!isDialogMetadataFile(parsed)) {
          throw buildInvalidPersistenceFileError({
            source: 'dialog_metadata',
            format: 'yaml',
            filePath: metadataFilePath,
          });
        }

        // Validate that the ID in the file matches the expected dialogId
        if (parsed.id !== dialogId.selfId) {
          throw buildInvalidPersistenceFileError({
            source: 'dialog_metadata',
            format: 'yaml',
            filePath: metadataFilePath,
          });
        }

        return parsed;
      } catch (error: unknown) {
        if (getErrorCode(error) === 'ENOENT') {
          return null;
        }
        await this.rethrowAfterQuarantiningDialogPersistenceProblem(
          dialogId,
          status,
          'loadRootDialogMetadata',
          error,
        );
        throw new Error('unreachable after loadRootDialogMetadata persistence rethrow');
      }
    } catch (error: unknown) {
      log.error(`Failed to load dialog YAML for dialog ${dialogId.selfId}:`, error);
      throw error;
    }
  }

  /**
   * Load dialog metadata (universal - works with any DialogID)
   */
  static async loadDialogMetadata(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<DialogMetadataFile | null> {
    // For root dialogs, use the selfId
    // For subdialogs, this is more complex - we need to find the root metadata
    if (dialogId.rootId === dialogId.selfId) {
      return this.loadRootDialogMetadata(dialogId, status);
    }

    // For subdialogs, we need to load from the subdialog location
    const subdialogPath = this.getSubdialogPath(dialogId, status);
    const metadataFilePath = path.join(subdialogPath, 'dialog.yaml');

    try {
      const content = await readPersistenceTextFile({
        filePath: metadataFilePath,
        source: 'dialog_metadata',
        format: 'yaml',
      });
      const parsed: unknown = parsePersistenceYaml({
        content,
        filePath: metadataFilePath,
        source: 'dialog_metadata',
      });
      if (!isDialogMetadataFile(parsed)) {
        throw buildInvalidPersistenceFileError({
          source: 'dialog_metadata',
          format: 'yaml',
          filePath: metadataFilePath,
        });
      }
      return parsed;
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') {
        return null;
      }
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        dialogId,
        status,
        'loadDialogMetadata',
        error,
      );
      throw new Error('unreachable after loadDialogMetadata persistence rethrow');
    }
  }

  /**
   * Save latest.yaml with current course and lastModified info
   */
  private static async writeDialogLatestToDisk(
    dialogId: DialogID,
    latest: DialogLatestFile,
    status: DialogStatusKind = 'running',
    cancellationToken?: RootDialogWriteBackCancellationToken,
  ): Promise<void> {
    try {
      if (cancellationToken) {
        this.assertRootDialogWriteBackNotCanceled(
          cancellationToken,
          'writeDialogLatestToDisk:start',
        );
      }
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const latestFilePath = path.join(dialogPath, 'latest.yaml');

      // NOTE: Use a unique temp file name to avoid collisions when multiple updates
      // happen concurrently for the same dialog (e.g., parallel tool responses).
      const tempFile = path.join(
        dialogPath,
        `.${path.basename(latestFilePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      const yamlContent = yaml.stringify(latest);
      try {
        await fs.promises.writeFile(tempFile, yamlContent, 'utf-8');
      } catch (error: unknown) {
        await this.rethrowWriteBackPathMissingAsCanceled(
          error,
          dialogPath,
          cancellationToken,
          'writeDialogLatestToDisk:write-temp',
        );
        throw error;
      }

      // Rename with retry logic for filesystem sync issues
      await this.renameWithRetry(tempFile, latestFilePath, 5, cancellationToken);

      // todo: publish CourseEvent here or where more suitable?
    } catch (error) {
      if (isDialogWriteBackCanceledError(error)) {
        throw error;
      }
      log.error(`Failed to save latest.yaml for dialog ${dialogId.selfId}:`, error);
      throw error;
    }
  }

  /**
   * Rename with retry logic to handle filesystem sync issues
   */
  private static async renameWithRetry(
    source: string,
    destination: string,
    maxRetries: number = 5,
    cancellationToken?: RootDialogWriteBackCancellationToken,
  ): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (cancellationToken) {
          this.assertRootDialogWriteBackNotCanceled(
            cancellationToken,
            `renameWithRetry:${path.basename(destination)}:before-rename`,
          );
        }
        await fs.promises.rename(source, destination);
        return;
      } catch (error: unknown) {
        if (isDialogWriteBackCanceledError(error)) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        if (getErrorCode(error) !== 'ENOENT' || attempt === maxRetries) {
          throw error;
        }
        // Exponential backoff for ENOENT (race condition or sync issue)
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
      }
    }
    throw lastError;
  }

  /**
   * Load latest.yaml for current course and lastModified info
   */
  static async loadDialogLatest(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<DialogLatestFile | null> {
    try {
      const key = this.getLatestWriteBackKey(dialogId, status);
      const staged = this.latestWriteBack.get(key);
      if (staged) {
        return staged.latest;
      }
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const latestFilePath = path.join(dialogPath, 'latest.yaml');

      const content = await readPersistenceTextFile({
        filePath: latestFilePath,
        source: 'dialog_latest',
        format: 'yaml',
      });
      return this.parseDialogLatestYaml(content, latestFilePath);
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') {
        return null;
      }
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        dialogId,
        status,
        'loadDialogLatest',
        error,
      );
      throw new Error('unreachable after loadDialogLatest persistence rethrow');
    }
  }

  /**
   * Delta-only latest.yaml update API.
   *
   * Callers provide a mutation callback which is applied against the most recent
   * staged state (or disk fallback). This avoids read-modify-write races in user code
   * and allows lock-free-ish coalescing to disk via the write-back buffer.
   */
  static async mutateDialogLatest(
    dialogId: DialogID,
    mutator: (previous: DialogLatestFile) => DialogLatestMutation,
    status: DialogStatusKind = 'running',
    cancellationToken?: RootDialogWriteBackCancellationToken,
  ): Promise<DialogLatestFile> {
    const key = this.getLatestWriteBackKey(dialogId, status);
    const mutex = this.getLatestWriteBackMutex(key);
    const effectiveCancellationToken =
      cancellationToken ?? this.createRootDialogWriteBackCancellationToken(dialogId, status);

    const release = await mutex.acquire();
    try {
      this.assertRootDialogWriteBackNotCanceled(effectiveCancellationToken, 'mutateDialogLatest');
      const staged = this.latestWriteBack.get(key);
      const existing = (staged
        ? staged.latest
        : await this.loadDialogLatestFromDisk(dialogId, status)) || {
        currentCourse: 1,
        lastModified: formatUnifiedTimestamp(new Date()),
        status: 'active',
      };

      const mutation = mutator(existing);

      let updated: DialogLatestFile;
      if (mutation.kind === 'noop') {
        return existing;
      } else if (mutation.kind === 'replace') {
        updated = {
          ...mutation.next,
          lastModified: formatUnifiedTimestamp(new Date()),
        };
      } else if (mutation.kind === 'patch') {
        updated = {
          ...existing,
          ...mutation.patch,
          lastModified: mutation.patch.lastModified || formatUnifiedTimestamp(new Date()),
        };
      } else {
        const _exhaustive: never = mutation;
        throw new Error(`Unhandled dialog latest mutation: ${String(_exhaustive)}`);
      }

      this.assertRootDialogWriteBackNotCanceled(
        effectiveCancellationToken,
        'mutateDialogLatest:before-stage',
      );
      const pending = this.latestWriteBack.get(key);
      if (!pending) {
        const timer = setTimeout(() => {
          void this.flushLatestWriteBack(key);
        }, this.LATEST_WRITEBACK_WINDOW_MS);

        this.latestWriteBack.set(key, {
          kind: 'scheduled',
          dialogId,
          status,
          latest: updated,
          timer,
        });

        return updated;
      }

      pending.latest = updated;
      if (pending.kind === 'flushing') {
        pending.dirty = true;
      }

      // Keep the existing timer to ensure a bounded flush window.
      return updated;
    } finally {
      release();
    }
  }

  private static async loadDialogLatestFromDisk(
    dialogId: DialogID,
    status: DialogStatusKind,
  ): Promise<DialogLatestFile | null> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const latestFilePath = path.join(dialogPath, 'latest.yaml');

      const content = await readPersistenceTextFile({
        filePath: latestFilePath,
        source: 'dialog_latest',
        format: 'yaml',
      });
      return this.parseDialogLatestYaml(content, latestFilePath);
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') {
        return null;
      }
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        dialogId,
        status,
        'loadDialogLatestFromDisk',
        error,
      );
      throw new Error('unreachable after loadDialogLatestFromDisk persistence rethrow');
    }
  }

  private static async flushLatestWriteBack(key: string): Promise<void> {
    const mutex = this.getLatestWriteBackMutex(key);

    let captured:
      | {
          dialogId: DialogID;
          status: DialogStatusKind;
          latestToWrite: DialogLatestFile;
          inFlight: Promise<void>;
        }
      | undefined;

    {
      const release = await mutex.acquire();
      try {
        const entry = this.latestWriteBack.get(key);
        if (!entry) return;
        if (entry.kind === 'flushing') return;
        if (entry.kind !== 'scheduled') return;

        clearTimeout(entry.timer);

        const latestToWrite = entry.latest;
        const cancellationToken = this.createRootDialogWriteBackCancellationToken(
          entry.dialogId,
          entry.status,
        );
        const inFlight = this.writeDialogLatestToDisk(
          entry.dialogId,
          latestToWrite,
          entry.status,
          cancellationToken,
        );

        captured = {
          dialogId: entry.dialogId,
          status: entry.status,
          latestToWrite,
          inFlight,
        };

        this.latestWriteBack.set(key, {
          kind: 'flushing',
          dialogId: entry.dialogId,
          status: entry.status,
          latest: entry.latest,
          dirty: false,
          inFlight,
        });
      } finally {
        release();
      }
    }

    if (!captured) return;

    try {
      await captured.inFlight;
    } catch (error) {
      const release = await mutex.acquire();
      try {
        const entry = this.latestWriteBack.get(key);
        if (!entry) return;
        if (entry.kind !== 'flushing') return;
        if (entry.inFlight !== captured.inFlight) return;
        if (isDialogWriteBackCanceledError(error)) {
          this.latestWriteBack.delete(key);
          return;
        }

        const timer = setTimeout(() => {
          void this.flushLatestWriteBack(key);
        }, this.LATEST_WRITEBACK_WINDOW_MS);

        this.latestWriteBack.set(key, {
          kind: 'scheduled',
          dialogId: entry.dialogId,
          status: entry.status,
          latest: entry.latest,
          timer,
        });
      } finally {
        release();
      }
      return;
    }

    const release = await mutex.acquire();
    try {
      const entry = this.latestWriteBack.get(key);
      if (!entry) return;
      if (entry.kind !== 'flushing') return;
      if (entry.inFlight !== captured.inFlight) return;

      if (!entry.dirty) {
        this.latestWriteBack.delete(key);
        return;
      }

      const timer = setTimeout(() => {
        void this.flushLatestWriteBack(key);
      }, this.LATEST_WRITEBACK_WINDOW_MS);

      this.latestWriteBack.set(key, {
        kind: 'scheduled',
        dialogId: entry.dialogId,
        status: entry.status,
        latest: entry.latest,
        timer,
      });
    } finally {
      release();
    }
  }

  static async setNeedsDrive(
    dialogId: DialogID,
    needsDrive: boolean,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    await this.mutateDialogLatest(
      dialogId,
      () => ({ kind: 'patch', patch: { needsDrive } }),
      status,
    );
  }

  static async getNeedsDrive(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<boolean> {
    const latest = await this.loadDialogLatest(dialogId, status);
    return latest?.needsDrive === true;
  }

  static async setDeferredReplyReassertion(
    dialogId: DialogID,
    deferredReplyReassertion: DialogLatestFile['deferredReplyReassertion'],
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    await this.mutateDialogLatest(
      dialogId,
      () => ({ kind: 'patch', patch: { deferredReplyReassertion } }),
      status,
    );
  }

  static async getDeferredReplyReassertion(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<DialogLatestFile['deferredReplyReassertion']> {
    const latest = await this.loadDialogLatest(dialogId, status);
    return latest?.deferredReplyReassertion;
  }

  // === FILE SYSTEM UTILITIES ===

  /**
   * Get course filename from course number
   */
  static getCourseFilename(course: number): string {
    return `course-${course.toString().padStart(3, '0')}.jsonl`;
  }

  /**
   * Extract course number from filename
   */
  static getCourseFromFilename(filename: string): number {
    const match = filename.match(/^course-(\d+)\.jsonl$/);
    if (!match) {
      throw new Error(`Invalid course filename: ${filename}`);
    }
    return parseInt(match[1], 10);
  }

  /**
   * Get dialog status from file system path
   */
  static getStatusFromPath(dialogPath: string): DialogStatusKind {
    const parentDir = path.basename(path.dirname(dialogPath));
    if (parentDir === this.RUN_DIR) return 'running';
    if (parentDir === this.DONE_DIR) return 'completed';
    if (parentDir === this.ARCHIVE_DIR) return 'archived';
    throw new Error(`Unknown dialog status from path: ${parentDir}`);
  }

  static async loadQuestions4Human(
    dialogId: DialogID,
    course: number,
    status: DialogStatusKind = 'running',
  ): Promise<Questions4Human | null> {
    const questions = await this.loadQuestions4HumanState(dialogId, status);
    return {
      course,
      questions,
      createdAt: formatUnifiedTimestamp(new Date()),
      updatedAt: formatUnifiedTimestamp(new Date()),
    };
  }

  /**
   * Count subdialogs under a root dialog (no single-layer listing exposed)
   */
  static async countAllSubdialogsUnderRoot(
    rootDialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<number> {
    try {
      const subdialogIds = await this.listSubdialogIdsUnderRoot(rootDialogId, status);
      return subdialogIds.length;
    } catch (error) {
      log.error(`Failed to count all subdialogs under root ${rootDialogId.selfId}:`, error);
      return 0;
    }
  }

  // === HIERARCHICAL DIALOG RESTORATION ===

  /**
   * Restore complete dialog tree from disk
   */
  static async restoreDialogTree(
    rootDialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<DialogPersistenceState | null> {
    try {
      // First restore the root dialog
      const rootState = await this.restoreDialog(rootDialogId, status);
      if (!rootState) {
        return null;
      }

      // Recursively restore subdialogs
      const subdialogIds = await this.listSubdialogIdsUnderRoot(rootDialogId, status);
      for (const subdialogId of subdialogIds) {
        await this.restoreDialogTree(new DialogID(subdialogId, rootDialogId.rootId), status);
      }

      return rootState;
    } catch (error) {
      log.error(`Failed to restore dialog tree for ${rootDialogId.valueOf()}:`, error);
      return null;
    }
  }

  /**
   * Restore dialog from disk using JSONL events (optimized: only latest course loaded).
   * Historical-course ask/tellask context that still matters to the current round must already be
   * represented via latest-course carryover records; older courses themselves are not reloaded into
   * LLM context during restore. For historical courses, use loadCourseEvents() on-demand for UI
   * navigation.
   */
  static async restoreDialog(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<DialogPersistenceState | null> {
    try {
      const metadata = await this.loadDialogMetadata(dialogId, status);
      if (!metadata) {
        log.debug(`No metadata found for dialog ${dialogId}`);
        return null;
      }

      const reminders = await this.loadReminderState(dialogId, status);
      // Only load latest course for dialog state restoration. Cross-course business context should
      // already have been materialized into latest-course carryover records when needed.
      const currentCourse = await this.getCurrentCourseNumber(dialogId, status);
      const latestEvents = await this.readCourseEvents(dialogId, currentCourse, status);
      const reconstructedState = await this.rebuildFromEvents(
        latestEvents,
        metadata,
        reminders,
        currentCourse,
      );

      return reconstructedState;
    } catch (error) {
      log.error(`Failed to restore dialog ${dialogId}:`, error);
      return null;
    }
  }

  /**
   * Load specific course events for UI navigation (on-demand)
   */
  static async loadCourseEvents(
    dialogId: DialogID,
    course: number,
    status: DialogStatusKind = 'running',
  ): Promise<PersistedDialogRecord[]> {
    return await this.readCourseEvents(dialogId, course, status);
  }

  /**
   * Reconstruct dialog state from JSONL events (optimized: only latest course needed).
   */
  static async rebuildFromEvents(
    events: PersistedDialogRecord[],
    metadata: DialogMetadataFile,
    reminders: Reminder[],
    currentCourse: number,
  ): Promise<DialogPersistenceState> {
    // Events are already in chronological order from JSONL file (append-only pattern)
    const messages: ChatMessage[] = [];
    let contextHealth: ContextHealthSnapshot | undefined;

    // Simple, straightforward mapping to reconstruct messages from persisted events
    for (const event of events) {
      switch (event.type) {
        case 'agent_thought_record': {
          // Convert agent thought to ChatMessage
          messages.push({
            type: 'thinking_msg',
            role: 'assistant',
            genseq: event.genseq,
            content: event.content,
            reasoning: event.reasoning,
            provider_data: event.provider_data,
          });
          break;
        }

        case 'agent_words_record': {
          // Convert agent words to ChatMessage
          messages.push({
            type: 'saying_msg',
            role: 'assistant',
            genseq: event.genseq,
            content: event.content,
          });
          break;
        }

        case 'runtime_guide_record': {
          messages.push({
            type: 'transient_guide_msg',
            role: 'assistant',
            content: event.content,
          });
          break;
        }

        case 'human_text_record': {
          if (typeof event.q4hAnswerCallId === 'string' && event.q4hAnswerCallId.trim() !== '') {
            // Keep this out of transcript reconstruction: it is only the continuation glue for an
            // answered askHuman call, not a persisted business-level user prompt fact.
            break;
          }
          // Convert human text to prompting message
          messages.push({
            type: 'prompting_msg',
            role: 'user',
            genseq: event.genseq,
            msgId: event.msgId,
            content: event.content,
            grammar: event.grammar ?? 'markdown',
          });
          break;
        }

        case 'tellask_reply_resolution_record':
          break;

        case 'func_call_record': {
          // Convert function call to ChatMessage
          messages.push({
            type: 'func_call_msg',
            role: 'assistant',
            genseq: event.genseq,
            id: event.id,
            name: event.name,
            arguments: event.rawArgumentsText,
          });
          break;
        }
        case 'tellask_call_record': {
          messages.push({
            type: 'func_call_msg',
            role: 'assistant',
            genseq: event.genseq,
            id: event.id,
            name: event.name,
            arguments: formatTellaskCallArguments(event),
          });
          break;
        }
        case 'web_search_call_record':
          // UI-only timeline event for native web_search tool call visualization.
          // Must not be injected into LLM context reconstruction.
          break;
        case 'native_tool_call_record':
          // UI-only timeline event for OpenAI Responses native tool visualization.
          // Must not be injected into LLM context reconstruction.
          break;
        case 'tool_result_image_ingest_record':
          // UI-only per-generation image projection diagnostics for tool results.
          // Must not be injected into LLM context reconstruction.
          break;

        case 'func_result_record': {
          // Convert function result to ChatMessage
          messages.push({
            type: 'func_result_msg',
            role: 'tool',
            genseq: event.genseq,
            id: event.id,
            name: event.name,
            content: event.content,
            contentItems: event.contentItems,
          });
          break;
        }

        case 'tellask_result_record': {
          messages.push({
            type: 'tellask_result_msg',
            role: 'tool',
            genseq: event.genseq,
            callId: event.callId,
            callName: event.callName,
            status: event.status,
            content: event.content,
            ...(event.calling_genseq !== undefined ? { calling_genseq: event.calling_genseq } : {}),
            call: event.call,
            responder: event.responder,
            ...(event.route ? { route: event.route } : {}),
            responderId: event.responder.responderId,
            ...(event.callName === 'tellask' || event.callName === 'tellaskSessionless'
              ? { mentionList: event.call.mentionList }
              : {}),
            tellaskContent: event.call.tellaskContent,
            ...(event.callName === 'tellask' ? { sessionSlug: event.call.sessionSlug } : {}),
            ...(event.responder.agentId ? { agentId: event.responder.agentId } : {}),
            ...(event.responder.originMemberId
              ? { originMemberId: event.responder.originMemberId }
              : {}),
            ...(event.route?.calleeDialogId ? { calleeDialogId: event.route.calleeDialogId } : {}),
            ...(event.route?.calleeCourse !== undefined
              ? { calleeCourse: event.route.calleeCourse }
              : {}),
            ...(event.route?.calleeGenseq !== undefined
              ? { calleeGenseq: event.route.calleeGenseq }
              : {}),
          });
          break;
        }

        case 'tellask_carryover_record': {
          messages.push({
            type: 'tellask_carryover_msg',
            role: 'user',
            genseq: event.genseq,
            content: event.content,
            originCourse: event.originCourse,
            carryoverCourse: event.carryoverCourse,
            responderId: event.responderId,
            callName: event.callName,
            tellaskContent: event.tellaskContent,
            status: event.status,
            response: event.response,
            agentId: event.agentId,
            callId: event.callId,
            originMemberId: event.originMemberId,
            ...(event.callName === 'tellask'
              ? {
                  mentionList: event.mentionList,
                  sessionSlug: event.sessionSlug,
                }
              : event.callName === 'tellaskSessionless'
                ? {
                    mentionList: event.mentionList,
                  }
                : {}),
            ...(event.calleeDialogId ? { calleeDialogId: event.calleeDialogId } : {}),
            ...(event.calleeCourse !== undefined ? { calleeCourse: event.calleeCourse } : {}),
            ...(event.calleeGenseq !== undefined ? { calleeGenseq: event.calleeGenseq } : {}),
          });
          break;
        }

        // gen_start_record and gen_finish_record are control events, not message content
        // They don't need to be converted to ChatMessage objects
        case 'gen_start_record':
          break;
        case 'gen_finish_record':
          if (event.contextHealth) {
            contextHealth = event.contextHealth;
          }
          break;
        case 'quest_for_sup_record':
          // These events are handled separately in dialog restoration
          // Skip them for message reconstruction
          break;
        case 'tellask_call_anchor_record':
          // This record is UI navigation metadata for deep links in callee dialogs.
          // It does not contribute to model context or chat transcript reconstruction.
          break;
        case 'ui_only_markdown_record':
          // UI-only records are replay-only rendering facts. They do not enter dialog messages or ctx.
          break;
        case 'subdialog_created_record':
        case 'reminders_reconciled_record':
        case 'questions4human_reconciled_record':
        case 'pending_subdialogs_reconciled_record':
        case 'subdialog_registry_reconciled_record':
        case 'subdialog_responses_reconciled_record':
          break;

        default:
          log.warn(`Unknown event type in rebuildFromEvents`, undefined, { event });
          break;
      }
    }

    return {
      metadata,
      currentCourse,
      messages,
      reminders,
      contextHealth,
    };
  }

  /**
   * Move dialog between status directories (run/done/archive)
   */
  static async moveDialogStatus(
    dialogId: DialogID,
    fromStatus: DialogStatusKind,
    toStatus: DialogStatusKind,
  ): Promise<void> {
    try {
      const fromPath = path.join(
        this.getDialogsRootDir(),
        getPersistableStatusDirName(fromStatus, 'DialogPersistence.moveDialogStatus(fromStatus)'),
        dialogId.selfId,
      );
      const toPath = path.join(
        this.getDialogsRootDir(),
        getPersistableStatusDirName(toStatus, 'DialogPersistence.moveDialogStatus(toStatus)'),
        dialogId.selfId,
      );

      await fs.promises.mkdir(path.dirname(toPath), { recursive: true });

      try {
        await fs.promises.access(toPath);
        throw new Error(
          `Refusing to move dialog ${dialogId.valueOf()} from ${fromStatus} to ${toStatus}: destination already exists at ${toPath}`,
        );
      } catch (error: unknown) {
        if (getErrorCode(error) !== 'ENOENT') {
          throw error;
        }
      }

      await fs.promises.rename(fromPath, toPath);
    } catch (error) {
      log.error(`Failed to move dialog ${dialogId} from ${fromStatus} to ${toStatus}:`, error);
      throw error;
    }
  }

  /**
   * Delete a root dialog directory (including subdialogs) from disk.
   * Caller must provide the source status explicitly.
   */
  static async deleteRootDialog(
    rootDialogId: DialogID,
    fromStatus: DialogStatusKind,
  ): Promise<boolean> {
    if (rootDialogId.selfId !== rootDialogId.rootId) {
      throw new Error('deleteRootDialog expects a root dialog id');
    }
    const exists = await this.loadRootDialogMetadata(rootDialogId, fromStatus);
    if (!exists) return false;

    // Best-effort cleanup: remove the dialog from all status directories to avoid leaving behind
    // orphaned placeholder paths (e.g. `run/<id>/latest.yaml`) after a delete.
    for (const candidate of PERSISTABLE_DIALOG_STATUSES) {
      this.cancelRootDialogWriteBacks(rootDialogId, candidate);
      const candidatePath = this.getRootDialogPath(rootDialogId, candidate);
      await fs.promises.rm(candidatePath, { recursive: true, force: true });
    }
    return true;
  }

  // === REGISTRY PERSISTENCE ===

  /**
   * Save subdialog registry (TYPE B entries).
   */
  static async saveSubdialogRegistry(
    rootDialogId: DialogID,
    entries: Array<{
      key: string;
      subdialogId: DialogID;
      agentId: string;
      sessionSlug?: string;
    }>,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
      const registryFilePath = path.join(dialogPath, 'registry.yaml');

      const serializableEntries = entries.map((entry) => ({
        key: entry.key,
        subdialogId: entry.subdialogId.selfId,
        agentId: entry.agentId,
        sessionSlug: entry.sessionSlug,
      }));

      const yamlContent = yaml.stringify({ entries: serializableEntries });
      const tempFile = path.join(
        dialogPath,
        `.${path.basename(registryFilePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      await fs.promises.writeFile(tempFile, yamlContent, 'utf-8');
      await this.renameWithRetry(tempFile, registryFilePath);
    } catch (error) {
      log.error(`Failed to save subdialog registry for dialog ${rootDialogId}:`, error);
      throw error;
    }
  }

  /**
   * Load subdialog registry.
   */
  static async loadSubdialogRegistry(
    rootDialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<
    Array<{
      key: string;
      subdialogId: DialogID;
      agentId: string;
      sessionSlug?: string;
    }>
  > {
    try {
      const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
      const registryFilePath = path.join(dialogPath, 'registry.yaml');

      const content = await readPersistenceTextFile({
        filePath: registryFilePath,
        source: 'subdialog_registry',
        format: 'yaml',
      });
      const parsed: unknown = parsePersistenceYaml({
        content,
        filePath: registryFilePath,
        source: 'subdialog_registry',
      });

      if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
        throw buildInvalidPersistenceFileError({
          source: 'subdialog_registry',
          format: 'yaml',
          filePath: registryFilePath,
        });
      }

      const entries = parsed.entries.map((entry: unknown) => {
        if (
          !isRecord(entry) ||
          typeof entry.key !== 'string' ||
          typeof entry.subdialogId !== 'string' ||
          typeof entry.agentId !== 'string' ||
          (entry.sessionSlug !== undefined && typeof entry.sessionSlug !== 'string')
        ) {
          throw buildInvalidPersistenceFileError({
            source: 'subdialog_registry',
            format: 'yaml',
            filePath: registryFilePath,
          });
        }
        return {
          key: entry.key,
          subdialogId: new DialogID(entry.subdialogId, rootDialogId.rootId),
          agentId: entry.agentId,
          sessionSlug: entry.sessionSlug,
        };
      });

      return entries;
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') {
        return [];
      }
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        rootDialogId,
        status,
        'loadSubdialogRegistry',
        error,
      );
      throw new Error('unreachable after loadSubdialogRegistry persistence rethrow');
    }
  }
}
