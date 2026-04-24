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
  SideDialogEvent,
  StreamErrorEvent,
  TellaskCallAnchorEvent,
  TellaskCallStartEvent,
  TellaskCarryoverEvent,
  TellaskResultEvent,
  ThinkingChunkEvent,
  ThinkingFinishEvent,
  ThinkingStartEvent,
  ToolResultImageIngestEvent,
  UiOnlyMarkdownEvent,
  UserImageIngestEvent,
  WebSearchCallAction,
  WebSearchCallEvent,
  WebSearchCallSource,
} from '@longrun-ai/kernel/types/dialog';
import type {
  DialogInterruptionReason,
  DialogLlmRetryRecoveryAction,
} from '@longrun-ai/kernel/types/display-state';
import type { DialogRuntimePrompt } from '@longrun-ai/kernel/types/drive-intent';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { isLanguageCode } from '@longrun-ai/kernel/types/language';
import type {
  AgentThoughtRecord,
  AgentWordsRecord,
  AskerDialogStackFrame,
  DialogAskerStackState,
  DialogDeferredReplyReassertion,
  DialogFbrState,
  DialogLatestFile,
  DialogMetadataFile,
  DialogPendingCourseStartPrompt,
  DialogSideDialogReplyTarget,
  FuncCallRecord,
  FuncResultRecord,
  HumanQuestion,
  HumanTextRecord,
  MainDialogMetadataFile,
  NativeToolCallRecord,
  PendingSideDialogsReconciledRecord,
  PendingSideDialogStateRecord,
  PersistedDialogRecord,
  ProviderData,
  Questions4HumanFile,
  Questions4HumanReconciledRecord,
  ReasoningPayload,
  ReconciledRecordWriteTarget,
  ReminderSnapshotItem,
  RemindersReconciledRecord,
  ReminderStateFile,
  RootGenerationAnchor,
  RuntimeGuideRecord,
  SideDialogAssignmentFromAsker,
  SideDialogCreatedRecord,
  SideDialogMetadataFile,
  SideDialogRegistryReconciledRecord,
  SideDialogRegistryStateRecord,
  SideDialogResponsesReconciledRecord,
  SideDialogResponseStateRecord,
  TellaskCallRecord,
  TellaskCallRecordName,
  TellaskCarryoverRecord,
  TellaskReplyDirective,
  TellaskReplyResolutionRecord,
  TellaskResultRecord,
  ToolResultImageIngestRecord,
  UiOnlyMarkdownRecord,
  UserImageIngestRecord,
  WebSearchCallRecord,
} from '@longrun-ai/kernel/types/storage';
import {
  toCalleeCourseNumber,
  toCalleeGenerationSeqNumber,
  toCallSiteCourseNo,
  toCallSiteGenseqNo,
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
import type { PendingSideDialog } from './dialog';
import {
  buildSideDialogAskerStack,
  Dialog,
  DialogID,
  DialogStore,
  MainDialog,
  SideDialog,
} from './dialog';
import { isInterruptionReasonManualResumeEligible } from './dialog-interruption';
import { postDialogEvent, postDialogEventById } from './evt-registry';
import { ChatMessage, FuncResultMsg, TellaskCarryoverMsg, TellaskResultMsg } from './llm/client';
import type { ToolResultImageIngest, UserImageIngest } from './llm/gen';
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
      mainDialogId: DialogID;
      status: DialogStatusKind;
      reason: string;
      error: Error;
    }) => Promise<void> | void)
  | null = null;
let finalizeDialogQuarantineHook:
  | ((args: {
      dialogId: DialogID;
      mainDialogId: DialogID;
      status: DialogStatusKind;
      reason: string;
      error: Error;
      quarantined: boolean;
    }) => Promise<void> | void)
  | null = null;

function captureInvariantWarningStack(): string[] | null {
  const stack = new Error().stack;
  if (typeof stack !== 'string' || stack.trim() === '') {
    return null;
  }
  const frames = stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => {
      return (
        line !== '' &&
        !line.includes('captureInvariantWarningStack') &&
        !line.includes('normalizeGeneratingDisplayStateMismatch') &&
        !line.includes('mutateDialogLatest')
      );
    });
  if (frames.length === 0) {
    return null;
  }
  return frames.slice(0, 8);
}

function summarizeLatestProjectionState(latest: DialogLatestFile): Record<string, unknown> {
  return {
    currentCourse: latest.currentCourse,
    lastModified: latest.lastModified,
    status: latest.status,
    messageCount: latest.messageCount ?? null,
    functionCallCount: latest.functionCallCount ?? null,
    sideDialogCount: latest.sideDialogCount ?? null,
    generating: latest.generating ?? false,
    needsDrive: latest.needsDrive ?? false,
    disableDiligencePush: latest.disableDiligencePush ?? false,
    diligencePushRemainingBudget: latest.diligencePushRemainingBudget ?? null,
    displayState: latest.displayState ?? null,
    executionMarker: latest.executionMarker ?? null,
    pendingCourseStartPromptMsgId: latest.pendingCourseStartPrompt?.msgId ?? null,
    pendingCourseStartPromptOrigin: latest.pendingCourseStartPrompt?.origin ?? null,
    pendingCourseStartPromptGrammar: latest.pendingCourseStartPrompt?.grammar ?? null,
    pendingCourseStartPromptUserLanguageCode:
      latest.pendingCourseStartPrompt?.userLanguageCode ?? null,
    pendingCourseStartPromptContentLength: latest.pendingCourseStartPrompt?.content.length ?? null,
    pendingCourseStartPromptReplyTargetCallId:
      latest.pendingCourseStartPrompt?.sideDialogReplyTarget?.callId ?? null,
    pendingCourseStartPromptReplyTargetOwnerDialogId:
      latest.pendingCourseStartPrompt?.sideDialogReplyTarget?.ownerDialogId ?? null,
    pendingCourseStartPromptExpectedReplyCallName:
      latest.pendingCourseStartPrompt?.tellaskReplyDirective?.expectedReplyCallName ?? null,
    pendingCourseStartPromptTargetCallId:
      latest.pendingCourseStartPrompt?.tellaskReplyDirective?.targetCallId ?? null,
  };
}

function summarizeLatestMutationPatch(
  patch: Partial<DialogLatestFile>,
): Record<string, unknown> | null {
  const keys = Object.keys(patch as Record<string, unknown>);
  if (keys.length === 0) {
    return null;
  }
  return {
    keys,
    currentCourse: patch.currentCourse ?? null,
    lastModified: patch.lastModified ?? null,
    status: patch.status ?? null,
    messageCount: patch.messageCount ?? null,
    functionCallCount: patch.functionCallCount ?? null,
    sideDialogCount: patch.sideDialogCount ?? null,
    generating: patch.generating ?? null,
    needsDrive: patch.needsDrive ?? null,
    disableDiligencePush: patch.disableDiligencePush ?? null,
    diligencePushRemainingBudget: patch.diligencePushRemainingBudget ?? null,
    displayState: patch.displayState ?? null,
    executionMarker: patch.executionMarker ?? null,
    pendingCourseStartPromptMsgId: patch.pendingCourseStartPrompt?.msgId ?? null,
    pendingCourseStartPromptOrigin: patch.pendingCourseStartPrompt?.origin ?? null,
    pendingCourseStartPromptGrammar: patch.pendingCourseStartPrompt?.grammar ?? null,
    pendingCourseStartPromptUserLanguageCode:
      patch.pendingCourseStartPrompt?.userLanguageCode ?? null,
    pendingCourseStartPromptContentLength: patch.pendingCourseStartPrompt?.content.length ?? null,
    pendingCourseStartPromptReplyTargetOwnerDialogId:
      patch.pendingCourseStartPrompt?.sideDialogReplyTarget?.ownerDialogId ?? null,
    pendingCourseStartPromptReplyTargetCallId:
      patch.pendingCourseStartPrompt?.sideDialogReplyTarget?.callId ?? null,
    pendingCourseStartPromptExpectedReplyCallName:
      patch.pendingCourseStartPrompt?.tellaskReplyDirective?.expectedReplyCallName ?? null,
    pendingCourseStartPromptTargetCallId:
      patch.pendingCourseStartPrompt?.tellaskReplyDirective?.targetCallId ?? null,
  };
}

function stringifyInvariantWarningDetails(details: Record<string, unknown>): string | null {
  try {
    return JSON.stringify(details);
  } catch {
    return null;
  }
}

function chunkInvariantDiagnosticJson(value: string, maxChars: number): string[] {
  if (maxChars <= 0 || value.length <= maxChars) {
    return [value];
  }
  const chunks: string[] = [];
  for (let start = 0; start < value.length; start += maxChars) {
    chunks.push(value.slice(start, start + maxChars));
  }
  return chunks;
}

function emitInvariantWarning(message: string, details: Record<string, unknown>): void {
  const diagnosticJson = stringifyInvariantWarningDetails(details);
  log.warn(message, undefined, {
    ...details,
    diagnosticJson,
  });
  if (diagnosticJson !== null) {
    const parts = chunkInvariantDiagnosticJson(diagnosticJson, 1600);
    for (const [index, part] of parts.entries()) {
      log.warn(`${message} FullDiagnosticJsonPart=${index + 1}/${parts.length} ${part}`);
    }
  }
}

function normalizeGeneratingDisplayStateMismatch(
  dialogId: DialogID,
  status: DialogStatusKind,
  previous: DialogLatestFile,
  latest: DialogLatestFile,
  context: Readonly<{
    trigger: string;
    mutationKind: DialogLatestMutation['kind'];
    patchSummary: Record<string, unknown> | null;
    latestSource: 'staged' | 'disk' | 'default_bootstrap';
    latestWriteBackKey: string;
  }>,
): DialogLatestFile {
  if (status !== 'running' || latest.generating !== true) {
    return latest;
  }
  const shouldPreserveDeadState =
    latest.displayState?.kind === 'dead' || latest.executionMarker?.kind === 'dead';
  const hasRunningDisplayState =
    latest.displayState?.kind === 'proceeding' ||
    latest.displayState?.kind === 'proceeding_stop_requested';
  const hasInterruptedExecutionMarker = latest.executionMarker?.kind === 'interrupted';
  if (hasRunningDisplayState && !hasInterruptedExecutionMarker) {
    return latest;
  }
  const healedDisplayState: DialogLatestFile['displayState'] = hasRunningDisplayState
    ? latest.displayState
    : { kind: 'proceeding' };
  const healingMessage = !hasRunningDisplayState
    ? hasInterruptedExecutionMarker
      ? 'Dialog latest projection invariant warning: generating dialog has non-running run-control projection; healing displayState to proceeding and clearing stale interruption marker'
      : 'Dialog latest projection invariant warning: generating dialog has non-running run-control projection; healing displayState to proceeding'
    : 'Dialog latest projection invariant warning: generating dialog has stale interrupted executionMarker; clearing it while preserving running displayState';
  const warningDetails: Record<string, unknown> = {
    trigger: context.trigger,
    mutationKind: context.mutationKind,
    latestSource: context.latestSource,
    latestWriteBackKey: context.latestWriteBackKey,
    patchSummary: context.patchSummary,
    dialogId: dialogId.valueOf(),
    rootId: dialogId.rootId,
    selfId: dialogId.selfId,
    status,
    before: summarizeLatestProjectionState(previous),
    afterBeforeHealing: summarizeLatestProjectionState(latest),
    healingApplied: !shouldPreserveDeadState,
    healedTo: shouldPreserveDeadState
      ? null
      : {
          displayState: healedDisplayState,
          executionMarker: hasInterruptedExecutionMarker ? null : (latest.executionMarker ?? null),
        },
    callStack: captureInvariantWarningStack(),
  };
  emitInvariantWarning(
    shouldPreserveDeadState
      ? 'Dialog latest projection invariant warning: generating dialog has non-running run-control projection; preserved stronger dead state'
      : healingMessage,
    warningDetails,
  );
  if (shouldPreserveDeadState) {
    return latest;
  }
  return {
    ...latest,
    displayState: healedDisplayState,
    executionMarker: hasInterruptedExecutionMarker ? undefined : latest.executionMarker,
  };
}
const quarantiningMainDialogs = new Set<string>();
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
        mainDialogId: DialogID;
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
        mainDialogId: DialogID;
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
    raw.startsWith('Side Dialog is still running (elapsed ')
  ) {
    return true;
  }
  if (
    (raw.startsWith('[Dominds 诉请状态]') || raw.startsWith('[Dominds tellask status]')) &&
    (raw.includes('当前仍在等待') || raw.includes('is still waiting'))
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
    case 'pending_course_start':
      return { kind: 'pending_course_start' };
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
    renderMode: reminder.renderMode ?? 'markdown',
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
    renderMode: snapshot.renderMode,
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

function buildUserImageIngestRecord(
  ingest: UserImageIngest,
  genseq: number,
): UserImageIngestRecord {
  return {
    ts: formatUnifiedTimestamp(new Date()),
    type: 'user_image_ingest_record',
    genseq,
    ...(ingest.msgId !== undefined ? { msgId: ingest.msgId } : {}),
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

function buildTellaskResultRecord(result: TellaskResultMsg): TellaskResultRecord {
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
    callId: result.callId,
    status: result.status,
    content: result.content,
    contentItems: result.contentItems,
    ...(typeof result.callSiteCourse === 'number'
      ? { callSiteCourse: toCallSiteCourseNo(result.callSiteCourse) }
      : {}),
    ...(typeof result.callSiteGenseq === 'number'
      ? { callSiteGenseq: toCallSiteGenseqNo(result.callSiteGenseq) }
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
    callSiteCourse: toCallSiteCourseNo(result.callSiteCourse),
    carryoverCourse: toDialogCourseNumber(result.carryoverCourse),
    responderId: result.responderId,
    callName: result.callName,
    tellaskContent: result.tellaskContent,
    status: result.status,
    response: result.response,
    content: result.content,
    contentItems: result.contentItems,
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
      ...(typeof result.callSiteCourse === 'number'
        ? { callSiteCourse: toCallSiteCourseNo(result.callSiteCourse) }
        : {}),
      callSiteGenseq:
        typeof result.callSiteGenseq === 'number'
          ? toCallSiteGenseqNo(result.callSiteGenseq)
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
      ...(typeof result.callSiteCourse === 'number'
        ? { callSiteCourse: toCallSiteCourseNo(result.callSiteCourse) }
        : {}),
      callSiteGenseq:
        typeof result.callSiteGenseq === 'number'
          ? toCallSiteGenseqNo(result.callSiteGenseq)
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
    ...(typeof result.callSiteCourse === 'number'
      ? { callSiteCourse: toCallSiteCourseNo(result.callSiteCourse) }
      : {}),
    callSiteGenseq:
      typeof result.callSiteGenseq === 'number'
        ? toCallSiteGenseqNo(result.callSiteGenseq)
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
      callSiteCourse: toCallSiteCourseNo(result.callSiteCourse),
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
      callSiteCourse: toCallSiteCourseNo(result.callSiteCourse),
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
    callSiteCourse: toCallSiteCourseNo(result.callSiteCourse),
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
  const mainDialog = dialog instanceof SideDialog ? dialog.mainDialog : dialog;
  return toRootGenerationAnchor({
    rootCourse: mainDialog.currentCourse,
    rootGenseq: mainDialog.activeGenSeqOrUndefined ?? 0,
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

function isMainDialogMetadataFile(value: unknown): value is MainDialogMetadataFile {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (typeof value.agentId !== 'string') return false;
  if (typeof value.taskDocPath !== 'string') return false;
  if (typeof value.createdAt !== 'string') return false;
  if (value.askerDialogId !== undefined) return false;
  if (value.sessionSlug !== undefined) return false;
  if (value.assignmentFromAsker !== undefined) return false;
  if (value.priming !== undefined) {
    if (!isRecord(value.priming)) return false;
    if (!Array.isArray(value.priming.scriptRefs)) return false;
    if (!value.priming.scriptRefs.every((item) => typeof item === 'string')) return false;
    if (typeof value.priming.showInUi !== 'boolean') return false;
  }
  return true;
}

function isSideDialogAssignmentFromAsker(value: unknown): value is SideDialogAssignmentFromAsker {
  if (!isRecord(value)) return false;
  if (typeof value.tellaskContent !== 'string') return false;
  if (typeof value.originMemberId !== 'string') return false;
  if (typeof value.askerDialogId !== 'string') return false;
  if (typeof value.callId !== 'string') return false;
  if (value.collectiveTargets !== undefined) {
    if (!Array.isArray(value.collectiveTargets)) return false;
    if (!value.collectiveTargets.every((item) => typeof item === 'string')) return false;
  }
  if (value.effectiveFbrEffort !== undefined) {
    if (
      typeof value.effectiveFbrEffort !== 'number' ||
      !Number.isInteger(value.effectiveFbrEffort)
    ) {
      return false;
    }
    if (value.effectiveFbrEffort < 1 || value.effectiveFbrEffort > 100) {
      return false;
    }
  }

  switch (value.callName) {
    case 'tellask':
    case 'tellaskSessionless': {
      if (!Array.isArray(value.mentionList)) return false;
      if (value.mentionList.length < 1) return false;
      if (!value.mentionList.every((item) => typeof item === 'string')) return false;
      if (value.effectiveFbrEffort !== undefined) return false;
      break;
    }
    case 'freshBootsReasoning': {
      if (value.mentionList !== undefined) return false;
      if (value.effectiveFbrEffort === undefined) return false;
      break;
    }
    default:
      return false;
  }
  return true;
}

function isSideDialogMetadataFile(value: unknown): value is SideDialogMetadataFile {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (typeof value.agentId !== 'string') return false;
  if (typeof value.taskDocPath !== 'string') return false;
  if (typeof value.createdAt !== 'string') return false;
  if (value.askerDialogId !== undefined) return false;
  if (value.assignmentFromAsker !== undefined) return false;
  if (value.priming !== undefined) return false;
  if (value.sessionSlug !== undefined && typeof value.sessionSlug !== 'string') return false;
  return true;
}

function parseTellaskReplyDirective(value: unknown): TellaskReplyDirective | null {
  if (!isRecord(value)) return null;
  const expectedReplyCallName = value.expectedReplyCallName;
  const targetCallId = value.targetCallId;
  const tellaskContent = value.tellaskContent;
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
  const targetDialogId = value.targetDialogId;
  if (typeof targetDialogId !== 'string') return null;
  if (expectedReplyCallName === 'replyTellaskBack') {
    return {
      expectedReplyCallName,
      targetDialogId,
      targetCallId,
      tellaskContent,
    };
  }
  return {
    expectedReplyCallName,
    targetDialogId,
    targetCallId,
    tellaskContent,
  };
}

function isAskerDialogStackFrame(value: unknown): value is AskerDialogStackFrame {
  if (!isRecord(value)) return false;
  if (value.kind !== 'asker_dialog_stack_frame') return false;
  if (typeof value.askerDialogId !== 'string') return false;
  if (
    value.assignmentFromAsker !== undefined &&
    !isSideDialogAssignmentFromAsker(value.assignmentFromAsker)
  ) {
    return false;
  }
  if (
    value.assignmentFromAsker !== undefined &&
    value.assignmentFromAsker.askerDialogId !== value.askerDialogId
  ) {
    return false;
  }
  if (value.tellaskReplyObligation !== undefined) {
    const directive = parseTellaskReplyDirective(value.tellaskReplyObligation);
    if (directive === null) return false;
    if (value.assignmentFromAsker !== undefined) {
      const expectedReplyCallName =
        value.assignmentFromAsker.callName === 'tellask'
          ? 'replyTellask'
          : 'replyTellaskSessionless';
      if (directive.expectedReplyCallName !== expectedReplyCallName) return false;
      if (directive.targetDialogId !== value.askerDialogId) return false;
      if (directive.targetCallId !== value.assignmentFromAsker.callId) return false;
      if (directive.tellaskContent !== value.assignmentFromAsker.tellaskContent) return false;
    } else if (directive.targetDialogId !== value.askerDialogId) {
      return false;
    }
  }
  return true;
}

function isDialogAskerStackState(value: unknown): value is DialogAskerStackState {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.askerStack)) return false;
  return value.askerStack.every(isAskerDialogStackFrame);
}

function getDialogAskerStackTop(state: DialogAskerStackState): AskerDialogStackFrame {
  const top = state.askerStack[state.askerStack.length - 1];
  if (!top) {
    throw new Error('asker stack invariant violation: empty stack');
  }
  return top;
}

function getDialogAskerStackCurrentAssignment(
  state: DialogAskerStackState,
): SideDialogAssignmentFromAsker {
  for (let index = state.askerStack.length - 1; index >= 0; index -= 1) {
    const frame = state.askerStack[index];
    if (frame?.assignmentFromAsker !== undefined) {
      return frame.assignmentFromAsker;
    }
  }
  throw new Error('asker stack invariant violation: missing assignment frame');
}

function buildAssignmentTellaskReplyObligation(args: {
  targetDialogId: string;
  assignment: SideDialogAssignmentFromAsker;
}): TellaskReplyDirective {
  switch (args.assignment.callName) {
    case 'tellask':
      return {
        expectedReplyCallName: 'replyTellask',
        targetDialogId: args.targetDialogId,
        targetCallId: args.assignment.callId,
        tellaskContent: args.assignment.tellaskContent,
      };
    case 'tellaskSessionless':
    case 'freshBootsReasoning':
      return {
        expectedReplyCallName: 'replyTellaskSessionless',
        targetDialogId: args.targetDialogId,
        targetCallId: args.assignment.callId,
        tellaskContent: args.assignment.tellaskContent,
      };
  }
}

function buildAssignmentAskerStackFrame(args: {
  askerDialogId: string;
  assignment: SideDialogAssignmentFromAsker;
}): AskerDialogStackFrame {
  return {
    kind: 'asker_dialog_stack_frame',
    askerDialogId: args.askerDialogId,
    assignmentFromAsker: args.assignment,
    tellaskReplyObligation: buildAssignmentTellaskReplyObligation({
      targetDialogId: args.assignment.askerDialogId,
      assignment: args.assignment,
    }),
  };
}

type DialogAskerStackJsonlRow = Readonly<{
  frame: AskerDialogStackFrame;
  startOffset: number;
  endOffset: number;
}>;

function parseDialogSideDialogReplyTarget(value: unknown): DialogSideDialogReplyTarget | null {
  if (!isRecord(value)) return null;
  const ownerDialogId = value.ownerDialogId;
  const callType = value.callType;
  const callId = value.callId;
  if (typeof ownerDialogId !== 'string' || typeof callId !== 'string') {
    return null;
  }
  if (callType !== 'A' && callType !== 'B' && callType !== 'C') {
    return null;
  }
  return {
    ownerDialogId,
    callType,
    callId,
  };
}

function parseDialogPendingCourseStartPrompt(
  value: unknown,
): DialogPendingCourseStartPrompt | null {
  if (!isRecord(value)) return null;
  if (typeof value.content !== 'string' || typeof value.msgId !== 'string') {
    return null;
  }
  if (value.grammar !== 'markdown' || value.origin !== 'runtime') {
    return null;
  }
  const userLanguageCodeRaw = value.userLanguageCode;
  if (
    userLanguageCodeRaw !== undefined &&
    (typeof userLanguageCodeRaw !== 'string' || !isLanguageCode(userLanguageCodeRaw))
  ) {
    return null;
  }
  const skipTaskdocRaw = value.skipTaskdoc;
  if (skipTaskdocRaw !== undefined && typeof skipTaskdocRaw !== 'boolean') {
    return null;
  }
  const tellaskReplyDirective =
    value.tellaskReplyDirective === undefined
      ? undefined
      : parseTellaskReplyDirective(value.tellaskReplyDirective);
  if (value.tellaskReplyDirective !== undefined && tellaskReplyDirective === null) {
    return null;
  }
  const sideDialogReplyTarget =
    value.sideDialogReplyTarget === undefined
      ? undefined
      : parseDialogSideDialogReplyTarget(value.sideDialogReplyTarget);
  if (value.sideDialogReplyTarget !== undefined && sideDialogReplyTarget === null) {
    return null;
  }
  const userLanguageCode = userLanguageCodeRaw;
  const skipTaskdoc = skipTaskdocRaw;
  const normalizedTellaskReplyDirective =
    tellaskReplyDirective === null ? undefined : tellaskReplyDirective;
  const normalizedSideDialogReplyTarget =
    sideDialogReplyTarget === null ? undefined : sideDialogReplyTarget;
  if (
    normalizedSideDialogReplyTarget !== undefined &&
    normalizedTellaskReplyDirective === undefined
  ) {
    return null;
  }
  if (
    normalizedTellaskReplyDirective !== undefined &&
    normalizedSideDialogReplyTarget !== undefined
  ) {
    return {
      content: value.content,
      msgId: value.msgId,
      grammar: 'markdown',
      origin: 'runtime',
      ...(userLanguageCode === undefined ? {} : { userLanguageCode }),
      ...(skipTaskdoc === undefined ? {} : { skipTaskdoc }),
      tellaskReplyDirective: normalizedTellaskReplyDirective,
      sideDialogReplyTarget: normalizedSideDialogReplyTarget,
    };
  }
  if (normalizedTellaskReplyDirective !== undefined) {
    return {
      content: value.content,
      msgId: value.msgId,
      grammar: 'markdown',
      origin: 'runtime',
      ...(userLanguageCode === undefined ? {} : { userLanguageCode }),
      ...(skipTaskdoc === undefined ? {} : { skipTaskdoc }),
      tellaskReplyDirective: normalizedTellaskReplyDirective,
    };
  }
  return {
    content: value.content,
    msgId: value.msgId,
    grammar: 'markdown',
    origin: 'runtime',
    ...(userLanguageCode === undefined ? {} : { userLanguageCode }),
    ...(skipTaskdoc === undefined ? {} : { skipTaskdoc }),
  };
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
  if (value.sideDialogCount !== undefined && typeof value.sideDialogCount !== 'number') return null;
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
        case 'waiting_for_sideDialogs':
          return { kind: 'blocked', reason: { kind: 'waiting_for_sideDialogs' } } as const;
        case 'needs_human_input_and_sideDialogs':
          return {
            kind: 'blocked',
            reason: { kind: 'needs_human_input_and_sideDialogs' },
          } as const;
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
    const directive = parseTellaskReplyDirective(deferredReplyReassertionRaw.directive);
    if (directive === null) return null;
    const resumeGuideSurfacedRaw = deferredReplyReassertionRaw.resumeGuideSurfaced;
    if (resumeGuideSurfacedRaw !== undefined && typeof resumeGuideSurfacedRaw !== 'boolean') {
      return null;
    }
    return {
      reason: 'user_interjection_with_parked_original_task',
      directive,
      ...(resumeGuideSurfacedRaw === undefined
        ? {}
        : { resumeGuideSurfaced: resumeGuideSurfacedRaw }),
    };
  })();
  if (deferredReplyReassertion === null) return null;

  const pendingCourseStartPromptRaw = (value as Record<string, unknown>).pendingCourseStartPrompt;
  const pendingCourseStartPrompt: DialogPendingCourseStartPrompt | null | undefined = (() => {
    if (pendingCourseStartPromptRaw === undefined) return undefined;
    return parseDialogPendingCourseStartPrompt(pendingCourseStartPromptRaw);
  })();
  if (pendingCourseStartPrompt === null) return null;

  return {
    currentCourse,
    lastModified: value.lastModified,
    messageCount: value.messageCount,
    functionCallCount: value.functionCallCount,
    sideDialogCount: value.sideDialogCount,
    status: value.status,
    generating: value.generating,
    needsDrive: value.needsDrive,
    displayState,
    executionMarker,
    fbrState,
    deferredReplyReassertion,
    pendingCourseStartPrompt,
    disableDiligencePush: value.disableDiligencePush,
    diligencePushRemainingBudget: value.diligencePushRemainingBudget,
  };
}

function isSideDialogResponseRecord(value: unknown): value is SideDialogResponseStateRecord {
  if (!isRecord(value)) return false;
  if (typeof value.responseId !== 'string') return false;
  if (value.responseId.trim() === '') return false;
  if (typeof value.sideDialogId !== 'string') return false;
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

function assertUniqueSideDialogResponseIds(
  records: readonly SideDialogResponseStateRecord[],
  context: string,
): void {
  const seen = new Set<string>();
  for (const record of records) {
    const responseId = record.responseId.trim();
    if (responseId === '') {
      throw new Error(`sideDialog responses empty responseId invariant violation: ${context}`);
    }
    if (seen.has(responseId)) {
      throw new Error(
        `sideDialog responses duplicate responseId invariant violation: ${context} responseId=${responseId}`,
      );
    }
    seen.add(responseId);
  }
}

function isReminderPriority(value: unknown): value is 'high' | 'medium' | 'low' {
  return value === 'high' || value === 'medium' || value === 'low';
}

function isReminderScope(value: unknown): value is 'dialog' | 'personal' | 'agent_shared' {
  return value === 'dialog' || value === 'personal' || value === 'agent_shared';
}

function isReminderRenderMode(value: unknown): value is 'plain' | 'markdown' {
  return value === 'plain' || value === 'markdown';
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
    if (entry.renderMode !== undefined && !isReminderRenderMode(entry.renderMode)) return false;
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
  if ('callSiteGenseq' in value.callSiteRef) {
    const callSiteGenseq = value.callSiteRef.callSiteGenseq;
    if (callSiteGenseq !== undefined) {
      if (typeof callSiteGenseq !== 'number') return false;
      if (!Number.isFinite(callSiteGenseq)) return false;
      if (Math.floor(callSiteGenseq) <= 0) return false;
    }
  }
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

  // === DialogStore interface methods ===

  /**
   * Create sideDialog with automatic persistence
   */
  public async createSideDialog(
    askerDialog: Dialog,
    targetAgentId: string,
    mentionList: string[] | undefined,
    tellaskContent: string,
    options: {
      callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
      originMemberId: string;
      askerDialogId: string;
      callId: string;
      sessionSlug?: string;
      collectiveTargets?: string[];
      effectiveFbrEffort?: number;
    },
  ): Promise<SideDialog> {
    const generatedId = generateDialogID();
    const nowTs = formatUnifiedTimestamp(new Date());
    const mainDialog =
      askerDialog instanceof MainDialog
        ? askerDialog
        : askerDialog instanceof SideDialog
          ? askerDialog.mainDialog
          : (() => {
              throw new Error(
                `createSideDialog invariant violation: unsupported asker type (${askerDialog.constructor.name})`,
              );
            })();
    const rootStatus = mainDialog.status;
    if (rootStatus !== 'running') {
      throw new Error(
        `createSideDialog invariant violation: main dialog must be running (rootId=${mainDialog.id.rootId}, status=${rootStatus})`,
      );
    }
    const sideDialogId = new DialogID(generatedId, mainDialog.id.rootId);

    // Prepare sideDialog store
    const sideDialogStore = new DiskFileDialogStore(sideDialogId);
    const sideDialog = new SideDialog(
      sideDialogStore,
      mainDialog,
      askerDialog.taskDocPath,
      sideDialogId,
      targetAgentId,
      buildSideDialogAskerStack({
        askerDialogId: options.askerDialogId,
        assignment: {
          callName: options.callName,
          mentionList,
          tellaskContent,
          originMemberId: options.originMemberId,
          askerDialogId: options.askerDialogId,
          callId: options.callId,
          collectiveTargets: options.collectiveTargets,
          effectiveFbrEffort: options.effectiveFbrEffort,
        },
      }),
      options.sessionSlug,
    );

    // Initial sideDialog user prompt is now persisted at first drive (driver.ts)

    // Ensure sideDialog directory and persist metadata under askerDialog/.sideDialogs/
    await this.ensureSideDialogDirectory(sideDialogId);
    const metadata: SideDialogMetadataFile = {
      id: sideDialogId.selfId,
      agentId: targetAgentId,
      taskDocPath: askerDialog.taskDocPath,
      createdAt: nowTs,
      sessionSlug: options.sessionSlug,
    };
    await DialogPersistence.saveSideDialogAskerStackState(sideDialogId, sideDialog.askerStack);
    await DialogPersistence.saveSideDialogMetadata(sideDialogId, metadata);

    const rootAnchor = resolveRootGenerationAnchor(askerDialog);
    const parentCourse = askerDialog.activeGenCourseOrUndefined ?? askerDialog.currentCourse;
    const sideDialogCreatedRecord: SideDialogCreatedRecord = {
      ts: nowTs,
      type: 'sideDialog_created_record',
      ...cloneRootGenerationAnchor(rootAnchor),
      sideDialogId: sideDialogId.selfId,
      askerDialogId: askerDialog.id.selfId,
      agentId: targetAgentId,
      taskDocPath: askerDialog.taskDocPath,
      createdAt: nowTs,
      sessionSlug: options.sessionSlug,
      assignmentFromAsker: {
        callName: options.callName,
        mentionList,
        tellaskContent,
        originMemberId: options.originMemberId,
        askerDialogId: options.askerDialogId,
        callId: options.callId,
        collectiveTargets: options.collectiveTargets,
        effectiveFbrEffort: options.effectiveFbrEffort,
      },
    };
    await this.appendEvent(askerDialog, parentCourse, sideDialogCreatedRecord);

    // Initialize latest.yaml via the mutation API (write-back will flush).
    await DialogPersistence.mutateDialogLatest(sideDialogId, () => ({
      kind: 'replace',
      next: {
        currentCourse: 1,
        lastModified: nowTs,
        status: 'active',
        messageCount: 0,
        functionCallCount: 0,
        sideDialogCount: 0,
        displayState: { kind: 'idle_waiting_user' },
        disableDiligencePush: false,
      },
    }));

    // AskerDialog clarification context is persisted in sideDialog metadata (askerDialogCall)
    const rootSideDialogCount = await DialogPersistence.countAllSideDialogsUnderRoot(
      mainDialog.id,
      rootStatus,
    );

    const sideDialogCreatedEvt: SideDialogEvent = {
      type: 'sideDialog_created_evt',
      dialog: {
        selfId: sideDialogId.selfId,
        rootId: sideDialogId.rootId,
      },
      timestamp: new Date().toISOString(),
      course: parentCourse,
      parentDialog: {
        selfId: askerDialog.id.selfId,
        rootId: askerDialog.id.rootId,
      },
      sideDialog: {
        selfId: sideDialogId.selfId,
        rootId: sideDialogId.rootId,
      },
      targetAgentId,
      callName: options.callName,
      mentionList,
      tellaskContent,
      rootSideDialogCount,
      sideDialogNode: {
        selfId: sideDialogId.selfId,
        rootId: sideDialogId.rootId,
        askerDialogId: askerDialog.id.selfId,
        agentId: targetAgentId,
        taskDocPath: askerDialog.taskDocPath,
        status: rootStatus,
        currentCourse: 1,
        createdAt: nowTs,
        lastModified: nowTs,
        displayState: { kind: 'idle_waiting_user' },
        sessionSlug: options.sessionSlug,
        assignmentFromAsker: {
          callName: options.callName,
          mentionList,
          tellaskContent,
          originMemberId: options.originMemberId,
          askerDialogId: options.askerDialogId,
          callId: options.callId,
          effectiveFbrEffort: options.effectiveFbrEffort,
        },
      },
    };
    // Post sideDialog_created_evt to PARENT's PubChan so frontend can receive it
    // The frontend subscribes to the parent's events, not the sideDialog's
    postDialogEvent(askerDialog, sideDialogCreatedEvt);

    return sideDialog;
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
    const existingTellaskResult = await this.findExistingTellaskResultRecord(dialog, result.callId);
    if (existingTellaskResult) {
      await this.raiseDuplicateCallResultInvariantViolation({
        dialog,
        kind: 'tellask_result',
        callId: result.callId,
        callName: result.callName,
        incomingCourse: course,
        incomingGenseq: undefined,
        existingCourse: existingTellaskResult.course,
        existingGenseq: undefined,
      });
    }
    const record = buildTellaskResultRecord(result);
    await this.appendEvent(dialog, course, record);
    postDialogEvent(dialog, buildTellaskResultEvent(result, course));
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
   * Ensure sideDialog directory exists (delegate to DialogPersistence)
   */
  private async ensureSideDialogDirectory(dialogId: DialogID): Promise<string> {
    return await DialogPersistence.ensureSideDialogDirectory(dialogId);
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

  private async findExistingCallRecord(
    dialog: Dialog,
    callId: string,
  ): Promise<
    | {
        course: number;
        record: FuncCallRecord | TellaskCallRecord;
      }
    | undefined
  > {
    const latest = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
    const maxCourse = latest?.currentCourse ?? dialog.currentCourse;
    for (let course = 1; course <= maxCourse; course += 1) {
      const events = await DialogPersistence.loadCourseEvents(dialog.id, course, dialog.status);
      for (const event of events) {
        if (event.type === 'func_call_record' && event.id === callId) {
          return { course, record: event };
        }
        if (event.type === 'tellask_call_record' && event.id === callId) {
          return { course, record: event };
        }
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

  private async raiseDuplicateCallInvariantViolation(args: {
    dialog: Dialog;
    kind: 'func_call' | 'tellask_call';
    callId: string;
    callName: string;
    incomingCourse: number;
    incomingGenseq: number;
    existingCourse: number;
    existingGenseq: number;
    existingName: string;
  }): Promise<never> {
    const err = new Error(
      `${args.kind} duplicate callId invariant violation: rootId=${args.dialog.id.rootId} selfId=${args.dialog.id.selfId} ` +
        `callId=${args.callId} callName=${args.callName} existingName=${args.existingName} ` +
        `existingCourse=${args.existingCourse} existingGenseq=${args.existingGenseq} ` +
        `incomingCourse=${args.incomingCourse} incomingGenseq=${args.incomingGenseq}`,
    );
    log.error('Duplicate call detected; rejecting second write', err, {
      rootId: args.dialog.id.rootId,
      selfId: args.dialog.id.selfId,
      callId: args.callId,
      callName: args.callName,
      kind: args.kind,
      existingName: args.existingName,
      existingCourse: args.existingCourse,
      existingGenseq: args.existingGenseq,
      incomingCourse: args.incomingCourse,
      incomingGenseq: args.incomingGenseq,
    });
    try {
      await this.streamError(args.dialog, err.message);
    } catch (streamErr) {
      log.warn('Failed to emit stream_error_evt for duplicate call', streamErr, {
        rootId: args.dialog.id.rootId,
        selfId: args.dialog.id.selfId,
        callId: args.callId,
        callName: args.callName,
        kind: args.kind,
      });
    }
    throw err;
  }

  private async raiseDuplicateCallResultInvariantViolation(args: {
    dialog: Dialog;
    kind: 'func_result' | 'tellask_result';
    callId: string;
    callName: string;
    incomingCourse: number;
    incomingGenseq?: number;
    existingCourse: number;
    existingGenseq?: number;
  }): Promise<never> {
    // Duplicate final results are not harmless transcript noise. They mean two different program
    // paths both believed they owned the same business-level completion fact for one callId.
    // In ask-back flows this usually points to identity confusion between asker/tellaskee or
    // canonical reply-tool delivery versus another mistaken write path. We fail fast here so the
    // second writer keeps its own stack trace instead of silently corrupting the dialog transcript.
    const err = new Error(
      `${args.kind} duplicate callId invariant violation: rootId=${args.dialog.id.rootId} selfId=${args.dialog.id.selfId} ` +
        `callId=${args.callId} callName=${args.callName} existingCourse=${args.existingCourse} ` +
        `existingGenseq=${String(args.existingGenseq)} incomingCourse=${args.incomingCourse} ` +
        `incomingGenseq=${String(args.incomingGenseq)}`,
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
    const message = payload.message.trim();
    if (toolCallId === '') {
      const error = new Error('tool_result_image_ingest_empty_tool_call_id');
      log.error('Protocol violation: toolResultImageIngest called with empty toolCallId', error, {
        dialog,
        payload,
      });
      throw error;
    }
    if (toolName === '') {
      const error = new Error('tool_result_image_ingest_empty_tool_name');
      log.error('Protocol violation: toolResultImageIngest called with empty toolName', error, {
        dialog,
        payload,
      });
      throw error;
    }
    if (provider === '' || model === '') {
      const error = new Error('tool_result_image_ingest_missing_provider_or_model');
      log.error('Protocol violation: toolResultImageIngest missing provider/model', error, {
        dialog,
        payload,
      });
      throw error;
    }
    if (relPath === '') {
      const error = new Error('tool_result_image_ingest_empty_rel_path');
      log.error(
        'Protocol violation: toolResultImageIngest called with empty artifact relPath',
        error,
        { dialog, payload },
      );
      throw error;
    }
    if (message === '') {
      const error = new Error('tool_result_image_ingest_empty_message');
      log.error('Protocol violation: toolResultImageIngest called with empty message', error, {
        dialog,
        payload,
      });
      throw error;
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
      message,
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

  public async userImageIngest(dialog: Dialog, payload: UserImageIngest): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const msgId =
      typeof payload.msgId === 'string' && payload.msgId.trim() !== ''
        ? payload.msgId.trim()
        : undefined;
    const model = payload.model.trim();
    const provider = payload.provider.trim();
    const relPath = payload.artifact.relPath.trim();
    const message = payload.message.trim();
    if (provider === '' || model === '') {
      const error = new Error('user_image_ingest_missing_provider_or_model');
      log.error('Protocol violation: userImageIngest missing provider/model', error, {
        dialog,
        payload,
      });
      throw error;
    }
    if (relPath === '') {
      const error = new Error('user_image_ingest_empty_rel_path');
      log.error('Protocol violation: userImageIngest called with empty artifact relPath', error, {
        dialog,
        payload,
      });
      throw error;
    }
    if (message === '') {
      const error = new Error('user_image_ingest_empty_message');
      log.error('Protocol violation: userImageIngest called with empty message', error, {
        dialog,
        payload,
      });
      throw error;
    }

    const normalizedPayload: UserImageIngest = {
      ...(msgId !== undefined ? { msgId } : {}),
      artifact: {
        rootId: payload.artifact.rootId,
        selfId: payload.artifact.selfId,
        status: payload.artifact.status,
        relPath,
      },
      provider,
      model,
      disposition: payload.disposition,
      message,
      ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
    };

    const record = buildUserImageIngestRecord(normalizedPayload, dialog.activeGenSeq);
    await this.appendEvent(dialog, course, record);

    const evt: UserImageIngestEvent = {
      type: 'user_image_ingest_evt',
      course,
      genseq: dialog.activeGenSeq,
      ...(msgId !== undefined ? { msgId } : {}),
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
  public async startNewCourse(dialog: Dialog, newCoursePrompt: DialogRuntimePrompt): Promise<void> {
    const previousCourse = dialog.currentCourse;
    const newCourse = previousCourse + 1;
    const isGenerationActive = dialog.hasActiveGeneration;
    if (newCoursePrompt.origin !== 'runtime') {
      throw new Error(
        `startNewCourse invariant violation: pending new-course prompt must have runtime origin for dialog=${dialog.id.valueOf()}`,
      );
    }

    // Persist reminders state for new course (exceptional overwrite)
    // Use the currently attached dialog's reminders to avoid stale state
    await this.persistReminders(dialog, dialog.reminders || []);

    // Update latest.yaml with new course (lastModified is set by persistence layer)
    await DialogPersistence.mutateDialogLatest(this.dialogId, () => ({
      kind: 'patch',
      patch: {
        currentCourse: newCourse,
        needsDrive: true,
        ...(isGenerationActive
          ? {}
          : {
              displayState: {
                kind: 'stopped',
                reason: { kind: 'pending_course_start' },
                continueEnabled: true,
              } as const,
              executionMarker: {
                kind: 'interrupted',
                reason: { kind: 'pending_course_start' },
              } as const,
            }),
        pendingCourseStartPrompt: newCoursePrompt,
      },
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
    contentItems?: HumanTextRecord['contentItems'],
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
      contentItems,
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
    const activeObligation = await DialogPersistence.loadActiveTellaskReplyObligation(
      dialog.id,
      dialog.status,
    );
    if (activeObligation?.targetCallId === payload.targetCallId) {
      await DialogPersistence.setActiveTellaskReplyObligation(dialog.id, undefined, dialog.status);
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
    if (!Number.isFinite(genseq) || genseq <= 0) {
      throw new Error(
        `persistFunctionCall invariant violation: missing valid genseq for func call ${id}`,
      );
    }
    const existingCall = await this.findExistingCallRecord(dialog, id);
    if (existingCall) {
      await this.raiseDuplicateCallInvariantViolation({
        dialog,
        kind: 'func_call',
        callId: id,
        callName: name,
        incomingCourse: course,
        incomingGenseq: genseq,
        existingCourse: existingCall.course,
        existingGenseq: existingCall.record.genseq,
        existingName: existingCall.record.name,
      });
    }
    const funcCallEvent = buildFuncCallRecord({ id, name, rawArgumentsText, genseq });

    await this.appendEvent(dialog, course, funcCallEvent);

    const funcCallEvt: FuncCallStartEvent = {
      type: 'func_call_requested_evt',
      funcId: id,
      funcName: name,
      arguments: rawArgumentsText,
      course,
      genseq,
    };
    postDialogEvent(dialog, funcCallEvt);
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
    if (!Number.isFinite(genseq) || genseq <= 0) {
      throw new Error(
        `persistTellaskCall invariant violation: missing valid genseq for tellask call ${id}`,
      );
    }
    const existingCall = await this.findExistingCallRecord(dialog, id);
    if (existingCall) {
      await this.raiseDuplicateCallInvariantViolation({
        dialog,
        kind: 'tellask_call',
        callId: id,
        callName: name,
        incomingCourse: course,
        incomingGenseq: genseq,
        existingCourse: existingCall.course,
        existingGenseq: existingCall.record.genseq,
        existingName: existingCall.record.name,
      });
    }
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

    if (tellaskCallEvent.deliveryMode === 'func_call_requested') {
      const funcCallEvt: FuncCallStartEvent = {
        type: 'func_call_requested_evt',
        funcId: id,
        funcName: name,
        arguments: formatTellaskCallArguments(tellaskCallEvent),
        course,
        genseq,
      };
      postDialogEvent(dialog, funcCallEvt);
    }
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

  public async loadSideDialogAssignmentFromAsker(
    dialogId: DialogID,
    status: DialogStatusKind,
  ): Promise<SideDialogAssignmentFromAsker | null> {
    if (dialogId.rootId === dialogId.selfId) return null;
    return await DialogPersistence.loadSideDialogAssignmentFromAsker(dialogId, status);
  }

  public async loadPendingSideDialogs(
    mainDialogId: DialogID,
    status: DialogStatusKind,
  ): Promise<PendingSideDialog[]> {
    const records = await DialogPersistence.loadPendingSideDialogs(mainDialogId, status);
    return records.map((record) => ({
      sideDialogId: new DialogID(record.sideDialogId, mainDialogId.rootId),
      createdAt: record.createdAt,
      mentionList: record.mentionList,
      tellaskContent: record.tellaskContent,
      targetAgentId: record.targetAgentId,
      callId: record.callId,
      callSiteCourse: record.callSiteCourse,
      callSiteGenseq: record.callSiteGenseq,
      callType: record.callType,
      sessionSlug: record.sessionSlug,
    }));
  }

  public async saveSideDialogRegistry(
    dialog: MainDialog,
    mainDialogId: DialogID,
    entries: Array<{
      key: string;
      sideDialogId: DialogID;
      agentId: string;
      sessionSlug?: string;
    }>,
    status: DialogStatusKind,
  ): Promise<void> {
    await DialogPersistence.saveSideDialogRegistry(mainDialogId, entries, status);
    await DialogPersistence.appendSideDialogRegistryReconciledRecord(
      mainDialogId,
      entries.map((entry) => ({
        key: entry.key,
        sideDialogId: entry.sideDialogId.selfId,
        agentId: entry.agentId,
        sessionSlug: entry.sessionSlug,
      })),
      resolveReconciledRecordWriteTarget(dialog),
      status,
    );
  }

  public async loadSideDialogRegistry(
    mainDialog: MainDialog,
    status: DialogStatusKind,
  ): Promise<void> {
    const entries = await DialogPersistence.loadSideDialogRegistry(mainDialog.id, status);
    const shouldPruneDead = status === 'running';
    let prunedDeadRegistryEntries = false;
    const restoringSideDialogs = new Map<string, Promise<SideDialog>>();

    const ensureSideDialogLoaded = async (
      sideDialogId: DialogID,
      ancestry: Set<string> = new Set(),
    ): Promise<SideDialog> => {
      if (ancestry.has(sideDialogId.selfId)) {
        throw new Error(
          `SideDialog registry restore invariant violation: cyclic parent chain ` +
            `(rootId=${mainDialog.id.rootId}, selfId=${sideDialogId.selfId})`,
        );
      }
      const existing = mainDialog.lookupDialog(sideDialogId.selfId);
      if (existing) {
        if (!(existing instanceof SideDialog)) {
          throw new Error(
            `Dialog registry type invariant violation: expected SideDialog ` +
              `(rootId=${mainDialog.id.rootId}, selfId=${sideDialogId.selfId})`,
          );
        }
        return existing;
      }

      const inFlight = restoringSideDialogs.get(sideDialogId.selfId);
      if (inFlight) {
        return await inFlight;
      }

      const task = (async (): Promise<SideDialog> => {
        const nextAncestry = new Set(ancestry);
        nextAncestry.add(sideDialogId.selfId);
        const sideDialogState = await DialogPersistence.restoreDialog(sideDialogId, status);
        if (!sideDialogState) {
          throw new Error(
            `SideDialog registry restore invariant violation: missing dialog state ` +
              `(rootId=${mainDialog.id.rootId}, selfId=${sideDialogId.selfId})`,
          );
        }

        const metadata = sideDialogState.metadata;
        if (!isSideDialogMetadataFile(metadata)) {
          throw new Error(
            `SideDialog registry restore invariant violation: expected sideDialog metadata ` +
              `(rootId=${mainDialog.id.rootId}, selfId=${sideDialogId.selfId})`,
          );
        }

        const askerStack = await DialogPersistence.loadSideDialogAskerStackState(
          sideDialogId,
          status,
        );
        if (!askerStack) {
          throw new Error(
            `SideDialog registry restore invariant violation: missing asker stack ` +
              `(rootId=${mainDialog.id.rootId}, selfId=${sideDialogId.selfId})`,
          );
        }
        const assignmentFromAsker = getDialogAskerStackCurrentAssignment(askerStack);

        const parentIds: string[] = [];
        const maybePushParentId = (candidate: string | undefined): void => {
          if (!candidate) return;
          if (candidate === mainDialog.id.rootId) return;
          if (candidate === sideDialogId.selfId) return;
          if (parentIds.includes(candidate)) return;
          parentIds.push(candidate);
        };
        maybePushParentId(assignmentFromAsker.askerDialogId);

        for (const parentId of parentIds) {
          if (mainDialog.lookupDialog(parentId)) {
            continue;
          }
          const parentDialogId = new DialogID(parentId, mainDialog.id.rootId);
          const parentMeta = await DialogPersistence.loadDialogMetadata(parentDialogId, status);
          if (!parentMeta) {
            throw new Error(
              `SideDialog registry restore invariant violation: missing parent metadata ` +
                `(rootId=${mainDialog.id.rootId}, childId=${sideDialogId.selfId}, parentId=${parentId})`,
            );
          }
          if (!isSideDialogMetadataFile(parentMeta)) {
            throw new Error(
              `SideDialog registry restore invariant violation: parent is not a sideDialog ` +
                `(rootId=${mainDialog.id.rootId}, childId=${sideDialogId.selfId}, parentId=${parentId})`,
            );
          }
          await ensureSideDialogLoaded(parentDialogId, nextAncestry);
          if (!mainDialog.lookupDialog(parentId)) {
            throw new Error(
              `SideDialog registry restore invariant violation: parent restore failed ` +
                `(rootId=${mainDialog.id.rootId}, childId=${sideDialogId.selfId}, parentId=${parentId})`,
            );
          }
        }

        const sideDialogStore = new DiskFileDialogStore(sideDialogId);
        const sideDialog = new SideDialog(
          sideDialogStore,
          mainDialog,
          metadata.taskDocPath,
          new DialogID(sideDialogId.selfId, mainDialog.id.rootId),
          metadata.agentId,
          askerStack,
          metadata.sessionSlug,
          {
            messages: sideDialogState.messages,
            reminders: sideDialogState.reminders,
            currentCourse: sideDialogState.currentCourse,
            contextHealth: sideDialogState.contextHealth,
          },
        );
        const latest = await DialogPersistence.loadDialogLatest(sideDialogId, status);
        sideDialog.disableDiligencePush = latest?.disableDiligencePush ?? false;
        if (sideDialog.sessionSlug) {
          mainDialog.registerSideDialog(sideDialog);
        }
        return sideDialog;
      })();
      restoringSideDialogs.set(sideDialogId.selfId, task);
      try {
        return await task;
      } finally {
        restoringSideDialogs.delete(sideDialogId.selfId);
      }
    };

    for (const entry of entries) {
      if (!entry.sessionSlug) continue;

      if (shouldPruneDead) {
        const latest = await DialogPersistence.loadDialogLatest(entry.sideDialogId, status);
        const executionMarker = latest?.executionMarker;
        if (executionMarker && executionMarker.kind === 'dead') {
          prunedDeadRegistryEntries = true;
          mainDialog.unregisterSideDialog(entry.agentId, entry.sessionSlug);
          log.debug('Skip dead sideDialog while loading Type B registry', undefined, {
            rootId: mainDialog.id.rootId,
            sideDialogId: entry.sideDialogId.selfId,
            agentId: entry.agentId,
            sessionSlug: entry.sessionSlug,
          });
          continue;
        }
      }

      const sideDialog = await ensureSideDialogLoaded(entry.sideDialogId);
      if (!sideDialog.sessionSlug) {
        throw new Error(
          `SideDialog registry invariant violation: missing sessionSlug on loaded sideDialog ` +
            `(rootId=${mainDialog.id.rootId}, selfId=${entry.sideDialogId.selfId}, expectedSessionSlug=${entry.sessionSlug})`,
        );
      }
      if (sideDialog.sessionSlug !== entry.sessionSlug) {
        throw new Error(
          `SideDialog registry invariant violation: sessionSlug mismatch ` +
            `(rootId=${mainDialog.id.rootId}, selfId=${entry.sideDialogId.selfId}, ` +
            `expected=${entry.sessionSlug}, actual=${sideDialog.sessionSlug})`,
        );
      }
      if (sideDialog.agentId !== entry.agentId) {
        throw new Error(
          `SideDialog registry invariant violation: agentId mismatch ` +
            `(rootId=${mainDialog.id.rootId}, selfId=${entry.sideDialogId.selfId}, ` +
            `expected=${entry.agentId}, actual=${sideDialog.agentId})`,
        );
      }
      mainDialog.registerSideDialog(sideDialog);
    }

    if (prunedDeadRegistryEntries) {
      await mainDialog.saveSideDialogRegistry();
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
              contentItems: event.contentItems,
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

      case 'user_image_ingest_record': {
        const userImageIngestEvt: UserImageIngestEvent = {
          type: 'user_image_ingest_evt',
          course,
          genseq: event.genseq,
          ...(event.msgId !== undefined ? { msgId: event.msgId } : {}),
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
              ...userImageIngestEvt,
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
          callId: event.callId,
          status: event.status,
          content: event.content,
          ...(event.callSiteCourse !== undefined ? { callSiteCourse: event.callSiteCourse } : {}),
          ...(event.callSiteGenseq !== undefined ? { callSiteGenseq: event.callSiteGenseq } : {}),
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

      case 'sideDialog_request_record': {
        // Handle sideDialog creation requests
        const persistedStatus = assertPersistableDialogStatus(
          status,
          'sendEventDirectlyToWebSocket:sideDialog_request_record',
        );
        const sideDialogId = new DialogID(event.sideDialogId, dialog.id.rootId);
        const metadata = await DialogPersistence.loadDialogMetadata(sideDialogId, status);
        if (!metadata || !isSideDialogMetadataFile(metadata)) {
          throw new Error(
            `sideDialog_created_evt replay invariant violation: metadata missing for ${sideDialogId.valueOf()} in ${status}`,
          );
        }
        const sideMeta = metadata;
        const sideLatest = await DialogPersistence.loadDialogLatest(sideDialogId, status);
        const assignmentFromAsker = await DialogPersistence.loadSideDialogAssignmentFromAsker(
          sideDialogId,
          status,
        );

        const derivedAskerDialogId = assignmentFromAsker.askerDialogId.trim();
        const callName = assignmentFromAsker.callName;
        if (
          callName !== 'tellask' &&
          callName !== 'tellaskSessionless' &&
          callName !== 'freshBootsReasoning'
        ) {
          throw new Error(
            `sideDialog_created_evt replay invariant violation: missing assignment callName for ${sideDialogId.valueOf()} in ${status}`,
          );
        }
        const rootSideDialogCount = await DialogPersistence.countAllSideDialogsUnderRoot(
          new DialogID(sideDialogId.rootId),
          persistedStatus,
        );

        const sideDialogCreatedEvent: SideDialogEvent = {
          type: 'sideDialog_created_evt',
          course,
          dialog: {
            // Add dialog field for proper event routing
            selfId: sideDialogId.selfId,
            rootId: sideDialogId.rootId,
          },
          parentDialog: {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          },
          sideDialog: {
            selfId: sideDialogId.selfId,
            rootId: sideDialogId.rootId,
          },
          targetAgentId: sideMeta.agentId,
          callName,
          mentionList: event.mentionList,
          tellaskContent: event.tellaskContent,
          rootSideDialogCount,
          sideDialogNode: {
            selfId: sideMeta.id,
            rootId: sideDialogId.rootId,
            askerDialogId: derivedAskerDialogId,
            agentId: sideMeta.agentId,
            taskDocPath: sideMeta.taskDocPath,
            status: persistedStatus,
            currentCourse: sideLatest?.currentCourse || 1,
            createdAt: sideMeta.createdAt,
            lastModified: sideLatest?.lastModified || sideMeta.createdAt,
            displayState: sideLatest?.displayState,
            sessionSlug: sideMeta.sessionSlug,
            assignmentFromAsker,
          },
          timestamp: event.ts,
        };

        if (ws.readyState === 1) {
          ws.send(JSON.stringify(sideDialogCreatedEvent));
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
                askerDialogId: event.askerDialogId,
                askerCourse: event.askerCourse,
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

      case 'sideDialog_created_record':
      case 'reminders_reconciled_record':
      case 'questions4human_reconciled_record':
      case 'pending_sideDialogs_reconciled_record':
      case 'sideDialog_registry_reconciled_record':
      case 'sideDialog_responses_reconciled_record':
        break;

      case 'tellask_carryover_record': {
        const base = {
          type: 'tellask_carryover_evt' as const,
          course,
          genseq: event.genseq,
          callSiteCourse: event.callSiteCourse,
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

type PendingSideDialogsWriteBackState =
  | { kind: 'file'; records: PendingSideDialogStateRecord[] }
  | { kind: 'deleted' };

type PendingSideDialogsWriteBackEntry =
  | {
      kind: 'scheduled';
      dialogId: DialogID;
      status: DialogStatusKind;
      state: PendingSideDialogsWriteBackState;
      timer: NodeJS.Timeout;
    }
  | {
      kind: 'flushing';
      dialogId: DialogID;
      status: DialogStatusKind;
      state: PendingSideDialogsWriteBackState;
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

type PendingSideDialogsMutation =
  | { kind: 'noop' }
  | { kind: 'append'; record: PendingSideDialogStateRecord }
  | { kind: 'removeBySideDialogId'; sideDialogId: string }
  | { kind: 'removeBySideDialogIds'; sideDialogIds: string[] }
  | { kind: 'replace'; records: PendingSideDialogStateRecord[] }
  | { kind: 'clear' };

type PendingSideDialogsMutateOutcome = {
  previousRecords: PendingSideDialogStateRecord[];
  records: PendingSideDialogStateRecord[];
  removedRecords: PendingSideDialogStateRecord[];
};

type DialogLatestPatch = Partial<Omit<DialogLatestFile, 'currentCourse' | 'lastModified'>> & {
  currentCourse?: number;
  lastModified?: string;
};

type DialogLatestMutation =
  | { kind: 'noop' }
  | { kind: 'patch'; patch: DialogLatestPatch }
  | { kind: 'replace'; next: DialogLatestFile };

type MainDialogWriteBackCancellationToken = Readonly<{
  scopeKey: string;
  generation: number;
  mainDialogId: string;
  status: DialogStatusKind;
}>;

class DialogWriteBackCanceledError extends Error {
  constructor(token: MainDialogWriteBackCancellationToken, phase: string) {
    super(`Dialog writeback canceled for ${token.mainDialogId} (${token.status}) during ${phase}`);
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
  private static readonly SIDE_DIALOGS_DIR = 'sideDialogs';
  private static readonly quarantinedMainDialogScopes = new Set<string>();

  private static readonly LATEST_WRITEBACK_WINDOW_MS = 300;
  private static readonly Q4H_WRITEBACK_WINDOW_MS = 300;
  private static readonly PENDING_SIDE_DIALOGS_WRITEBACK_WINDOW_MS = 300;

  private static readonly latestWriteBackMutexes: Map<string, AsyncFifoMutex> = new Map();
  private static readonly latestWriteBack: Map<string, LatestWriteBackEntry> = new Map();

  private static readonly q4hWriteBackMutexes: Map<string, AsyncFifoMutex> = new Map();
  private static readonly q4hWriteBack: Map<string, Q4HWriteBackEntry> = new Map();

  private static readonly pendingSideDialogsWriteBackMutexes: Map<string, AsyncFifoMutex> =
    new Map();
  private static readonly pendingSideDialogsWriteBack: Map<
    string,
    PendingSideDialogsWriteBackEntry
  > = new Map();

  private static readonly courseAppendMutexes: Map<string, AsyncFifoMutex> = new Map();
  private static readonly mainDialogWriteBackCancelGenerations: Map<string, number> = new Map();

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

  private static getPendingSideDialogsWriteBackMutex(key: string): AsyncFifoMutex {
    const existing = this.pendingSideDialogsWriteBackMutexes.get(key);
    if (existing) return existing;
    const created = new AsyncFifoMutex();
    this.pendingSideDialogsWriteBackMutexes.set(key, created);
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

  private static getPendingSideDialogsWriteBackKey(
    mainDialogId: DialogID,
    status: DialogStatusKind,
  ): string {
    return `${this.getDialogsRootDir()}|${status}|${mainDialogId.valueOf()}|pending-sideDialogs`;
  }

  private static getMainDialogWriteBackCancelScopeKey(
    mainDialogId: DialogID,
    status: DialogStatusKind,
  ): string {
    return `${this.getDialogsRootDir()}|${status}|${mainDialogId.selfId}|writeback-cancel`;
  }

  private static createMainDialogWriteBackCancellationToken(
    dialogId: DialogID,
    status: DialogStatusKind,
  ): MainDialogWriteBackCancellationToken {
    const mainDialogId =
      dialogId.rootId === dialogId.selfId ? dialogId : new DialogID(dialogId.rootId);
    const scopeKey = this.getMainDialogWriteBackCancelScopeKey(mainDialogId, status);
    return {
      scopeKey,
      generation: this.mainDialogWriteBackCancelGenerations.get(scopeKey) ?? 0,
      mainDialogId: mainDialogId.selfId,
      status,
    };
  }

  private static assertMainDialogWriteBackNotCanceled(
    token: MainDialogWriteBackCancellationToken,
    phase: string,
  ): void {
    if (this.quarantinedMainDialogScopes.has(token.scopeKey)) {
      throw new DialogWriteBackCanceledError(token, phase);
    }
    const currentGeneration = this.mainDialogWriteBackCancelGenerations.get(token.scopeKey) ?? 0;
    if (currentGeneration !== token.generation) {
      throw new DialogWriteBackCanceledError(token, phase);
    }
  }

  private static async rethrowWriteBackPathMissingAsCanceled(
    error: unknown,
    dialogPath: string,
    cancellationToken: MainDialogWriteBackCancellationToken | undefined,
    phase: string,
  ): Promise<void> {
    if (getErrorCode(error) !== 'ENOENT') {
      throw error;
    }
    if (cancellationToken) {
      this.assertMainDialogWriteBackNotCanceled(cancellationToken, phase);
      if (!(await this.pathExists(dialogPath))) {
        throw new DialogWriteBackCanceledError(cancellationToken, `${phase}:dialog-path-missing`);
      }
    }
    throw error;
  }

  private static cancelMainDialogWriteBacks(
    mainDialogId: DialogID,
    status: DialogStatusKind,
  ): void {
    const scopeKey = this.getMainDialogWriteBackCancelScopeKey(mainDialogId, status);
    const nextGeneration = (this.mainDialogWriteBackCancelGenerations.get(scopeKey) ?? 0) + 1;
    this.mainDialogWriteBackCancelGenerations.set(scopeKey, nextGeneration);
    this.clearWriteBackEntriesForMainDialog(mainDialogId, status);
  }

  private static getDialogMetadataPath(dialogId: DialogID, status: DialogStatusKind): string {
    const dialogPath =
      dialogId.rootId === dialogId.selfId
        ? this.getMainDialogPath(dialogId, status)
        : this.getSideDialogPath(dialogId, status);
    return path.join(dialogPath, 'dialog.yaml');
  }

  private static getDialogAskerStackPath(dialogId: DialogID, status: DialogStatusKind): string {
    const dialogPath =
      dialogId.rootId === dialogId.selfId
        ? this.getMainDialogPath(dialogId, status)
        : this.getSideDialogPath(dialogId, status);
    return path.join(dialogPath, 'asker-stack.jsonl');
  }

  private static async assertDialogMetadataExistsForAppend(
    dialogId: DialogID,
    status: DialogStatusKind,
    cancellationToken: MainDialogWriteBackCancellationToken,
    phase: string,
  ): Promise<void> {
    this.assertMainDialogWriteBackNotCanceled(cancellationToken, phase);
    const metadataPath = this.getDialogMetadataPath(dialogId, status);
    try {
      await fs.promises.access(metadataPath);
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') {
        this.assertMainDialogWriteBackNotCanceled(cancellationToken, `${phase}:metadata-missing`);
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
    const mainDialogId =
      dialogId.rootId === dialogId.selfId ? dialogId : new DialogID(dialogId.rootId);
    const rootPath = this.getMainDialogPath(mainDialogId, status);
    await fs.promises.rm(rootPath, { recursive: true, force: true });
  }

  private static clonePendingSideDialogRecords(
    records: readonly PendingSideDialogStateRecord[],
  ): PendingSideDialogStateRecord[] {
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
    entries: readonly SideDialogRegistryStateRecord[],
  ): SideDialogRegistryStateRecord[] {
    return entries.map((entry) => ({
      ...entry,
    }));
  }

  private static cloneSideDialogResponses(
    responses: readonly SideDialogResponseStateRecord[],
  ): SideDialogResponseStateRecord[] {
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

  static async appendPendingSideDialogsReconciledRecord(
    dialogId: DialogID,
    pendingSideDialogs: readonly PendingSideDialogStateRecord[],
    writeTarget: ReconciledRecordWriteTarget,
    status: DialogStatusKind,
  ): Promise<void> {
    const record: PendingSideDialogsReconciledRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'pending_sideDialogs_reconciled_record',
      ...cloneRootGenerationAnchor(writeTarget.rootAnchor),
      pendingSideDialogs: this.clonePendingSideDialogRecords(pendingSideDialogs),
    };
    await this.appendEvent(
      dialogId,
      resolveTargetCourseFromWriteTarget(writeTarget),
      record,
      status,
    );
  }

  static async appendSideDialogRegistryReconciledRecord(
    dialogId: DialogID,
    entries: readonly SideDialogRegistryStateRecord[],
    writeTarget: ReconciledRecordWriteTarget,
    status: DialogStatusKind,
  ): Promise<void> {
    const record: SideDialogRegistryReconciledRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'sideDialog_registry_reconciled_record',
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

  static async appendSideDialogResponsesReconciledRecord(
    dialogId: DialogID,
    responses: readonly SideDialogResponseStateRecord[],
    writeTarget: ReconciledRecordWriteTarget,
    status: DialogStatusKind,
  ): Promise<void> {
    const record: SideDialogResponsesReconciledRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'sideDialog_responses_reconciled_record',
      ...cloneRootGenerationAnchor(writeTarget.rootAnchor),
      responses: this.cloneSideDialogResponses(responses),
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
  static getMainDialogPath(dialogId: DialogID, status: DialogStatusKind = 'running'): string {
    if (dialogId.rootId !== dialogId.selfId) {
      throw new Error('Expected main dialog id');
    }
    const statusDir = getPersistableStatusDirName(status, 'DialogPersistence.getMainDialogPath');
    return path.join(this.getDialogsRootDir(), statusDir, dialogId.selfId);
  }

  /**
   * Get the events/state directory for a dialog (composite ID for sideDialogs)
   */
  static getDialogEventsPath(dialogId: DialogID, status: DialogStatusKind = 'running'): string {
    // Main dialogs store events under their own directory.
    // SideDialogs store events under the root's sideDialogs/<self> directory.
    if (dialogId.rootId === dialogId.selfId) {
      return this.getMainDialogPath(dialogId, status);
    }
    return this.getSideDialogPath(dialogId, status);
  }

  /**
   * Get the path for a sideDialog within an askerDialog
   */
  static getSideDialogPath(dialogId: DialogID, status: DialogStatusKind = 'running'): string {
    if (dialogId.rootId === dialogId.selfId) {
      throw new Error('Expected sideDialog id (self differs from root)');
    }
    const rootPath = this.getMainDialogPath(new DialogID(dialogId.rootId), status);
    return path.join(rootPath, this.SIDE_DIALOGS_DIR, dialogId.selfId);
  }

  private static getMalformedMainDialogPath(dialogId: DialogID, status: DialogStatusKind): string {
    if (dialogId.rootId !== dialogId.selfId) {
      throw new Error('Expected main dialog id');
    }
    void status;
    return path.join(this.getDialogsRootDir(), this.MALFORMED_DIR, dialogId.selfId);
  }

  private static inferMainDialogIdFromMetadataRelativeDir(relativeDir: string): DialogID | null {
    const dir = relativeDir.trim();
    if (dir === '' || dir === '.' || dir === path.sep) {
      return null;
    }
    const segments = dir.split(path.sep).filter((seg) => seg.length > 0 && seg !== '.');
    if (segments.length === 0) {
      return null;
    }
    const sideDialogsIndex = segments.indexOf(this.SIDE_DIALOGS_DIR);
    const rootSegments = sideDialogsIndex === -1 ? segments : segments.slice(0, sideDialogsIndex);
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
    const sideDialogsIndex = segments.indexOf(this.SIDE_DIALOGS_DIR);
    if (sideDialogsIndex === -1) {
      return segments.join('/');
    }
    const sideDialogSegments = segments.slice(sideDialogsIndex + 1);
    if (sideDialogSegments.length === 0) {
      return null;
    }
    return sideDialogSegments.join('/');
  }

  private static async listSideDialogIdsUnderRoot(
    mainDialogId: DialogID,
    status: DialogStatusKind,
  ): Promise<string[]> {
    const sideDialogsPath = path.join(
      this.getMainDialogPath(mainDialogId, status),
      this.SIDE_DIALOGS_DIR,
    );
    const sideDialogIds = new Set<string>();

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
            path.join(this.SIDE_DIALOGS_DIR, entryRelativePath),
          );
          if (!inferredId) {
            throw new Error(
              `Failed to infer sideDialog id from relative path ${entryRelativePath} under root ${mainDialogId.selfId}`,
            );
          }
          sideDialogIds.add(inferredId);
          continue;
        } catch (error: unknown) {
          if (getErrorCode(error) !== 'ENOENT') {
            throw error;
          }
        }

        await visit(fullPath, entryRelativePath);
      }
    };

    await visit(sideDialogsPath);
    return [...sideDialogIds];
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

  private static clearWriteBackEntriesForMainDialog(
    mainDialogId: DialogID,
    status: DialogStatusKind,
  ): void {
    const basePrefix = `${this.getDialogsRootDir()}|${status}|${mainDialogId.selfId}`;
    const matchesMainDialogKey = (key: string): boolean =>
      key === basePrefix || key.startsWith(`${basePrefix}#`) || key.startsWith(`${basePrefix}|`);

    for (const [key, entry] of this.latestWriteBack.entries()) {
      if (!matchesMainDialogKey(key)) continue;
      if (entry.kind === 'scheduled') {
        clearTimeout(entry.timer);
      }
      this.latestWriteBack.delete(key);
    }
    for (const key of this.latestWriteBackMutexes.keys()) {
      if (matchesMainDialogKey(key)) {
        this.latestWriteBackMutexes.delete(key);
      }
    }

    for (const [key, entry] of this.q4hWriteBack.entries()) {
      if (!matchesMainDialogKey(key)) continue;
      if (entry.kind === 'scheduled') {
        clearTimeout(entry.timer);
      }
      this.q4hWriteBack.delete(key);
    }
    for (const key of this.q4hWriteBackMutexes.keys()) {
      if (matchesMainDialogKey(key)) {
        this.q4hWriteBackMutexes.delete(key);
      }
    }

    for (const [key, entry] of this.pendingSideDialogsWriteBack.entries()) {
      if (!matchesMainDialogKey(key)) continue;
      if (entry.kind === 'scheduled') {
        clearTimeout(entry.timer);
      }
      this.pendingSideDialogsWriteBack.delete(key);
    }
    for (const key of this.pendingSideDialogsWriteBackMutexes.keys()) {
      if (matchesMainDialogKey(key)) {
        this.pendingSideDialogsWriteBackMutexes.delete(key);
      }
    }

    for (const key of this.courseAppendMutexes.keys()) {
      if (matchesMainDialogKey(key)) {
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
    const mainDialogId =
      dialogId.rootId === dialogId.selfId ? dialogId : new DialogID(dialogId.rootId);
    const quarantineKey = `${status}|${mainDialogId.selfId}`;
    if (quarantiningMainDialogs.has(quarantineKey)) {
      return;
    }
    quarantiningMainDialogs.add(quarantineKey);
    let quarantined = false;
    try {
      await prepareDialogQuarantineHook?.({
        dialogId,
        mainDialogId,
        status,
        reason,
        error,
      });
      this.quarantinedMainDialogScopes.add(
        this.getMainDialogWriteBackCancelScopeKey(mainDialogId, status),
      );
      this.cancelMainDialogWriteBacks(mainDialogId, status);

      const sourcePath = this.getMainDialogPath(mainDialogId, status);
      if (!(await this.pathExists(sourcePath))) {
        return;
      }

      let destinationPath = this.getMalformedMainDialogPath(mainDialogId, status);
      if (await this.pathExists(destinationPath)) {
        destinationPath = path.join(
          this.getDialogsRootDir(),
          this.MALFORMED_DIR,
          `${mainDialogId.selfId}__${randomUUID()}`,
        );
      }

      await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.promises.rename(sourcePath, destinationPath);
      quarantined = true;
      log.warn(`Quarantined malformed dialog ${mainDialogId.selfId}`, undefined, {
        status,
        reason,
        sourcePath,
        destinationPath,
        errorMessage: error.message,
        dialogId: dialogId.valueOf(),
        mainDialogId: mainDialogId.valueOf(),
      });
      dialogsQuarantinedBroadcaster?.({
        type: 'dialogs_quarantined',
        status: 'quarantining',
        fromStatus: assertPersistableDialogStatus(
          status,
          'DialogPersistence.quarantineMalformedDialog(fromStatus)',
        ),
        rootId: mainDialogId.selfId,
        dialogId: dialogId.selfId,
        reason,
        timestamp: formatUnifiedTimestamp(new Date()),
      });
    } finally {
      try {
        await finalizeDialogQuarantineHook?.({
          dialogId,
          mainDialogId,
          status,
          reason,
          error,
          quarantined,
        });
      } finally {
        quarantiningMainDialogs.delete(quarantineKey);
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
  static async ensureMainDialogDirectory(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<string> {
    const dialogPath = this.getMainDialogPath(dialogId, status);

    try {
      await fs.promises.mkdir(dialogPath, { recursive: true });
      return dialogPath;
    } catch (error) {
      log.error(`Failed to create dialog directory ${dialogPath}:`, error);
      throw error;
    }
  }

  /**
   * Ensure sideDialog directory structure exists
   */
  static async ensureSideDialogDirectory(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<string> {
    const sideDialogPath = this.getSideDialogPath(dialogId, status);

    try {
      await fs.promises.mkdir(sideDialogPath, { recursive: true });
      return sideDialogPath;
    } catch (error) {
      log.error(`Failed to create sideDialog directory ${sideDialogPath}:`, error);
      throw error;
    }
  }

  /**
   * Mark a dialog as completed
   */
  static async markDialogCompleted(dialogId: DialogID): Promise<void> {
    try {
      const dialogPath = this.getMainDialogPath(dialogId, 'running');
      const completedPath = this.getMainDialogPath(dialogId, 'completed');

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
   * List candidate main dialog IDs by scanning `dialog.yaml`.
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
                  const mainDialogId = this.inferMainDialogIdFromMetadataRelativeDir(
                    path.dirname(entryRelativePath),
                  );
                  if (mainDialogId) {
                    await this.quarantineMalformedDialog(
                      mainDialogId,
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
   * List all dialog IDs (main dialogs + sideDialogs) together with their root IDs.
   * This is the only safe way to enumerate sideDialogs because their directory names
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
    const mainDialogIdByDialogYamlPath = new Map<string, string | null>();

    const readDialogYamlId = async (dialogYamlPath: string): Promise<string | null> => {
      const cached = mainDialogIdByDialogYamlPath.get(dialogYamlPath);
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
        mainDialogIdByDialogYamlPath.set(dialogYamlPath, normalized);
        return normalized;
      } catch (error: unknown) {
        const persistenceError = findDomindsPersistenceFileError(error);
        if (persistenceError) {
          const relativeDir = path.relative(specificDir, path.dirname(dialogYamlPath));
          const mainDialogId = this.inferMainDialogIdFromMetadataRelativeDir(relativeDir);
          if (mainDialogId) {
            await this.quarantineMalformedDialog(
              mainDialogId,
              status,
              'listAllDialogIds:readDialogYamlId',
              persistenceError,
            );
          }
        }
        mainDialogIdByDialogYamlPath.set(dialogYamlPath, null);
        return null;
      }
    };

    const inferRootIdFromRelativeDir = async (relativeDir: string): Promise<string | null> => {
      const dir = relativeDir.trim();
      if (dir === '' || dir === '.' || dir === path.sep) return null;
      const segments = dir.split(path.sep).filter((seg) => seg.length > 0 && seg !== '.');
      if (segments.length === 0) return null;

      // Main dialog IDs in this repo can contain path separators (e.g. "f4/44/cd85c4e2").
      // The main dialog directory is therefore nested (RUN_DIR/<rootId>/dialog.yaml).
      //
      // To infer the rootId for any dialog.yaml we find (main dialog or sideDialog), scan prefixes of the
      // directory path and pick the first prefix that is itself a valid main dialog directory:
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
            const mainDialogId = this.inferMainDialogIdFromMetadataRelativeDir(relDir);
            if (mainDialogId) {
              await this.quarantineMalformedDialog(
                mainDialogId,
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
    const cancellationToken = this.createMainDialogWriteBackCancellationToken(dialogId, status);
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
    await this.appendEvent(dialog.id, course, attachRootGenerationRef(dialog, ev), dialog.status);
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
      // The dialog directory must already exist from the normal dialog lifecycle.
      // Do not create it here just to save reminders: missing directories should stay loud
      // so stale-path/status-transition bugs cannot silently recreate an old dialog location.

      const reminderState: ReminderStateFile = {
        reminders: reminders.map((r) => ({
          id: r.id,
          content: r.content,
          ownerName: r.owner ? r.owner.name : undefined,
          meta: r.meta,
          echoback: r.echoback,
          scope: r.scope ?? 'dialog',
          renderMode: r.renderMode ?? 'markdown',
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
            renderMode: r.renderMode ?? 'markdown',
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

        const cancellationToken = this.createMainDialogWriteBackCancellationToken(
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
    cancellationToken?: MainDialogWriteBackCancellationToken,
  ): Promise<void> {
    if (cancellationToken) {
      this.assertMainDialogWriteBackNotCanceled(cancellationToken, 'writeQ4HStateToDisk:start');
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
      // Get all running dialogs (main dialogs + sideDialogs) with correct rootId association.
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

  // === PHASE 6: SIDE DIALOG PENDING PERSISTENCE ===

  /**
   * Save pending sideDialogs that have an outstanding tellask/reply delivery.
   */
  static async savePendingSideDialogs(
    mainDialogId: DialogID,
    pendingSideDialogs: PendingSideDialogStateRecord[],
    rootAnchor?: RootGenerationAnchor,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    const next = pendingSideDialogs.map((r) => ({ ...r }));
    await this.mutatePendingSideDialogs(
      mainDialogId,
      () => ({ kind: 'replace', records: next }),
      rootAnchor,
      status,
    );
  }

  /**
   * Load pending sideDialogs that have an outstanding tellask/reply delivery.
   */
  static async loadPendingSideDialogs(
    mainDialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<PendingSideDialogStateRecord[]> {
    const key = this.getPendingSideDialogsWriteBackKey(mainDialogId, status);
    const staged = this.pendingSideDialogsWriteBack.get(key);
    if (staged) {
      return staged.state.kind === 'deleted' ? [] : staged.state.records;
    }

    try {
      return await this.loadPendingSideDialogsFromDisk(mainDialogId, status);
    } catch (error: unknown) {
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        mainDialogId,
        status,
        'loadPendingSideDialogs',
        error,
      );
      throw new Error('unreachable after loadPendingSideDialogs persistence rethrow');
    }
  }

  private static isPendingSideDialogRecord(value: unknown): value is PendingSideDialogStateRecord {
    if (!isRecord(value)) return false;
    if (typeof value.sideDialogId !== 'string') return false;
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
    if (typeof value.callSiteCourse !== 'number') return false;
    if (!Number.isInteger(value.callSiteCourse)) return false;
    if (value.callSiteCourse <= 0) return false;
    if (typeof value.callSiteGenseq !== 'number') return false;
    if (!Number.isInteger(value.callSiteGenseq)) return false;
    if (value.callSiteGenseq <= 0) return false;
    if (value.callType !== 'A' && value.callType !== 'B' && value.callType !== 'C') return false;
    if ('sessionSlug' in value) {
      const sessionSlug = value.sessionSlug;
      if (sessionSlug !== undefined && typeof sessionSlug !== 'string') return false;
    }
    return true;
  }

  private static assertNoDuplicateSessionedTellaskPendingRecords(
    records: readonly PendingSideDialogStateRecord[],
    context: Readonly<{
      rootId: string;
      selfId: string;
      status: DialogStatusKind;
    }>,
  ): void {
    const seen = new Map<string, PendingSideDialogStateRecord>();
    for (const record of records) {
      if (record.callType !== 'B') continue;
      if (record.callName !== 'tellask') continue;
      if (record.sessionSlug === undefined) continue;
      const sessionSlug = record.sessionSlug.trim();
      if (sessionSlug === '') continue;
      const key = `${record.targetAgentId}\0${sessionSlug}`;
      const previous = seen.get(key);
      if (previous) {
        throw new Error(
          `pending-sideDialogs invariant violation: duplicate sessioned tellask pending record ` +
            `(rootId=${context.rootId}, selfId=${context.selfId}, status=${context.status}, ` +
            `targetAgentId=${record.targetAgentId}, sessionSlug=${sessionSlug}, ` +
            `previousSideDialogId=${previous.sideDialogId}, previousCallId=${previous.callId}, ` +
            `duplicateSideDialogId=${record.sideDialogId}, duplicateCallId=${record.callId})`,
        );
      }
      seen.set(key, record);
    }
  }

  private static async loadPendingSideDialogsFromDisk(
    mainDialogId: DialogID,
    status: DialogStatusKind,
  ): Promise<PendingSideDialogStateRecord[]> {
    const dialogPath = this.getDialogResponsesPath(mainDialogId, status);
    const filePath = path.join(dialogPath, 'pending-sideDialogs.json');
    try {
      const content = await readPersistenceTextFile({
        filePath,
        source: 'pending_sideDialogs',
        format: 'json',
      });
      const parsed: unknown = parsePersistenceJson({
        content,
        filePath,
        source: 'pending_sideDialogs',
      });
      if (!Array.isArray(parsed) || !parsed.every((item) => this.isPendingSideDialogRecord(item))) {
        throw buildInvalidPersistenceFileError({
          source: 'pending_sideDialogs',
          format: 'json',
          filePath,
        });
      }
      this.assertNoDuplicateSessionedTellaskPendingRecords(parsed, {
        rootId: mainDialogId.rootId,
        selfId: mainDialogId.selfId,
        status,
      });
      return parsed;
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  static async mutatePendingSideDialogs(
    mainDialogId: DialogID,
    mutator: (previous: PendingSideDialogStateRecord[]) => PendingSideDialogsMutation,
    rootAnchor?: RootGenerationAnchor,
    status: DialogStatusKind = 'running',
  ): Promise<PendingSideDialogsMutateOutcome> {
    const key = this.getPendingSideDialogsWriteBackKey(mainDialogId, status);
    const mutex = this.getPendingSideDialogsWriteBackMutex(key);

    const release = await mutex.acquire();
    try {
      const staged = this.pendingSideDialogsWriteBack.get(key);
      const previousRecords =
        staged && staged.state.kind === 'file'
          ? staged.state.records
          : staged && staged.state.kind === 'deleted'
            ? []
            : await this.loadPendingSideDialogsFromDisk(mainDialogId, status);

      const mutation = mutator(previousRecords);
      let nextRecords: PendingSideDialogStateRecord[] = previousRecords;
      const removedRecords: PendingSideDialogStateRecord[] = [];

      if (mutation.kind === 'noop') {
        return { previousRecords, records: previousRecords, removedRecords: [] };
      } else if (mutation.kind === 'append') {
        nextRecords = [...previousRecords, mutation.record];
      } else if (mutation.kind === 'removeBySideDialogId') {
        for (const r of previousRecords) {
          if (r.sideDialogId === mutation.sideDialogId) removedRecords.push(r);
        }
        nextRecords = previousRecords.filter((r) => r.sideDialogId !== mutation.sideDialogId);
      } else if (mutation.kind === 'removeBySideDialogIds') {
        const remove = new Set(mutation.sideDialogIds);
        for (const r of previousRecords) {
          if (remove.has(r.sideDialogId)) removedRecords.push(r);
        }
        nextRecords = previousRecords.filter((r) => !remove.has(r.sideDialogId));
      } else if (mutation.kind === 'replace') {
        nextRecords = [...mutation.records];
      } else if (mutation.kind === 'clear') {
        nextRecords = [];
        removedRecords.push(...previousRecords);
      } else {
        const _exhaustive: never = mutation;
        throw new Error(`Unhandled pending-sideDialogs mutation: ${String(_exhaustive)}`);
      }

      for (let index = 0; index < nextRecords.length; index += 1) {
        if (!this.isPendingSideDialogRecord(nextRecords[index])) {
          throw new Error(
            `pending-sideDialogs write invariant violation: malformed record at index ${index} ` +
              `(rootId=${mainDialogId.rootId}, selfId=${mainDialogId.selfId}, status=${status})`,
          );
        }
      }
      this.assertNoDuplicateSessionedTellaskPendingRecords(nextRecords, {
        rootId: mainDialogId.rootId,
        selfId: mainDialogId.selfId,
        status,
      });

      const nextState: PendingSideDialogsWriteBackState =
        nextRecords.length === 0 ? { kind: 'deleted' } : { kind: 'file', records: nextRecords };

      const pending = this.pendingSideDialogsWriteBack.get(key);
      if (!pending) {
        const timer = setTimeout(() => {
          void this.flushPendingSideDialogsWriteBack(key);
        }, this.PENDING_SIDE_DIALOGS_WRITEBACK_WINDOW_MS);

        this.pendingSideDialogsWriteBack.set(key, {
          kind: 'scheduled',
          dialogId: mainDialogId,
          status,
          state: nextState,
          timer,
        });
      } else {
        pending.state = nextState;
        if (pending.kind === 'flushing') pending.dirty = true;
      }

      if (rootAnchor) {
        await this.appendPendingSideDialogsReconciledRecord(
          mainDialogId,
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

  static async appendPendingSideDialog(
    mainDialogId: DialogID,
    record: PendingSideDialogStateRecord,
    rootAnchor?: RootGenerationAnchor,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    await this.mutatePendingSideDialogs(
      mainDialogId,
      () => ({ kind: 'append', record }),
      rootAnchor,
      status,
    );
  }

  static async removePendingSideDialog(
    mainDialogId: DialogID,
    sideDialogId: string,
    rootAnchor?: RootGenerationAnchor,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    await this.mutatePendingSideDialogs(
      mainDialogId,
      () => ({ kind: 'removeBySideDialogId', sideDialogId }),
      rootAnchor,
      status,
    );
  }

  static async clearPendingSideDialogs(
    mainDialogId: DialogID,
    rootAnchor?: RootGenerationAnchor,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    await this.mutatePendingSideDialogs(
      mainDialogId,
      () => ({ kind: 'clear' }),
      rootAnchor,
      status,
    );
  }

  private static async flushPendingSideDialogsWriteBack(key: string): Promise<void> {
    const mutex = this.getPendingSideDialogsWriteBackMutex(key);

    let captured:
      | {
          dialogId: DialogID;
          status: DialogStatusKind;
          stateToWrite: PendingSideDialogsWriteBackState;
          inFlight: Promise<void>;
        }
      | undefined;

    {
      const release = await mutex.acquire();
      try {
        const entry = this.pendingSideDialogsWriteBack.get(key);
        if (!entry) return;
        if (entry.kind === 'flushing') return;
        if (entry.kind !== 'scheduled') return;
        clearTimeout(entry.timer);

        const cancellationToken = this.createMainDialogWriteBackCancellationToken(
          entry.dialogId,
          entry.status,
        );
        const inFlight = this.writePendingSideDialogsToDisk(
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
        this.pendingSideDialogsWriteBack.set(key, {
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
        const entry = this.pendingSideDialogsWriteBack.get(key);
        if (!entry) return;
        if (entry.kind !== 'flushing') return;
        if (entry.inFlight !== captured.inFlight) return;
        if (isDialogWriteBackCanceledError(error)) {
          this.pendingSideDialogsWriteBack.delete(key);
          return;
        }

        const timer = setTimeout(() => {
          void this.flushPendingSideDialogsWriteBack(key);
        }, this.PENDING_SIDE_DIALOGS_WRITEBACK_WINDOW_MS);

        this.pendingSideDialogsWriteBack.set(key, {
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
      const entry = this.pendingSideDialogsWriteBack.get(key);
      if (!entry) return;
      if (entry.kind !== 'flushing') return;
      if (entry.inFlight !== captured.inFlight) return;

      if (!entry.dirty) {
        this.pendingSideDialogsWriteBack.delete(key);
        return;
      }

      const timer = setTimeout(() => {
        void this.flushPendingSideDialogsWriteBack(key);
      }, this.PENDING_SIDE_DIALOGS_WRITEBACK_WINDOW_MS);
      this.pendingSideDialogsWriteBack.set(key, {
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

  private static async writePendingSideDialogsToDisk(
    mainDialogId: DialogID,
    state: PendingSideDialogsWriteBackState,
    status: DialogStatusKind,
    cancellationToken?: MainDialogWriteBackCancellationToken,
  ): Promise<void> {
    if (cancellationToken) {
      this.assertMainDialogWriteBackNotCanceled(
        cancellationToken,
        'writePendingSideDialogsToDisk:start',
      );
    }
    const dialogPath = this.getDialogResponsesPath(mainDialogId, status);
    const filePath = path.join(dialogPath, 'pending-sideDialogs.json');

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
        'writePendingSideDialogsToDisk:write-temp',
      );
      throw error;
    }
    await this.renameWithRetry(tempFile, filePath, 5, cancellationToken);
  }

  /**
   * Get the path for storing sideDialog responses (supports both main dialog and sideDialog tellaskers).
   * For Type C sideDialogs created inside another sideDialog, responses are stored at the parent's level.
   */
  static getDialogResponsesPath(dialogId: DialogID, status: DialogStatusKind = 'running'): string {
    // Main dialogs store responses in their own directory.
    // SideDialogs store responses in the tellasker's location (main dialog or sideDialog).
    if (dialogId.rootId === dialogId.selfId) {
      // Main dialog: use root's directory
      return this.getMainDialogPath(dialogId, status);
    }
    // SideDialog: store in parent's sideDialogs directory
    // The parent is always identified by rootId (could be root or parent sideDialog)
    const parentSelfId = dialogId.rootId;
    const rootPath = this.getMainDialogPath(new DialogID(parentSelfId), status);
    return path.join(rootPath, this.SIDE_DIALOGS_DIR, dialogId.selfId);
  }

  /**
   * Save responses delivered back from completed sideDialogs.
   */
  static async saveSideDialogResponses(
    mainDialogId: DialogID,
    responses: SideDialogResponseStateRecord[],
    rootAnchor?: RootGenerationAnchor,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    try {
      assertUniqueSideDialogResponseIds(responses, `save rootId=${mainDialogId.rootId}`);
      const dialogPath = this.getDialogResponsesPath(mainDialogId, status);
      const filePath = path.join(dialogPath, 'sideDialog-responses.json');

      // Atomic write operation
      const jsonContent = JSON.stringify(responses, null, 2);
      const tempFile = path.join(
        dialogPath,
        `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      await fs.promises.writeFile(tempFile, jsonContent, 'utf-8');
      await this.renameWithRetry(tempFile, filePath);
      if (rootAnchor) {
        await this.appendSideDialogResponsesReconciledRecord(
          mainDialogId,
          responses,
          rootAnchorWriteTarget(rootAnchor),
          status,
        );
      }
    } catch (error) {
      log.error(`Failed to save sideDialog responses for dialog ${mainDialogId}:`, error);
      throw error;
    }
  }

  /**
   * Load responses delivered back from completed sideDialogs.
   */
  static async loadSideDialogResponses(
    mainDialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<SideDialogResponseStateRecord[]> {
    try {
      const dialogPath = this.getDialogResponsesPath(mainDialogId, status);
      const filePath = path.join(dialogPath, 'sideDialog-responses.json');
      const inflightPath = path.join(dialogPath, 'sideDialog-responses.processing.json');

      try {
        const results: SideDialogResponseStateRecord[] = [];

        const tryReadArray = async (p: string): Promise<unknown[]> => {
          try {
            const content = await readPersistenceTextFile({
              filePath: p,
              source: 'sideDialog_responses',
              format: 'json',
            });
            const parsed: unknown = parsePersistenceJson({
              content,
              filePath: p,
              source: 'sideDialog_responses',
            });
            if (!Array.isArray(parsed)) {
              throw buildInvalidPersistenceFileError({
                source: 'sideDialog_responses',
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
          if (!isSideDialogResponseRecord(item)) {
            throw buildInvalidPersistenceFileError({
              source: 'sideDialog_responses',
              format: 'json',
              filePath,
            });
          }
          results.push(item);
        }
        assertUniqueSideDialogResponseIds(
          results,
          `load rootId=${mainDialogId.rootId} status=${status}`,
        );
        return results;
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return [];
        }
        throw error;
      }
    } catch (error: unknown) {
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        mainDialogId,
        status,
        'loadSideDialogResponses',
        error,
      );
      throw new Error('unreachable after loadSideDialogResponses persistence rethrow');
    }
  }

  static async loadSideDialogResponsesQueue(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<SideDialogResponseStateRecord[]> {
    try {
      const dialogPath = this.getDialogResponsesPath(dialogId, status);
      const filePath = path.join(dialogPath, 'sideDialog-responses.json');
      const content = await readPersistenceTextFile({
        filePath,
        source: 'sideDialog_responses',
        format: 'json',
      });
      const parsed: unknown = parsePersistenceJson({
        content,
        filePath,
        source: 'sideDialog_responses',
      });
      if (!Array.isArray(parsed) || !parsed.every((item) => isSideDialogResponseRecord(item))) {
        throw buildInvalidPersistenceFileError({
          source: 'sideDialog_responses',
          format: 'json',
          filePath,
        });
      }
      assertUniqueSideDialogResponseIds(
        parsed,
        `load queue rootId=${dialogId.rootId} selfId=${dialogId.selfId} status=${status}`,
      );
      return parsed;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return [];
      }
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        dialogId,
        status,
        'loadSideDialogResponsesQueue',
        error,
      );
      throw new Error('unreachable after loadSideDialogResponsesQueue persistence rethrow');
    }
  }

  static async appendSideDialogResponse(
    dialogId: DialogID,
    response: SideDialogResponseStateRecord,
    rootAnchor?: RootGenerationAnchor,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    const existing = await this.loadSideDialogResponsesQueue(dialogId, status);
    existing.push(response);
    await this.saveSideDialogResponses(dialogId, existing, rootAnchor, status);
  }

  static async takeSideDialogResponses(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<
    Array<{
      responseId: string;
      sideDialogId: string;
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

      const filePath = path.join(dialogPath, 'sideDialog-responses.json');
      const inflightPath = path.join(dialogPath, 'sideDialog-responses.processing.json');

      // If a previous processing file exists, merge it back so it will be re-processed.
      try {
        await fs.promises.access(inflightPath);
      } catch (error: unknown) {
        if (getErrorCode(error) !== 'ENOENT') {
          throw error;
        }
      }
      if (await this.pathExists(inflightPath)) {
        await this.rollbackTakenSideDialogResponses(dialogId, status);
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
        source: 'sideDialog_responses',
        format: 'json',
      });
      const parsed: unknown = parsePersistenceJson({
        content: raw,
        filePath: inflightPath,
        source: 'sideDialog_responses',
      });
      if (!Array.isArray(parsed) || !parsed.every((item) => isSideDialogResponseRecord(item))) {
        throw buildInvalidPersistenceFileError({
          source: 'sideDialog_responses',
          format: 'json',
          filePath: inflightPath,
        });
      }
      assertUniqueSideDialogResponseIds(
        parsed,
        `take rootId=${dialogId.rootId} selfId=${dialogId.selfId} status=${status}`,
      );
      return parsed;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return [];
      }
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        dialogId,
        status,
        'takeSideDialogResponses',
        error,
      );
      throw new Error('unreachable after takeSideDialogResponses persistence rethrow');
    }
  }

  static async commitTakenSideDialogResponses(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    const dialogPath = this.getDialogResponsesPath(dialogId, status);
    const inflightPath = path.join(dialogPath, 'sideDialog-responses.processing.json');
    await fs.promises.rm(inflightPath, { force: true });
  }

  static async rollbackTakenSideDialogResponses(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogResponsesPath(dialogId, status);

      const filePath = path.join(dialogPath, 'sideDialog-responses.json');
      const inflightPath = path.join(dialogPath, 'sideDialog-responses.processing.json');

      let inflight: SideDialogResponseStateRecord[] = [];
      try {
        const raw = await readPersistenceTextFile({
          filePath: inflightPath,
          source: 'sideDialog_responses',
          format: 'json',
        });
        const parsed: unknown = parsePersistenceJson({
          content: raw,
          filePath: inflightPath,
          source: 'sideDialog_responses',
        });
        if (!Array.isArray(parsed) || !parsed.every((item) => isSideDialogResponseRecord(item))) {
          throw buildInvalidPersistenceFileError({
            source: 'sideDialog_responses',
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

      let primary: SideDialogResponseStateRecord[] = [];
      try {
        const raw = await readPersistenceTextFile({
          filePath,
          source: 'sideDialog_responses',
          format: 'json',
        });
        const parsed: unknown = parsePersistenceJson({
          content: raw,
          filePath,
          source: 'sideDialog_responses',
        });
        if (!Array.isArray(parsed) || !parsed.every((item) => isSideDialogResponseRecord(item))) {
          throw buildInvalidPersistenceFileError({
            source: 'sideDialog_responses',
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

      const result = [...inflight, ...primary];
      assertUniqueSideDialogResponseIds(
        result,
        `rollback rootId=${dialogId.rootId} selfId=${dialogId.selfId} status=${status}`,
      );

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
        'rollbackTakenSideDialogResponses',
        error,
      );
      throw new Error('unreachable after rollbackTakenSideDialogResponses persistence rethrow');
    }
  }

  /**
   * Save main dialog metadata (write-once pattern)
   */
  static async saveMainDialogMetadata(
    dialogId: DialogID,
    metadata: MainDialogMetadataFile,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    try {
      if (dialogId.rootId !== dialogId.selfId) {
        throw new Error(`saveMainDialogMetadata expects a main dialog id: ${dialogId.valueOf()}`);
      }
      if (!isMainDialogMetadataFile(metadata)) {
        throw new Error(`Invalid main dialog metadata for ${dialogId.selfId}`);
      }
      if (metadata.id !== dialogId.selfId) {
        throw new Error(
          `Main dialog metadata id mismatch: dialogId=${dialogId.selfId} metadataId=${metadata.id}`,
        );
      }
      const dialogPath = this.getMainDialogPath(dialogId, status);

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
      if (!isMainDialogMetadataFile(metadata)) {
        throw new Error(`Expected main dialog metadata for ${dialogId.selfId}`);
      }
      return this.saveMainDialogMetadata(dialogId, metadata, status);
    }

    // For sideDialogs, delegate to saveSideDialogMetadata
    if (!isSideDialogMetadataFile(metadata)) {
      throw new Error(`Expected sideDialog metadata for ${dialogId.selfId}`);
    }
    return this.saveSideDialogMetadata(dialogId, metadata, status);
  }

  /**
   * Save sideDialog metadata under the root dialog's sideDialogs directory.
   */
  static async saveSideDialogMetadata(
    dialogId: DialogID,
    metadata: SideDialogMetadataFile,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    try {
      if (dialogId.rootId === dialogId.selfId) {
        throw new Error(`saveSideDialogMetadata expects a sideDialog id: ${dialogId.valueOf()}`);
      }
      if (!isSideDialogMetadataFile(metadata)) {
        throw new Error(`Invalid sideDialog metadata for ${dialogId.selfId}`);
      }
      if (metadata.id !== dialogId.selfId) {
        throw new Error(
          `sideDialog metadata id mismatch: dialogId=${dialogId.selfId} metadataId=${metadata.id}`,
        );
      }
      const subPath = this.getSideDialogPath(dialogId, status);
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
        `Failed to save sideDialog YAML for ${dialogId.selfId} under main dialog ${dialogId.rootId}:`,
        error,
      );
      throw error;
    }
  }

  static async saveSideDialogAskerStackState(
    dialogId: DialogID,
    state: DialogAskerStackState,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    if (dialogId.rootId === dialogId.selfId) {
      throw new Error('saveSideDialogAskerStackState expects a sideDialog id');
    }
    if (!isDialogAskerStackState(state)) {
      throw new Error(`Invalid asker stack for dialog ${dialogId.selfId}`);
    }
    await this.saveDialogAskerStack(dialogId, state, status);
  }

  static async loadSideDialogAskerStackState(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<DialogAskerStackState | null> {
    if (dialogId.rootId === dialogId.selfId) {
      return null;
    }
    const stack = await this.loadDialogAskerStack(dialogId, status);
    return stack.askerStack.length === 0 ? null : stack;
  }

  static async loadSideDialogAssignmentFromAsker(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<SideDialogAssignmentFromAsker> {
    if (dialogId.rootId === dialogId.selfId) {
      throw new Error('loadSideDialogAssignmentFromAsker expects a sideDialog id');
    }
    const stack = await this.loadSideDialogAskerStackState(dialogId, status);
    if (!stack) {
      throw new Error(`Missing asker stack for sideDialog ${dialogId.selfId}`);
    }
    return getDialogAskerStackCurrentAssignment(stack);
  }

  private static parseDialogAskerStackJsonlRows(args: { content: string; filePath: string }): {
    state: DialogAskerStackState;
    rows: DialogAskerStackJsonlRow[];
  } {
    const askerStack: AskerDialogStackFrame[] = [];
    const rows: DialogAskerStackJsonlRow[] = [];
    const rawLines = args.content.split(/(?<=\n)/u);
    let byteOffset = 0;
    for (let index = 0; index < rawLines.length; index += 1) {
      const rawLine = rawLines[index];
      const line = rawLine.endsWith('\n') ? rawLine.slice(0, -1) : rawLine;
      const startOffset = byteOffset;
      const endOffset = startOffset + Buffer.byteLength(rawLine, 'utf-8');
      byteOffset = endOffset;
      if (line.trim() === '') continue;
      const parsed = parsePersistenceJson({
        content: line,
        filePath: args.filePath,
        source: 'dialog_asker_stack',
        lineNumber: index + 1,
      });
      if (!isAskerDialogStackFrame(parsed)) {
        throw buildInvalidPersistenceFileError({
          source: 'dialog_asker_stack',
          format: 'jsonl',
          filePath: args.filePath,
          lineNumber: index + 1,
        });
      }
      askerStack.push(parsed);
      rows.push({
        frame: parsed,
        startOffset,
        endOffset,
      });
    }
    return { state: { askerStack }, rows };
  }

  private static async appendDialogAskerStackFrames(
    dialogId: DialogID,
    frames: readonly AskerDialogStackFrame[],
    status: DialogStatusKind,
  ): Promise<void> {
    if (frames.length === 0) return;
    const filePath = this.getDialogAskerStackPath(dialogId, status);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const content = frames.map((frame) => `${JSON.stringify(frame)}\n`).join('');
    await fs.promises.appendFile(filePath, content, 'utf-8');
  }

  static async saveDialogAskerStack(
    dialogId: DialogID,
    state: DialogAskerStackState,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    if (!isDialogAskerStackState(state)) {
      throw new Error(`Invalid asker stack for dialog ${dialogId.selfId}`);
    }
    const filePath = this.getDialogAskerStackPath(dialogId, status);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.truncate(filePath, 0).catch(async (error: unknown) => {
      if (getErrorCode(error) === 'ENOENT') {
        await fs.promises.writeFile(filePath, '', 'utf-8');
        return;
      }
      throw error;
    });
    await this.appendDialogAskerStackFrames(dialogId, state.askerStack, status);
  }

  static async loadDialogAskerStack(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<DialogAskerStackState> {
    return (await this.loadDialogAskerStackRows(dialogId, status)).state;
  }

  private static async loadDialogAskerStackRows(
    dialogId: DialogID,
    status: DialogStatusKind,
  ): Promise<{
    filePath: string;
    state: DialogAskerStackState;
    rows: DialogAskerStackJsonlRow[];
  }> {
    const filePath = this.getDialogAskerStackPath(dialogId, status);
    try {
      const content = await readPersistenceTextFile({
        filePath,
        source: 'dialog_asker_stack',
        format: 'jsonl',
      });
      return { filePath, ...this.parseDialogAskerStackJsonlRows({ content, filePath }) };
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') {
        return { filePath, state: { askerStack: [] }, rows: [] };
      }
      await this.rethrowAfterQuarantiningDialogPersistenceProblem(
        dialogId,
        status,
        'loadDialogAskerStack',
        error,
      );
      throw new Error('unreachable after loadDialogAskerStack persistence rethrow');
    }
  }

  private static async truncateDialogAskerStackToDepth(
    dialogId: DialogID,
    depth: number,
    status: DialogStatusKind,
  ): Promise<DialogAskerStackState> {
    const loaded = await this.loadDialogAskerStackRows(dialogId, status);
    if (!Number.isInteger(depth) || depth < 0 || depth > loaded.rows.length) {
      throw new Error(
        `asker stack truncate invariant violation: invalid depth ` +
          `(rootId=${dialogId.rootId}, selfId=${dialogId.selfId}, depth=${String(depth)}, size=${String(loaded.rows.length)})`,
      );
    }
    const truncateOffset =
      depth === loaded.rows.length
        ? (loaded.rows[loaded.rows.length - 1]?.endOffset ?? 0)
        : (loaded.rows[depth]?.startOffset ?? 0);
    await fs.promises.mkdir(path.dirname(loaded.filePath), { recursive: true });
    await fs.promises.truncate(loaded.filePath, truncateOffset).catch(async (error: unknown) => {
      if (getErrorCode(error) === 'ENOENT' && truncateOffset === 0) {
        await fs.promises.writeFile(loaded.filePath, '', 'utf-8');
        return;
      }
      throw error;
    });
    return { askerStack: loaded.rows.slice(0, depth).map((row) => row.frame) };
  }

  private static async replaceDialogAskerStackFrameAndAppend(args: {
    dialogId: DialogID;
    status: DialogStatusKind;
    findFrame: (frame: AskerDialogStackFrame) => boolean;
    missingFrameMessage: string;
    appendFrame: AskerDialogStackFrame;
  }): Promise<DialogAskerStackState> {
    const loaded = await this.loadDialogAskerStackRows(args.dialogId, args.status);
    const matchingIndexes = loaded.rows
      .map((row, index) => (args.findFrame(row.frame) ? index : -1))
      .filter((index) => index >= 0);
    if (matchingIndexes.length === 0) {
      throw new Error(args.missingFrameMessage);
    }
    if (matchingIndexes.length > 1) {
      throw new Error(
        `replace pending asker stack invariant violation: duplicate old frames ` +
          `(rootId=${args.dialogId.rootId}, selfId=${args.dialogId.selfId}, matches=${String(matchingIndexes.length)})`,
      );
    }
    const replaceIndex = matchingIndexes[0];
    const replacedRow = loaded.rows[replaceIndex];
    await fs.promises.truncate(loaded.filePath, replacedRow.startOffset);
    const retainedBefore = loaded.rows.slice(0, replaceIndex).map((row) => row.frame);
    const retainedAfter = loaded.rows.slice(replaceIndex + 1).map((row) => row.frame);
    await this.appendDialogAskerStackFrames(
      args.dialogId,
      [args.appendFrame, ...retainedAfter],
      args.status,
    );
    return {
      askerStack: [...retainedBefore, args.appendFrame, ...retainedAfter],
    };
  }

  static async pushTellaskReplyObligation(
    dialogId: DialogID,
    obligation: TellaskReplyDirective,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    const frame: AskerDialogStackFrame = {
      kind: 'asker_dialog_stack_frame',
      askerDialogId: obligation.targetDialogId,
      tellaskReplyObligation: obligation,
    };
    if (dialogId.rootId === dialogId.selfId) {
      await this.appendDialogAskerStackFrames(dialogId, [frame], status);
      return;
    }
    const state = await this.loadSideDialogAskerStackState(dialogId, status);
    if (!state) {
      throw new Error(`Missing asker stack for sideDialog ${dialogId.selfId}`);
    }
    await this.appendDialogAskerStackFrames(dialogId, [frame], status);
  }

  static async setActiveTellaskReplyObligation(
    dialogId: DialogID,
    obligation: TellaskReplyDirective | undefined,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    if (obligation !== undefined) {
      await this.pushTellaskReplyObligation(dialogId, obligation, status);
      return;
    }
    if (dialogId.rootId === dialogId.selfId) {
      const stackFile = await this.loadDialogAskerStack(dialogId, status);
      if (stackFile.askerStack.length === 0) return;
      await this.truncateDialogAskerStackToDepth(dialogId, stackFile.askerStack.length - 1, status);
      return;
    }
    const state = await this.loadSideDialogAskerStackState(dialogId, status);
    if (!state) {
      throw new Error(`Missing asker stack for sideDialog ${dialogId.selfId}`);
    }
    if (state.askerStack.length > 1) {
      await this.truncateDialogAskerStackToDepth(dialogId, state.askerStack.length - 1, status);
      return;
    }
    const top = getDialogAskerStackTop(state);
    await this.truncateDialogAskerStackToDepth(dialogId, 0, status);
    if (top.assignmentFromAsker === undefined) {
      return;
    }
    await this.appendDialogAskerStackFrames(
      dialogId,
      [
        {
          kind: 'asker_dialog_stack_frame',
          askerDialogId: top.askerDialogId,
          assignmentFromAsker: top.assignmentFromAsker,
        },
      ],
      status,
    );
  }

  static async loadActiveTellaskReplyObligation(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<TellaskReplyDirective | undefined> {
    if (dialogId.rootId === dialogId.selfId) {
      const stack = (await this.loadDialogAskerStack(dialogId, status)).askerStack;
      return stack[stack.length - 1]?.tellaskReplyObligation;
    }
    return getDialogAskerStackTop(await this.requireSideDialogAskerStackState(dialogId, status))
      .tellaskReplyObligation;
  }

  private static async requireSideDialogAskerStackState(
    dialogId: DialogID,
    status: DialogStatusKind,
  ): Promise<DialogAskerStackState> {
    const state = await this.loadSideDialogAskerStackState(dialogId, status);
    if (!state) {
      throw new Error(`Missing asker stack for sideDialog ${dialogId.selfId}`);
    }
    return state;
  }

  /**
   * Update assignmentFromAsker for an existing sideDialog.
   */
  static async updateSideDialogAssignment(
    dialogId: DialogID,
    assignment: SideDialogAssignmentFromAsker,
    status: DialogStatusKind = 'running',
    options?: Readonly<{
      replacePendingCallId?: string;
      replacePendingAskerDialogId?: string;
    }>,
  ): Promise<void> {
    if (dialogId.rootId === dialogId.selfId) {
      throw new Error('updateSideDialogAssignment expects a sideDialog id');
    }
    const metadata = await this.loadDialogMetadata(dialogId, status);
    if (!metadata || !isSideDialogMetadataFile(metadata)) {
      throw new Error(`Missing dialog metadata for sideDialog ${dialogId.selfId}`);
    }
    const nextAssignmentFrame = buildAssignmentAskerStackFrame({
      askerDialogId: assignment.askerDialogId,
      assignment,
    });
    if (options?.replacePendingCallId === undefined) {
      await this.requireSideDialogAskerStackState(dialogId, status);
      await this.appendDialogAskerStackFrames(dialogId, [nextAssignmentFrame], status);
    } else {
      const replacePendingAskerDialogId =
        options.replacePendingAskerDialogId ?? assignment.askerDialogId;
      await this.replaceDialogAskerStackFrameAndAppend({
        dialogId,
        status,
        findFrame: (frame) =>
          frame.assignmentFromAsker?.askerDialogId === replacePendingAskerDialogId &&
          frame.assignmentFromAsker.callId === options.replacePendingCallId,
        missingFrameMessage:
          `replace pending asker stack invariant violation: missing old frame ` +
          `(rootId=${dialogId.rootId}, selfId=${dialogId.selfId}, askerDialogId=${replacePendingAskerDialogId}, callId=${options.replacePendingCallId})`,
        appendFrame: nextAssignmentFrame,
      });
    }
  }

  /**
   * Load main dialog metadata
   */
  static async loadMainDialogMetadata(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<MainDialogMetadataFile | null> {
    try {
      const dialogPath = this.getMainDialogPath(dialogId, status);
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

        if (!isMainDialogMetadataFile(parsed)) {
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
          'loadMainDialogMetadata',
          error,
        );
        throw new Error('unreachable after loadMainDialogMetadata persistence rethrow');
      }
    } catch (error: unknown) {
      log.error(`Failed to load dialog YAML for dialog ${dialogId.selfId}:`, error);
      throw error;
    }
  }

  /**
   * Load dialog metadata from the path implied by the DialogID.
   */
  static async loadDialogMetadata(
    dialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<DialogMetadataFile | null> {
    if (dialogId.rootId === dialogId.selfId) {
      return this.loadMainDialogMetadata(dialogId, status);
    }

    const sideDialogPath = this.getSideDialogPath(dialogId, status);
    const metadataFilePath = path.join(sideDialogPath, 'dialog.yaml');

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
      if (!isSideDialogMetadataFile(parsed)) {
        throw buildInvalidPersistenceFileError({
          source: 'dialog_metadata',
          format: 'yaml',
          filePath: metadataFilePath,
        });
      }
      if (parsed.id !== dialogId.selfId) {
        throw buildInvalidPersistenceFileError({
          source: 'dialog_metadata',
          format: 'yaml',
          filePath: metadataFilePath,
        });
      }
      const askerStack = await this.loadSideDialogAskerStackState(dialogId, status);
      if (!askerStack) {
        throw buildInvalidPersistenceFileError({
          source: 'dialog_asker_stack',
          format: 'jsonl',
          filePath: this.getDialogAskerStackPath(dialogId, status),
        });
      }
      getDialogAskerStackCurrentAssignment(askerStack);
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
    cancellationToken?: MainDialogWriteBackCancellationToken,
  ): Promise<void> {
    try {
      if (cancellationToken) {
        this.assertMainDialogWriteBackNotCanceled(
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
    cancellationToken?: MainDialogWriteBackCancellationToken,
  ): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (cancellationToken) {
          this.assertMainDialogWriteBackNotCanceled(
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
    cancellationToken?: MainDialogWriteBackCancellationToken,
  ): Promise<DialogLatestFile> {
    const key = this.getLatestWriteBackKey(dialogId, status);
    const mutex = this.getLatestWriteBackMutex(key);
    const effectiveCancellationToken =
      cancellationToken ?? this.createMainDialogWriteBackCancellationToken(dialogId, status);

    const release = await mutex.acquire();
    try {
      this.assertMainDialogWriteBackNotCanceled(effectiveCancellationToken, 'mutateDialogLatest');
      const staged = this.latestWriteBack.get(key);
      const latestFromDisk = staged ? null : await this.loadDialogLatestFromDisk(dialogId, status);
      const existing = (staged ? staged.latest : latestFromDisk) || {
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

      updated = normalizeGeneratingDisplayStateMismatch(dialogId, status, existing, updated, {
        trigger: 'mutateDialogLatest',
        mutationKind: mutation.kind,
        patchSummary:
          mutation.kind === 'patch'
            ? summarizeLatestMutationPatch(mutation.patch)
            : mutation.kind === 'replace'
              ? summarizeLatestProjectionState(mutation.next)
              : null,
        latestSource: staged ? 'staged' : latestFromDisk ? 'disk' : 'default_bootstrap',
        latestWriteBackKey: key,
      });

      this.assertMainDialogWriteBackNotCanceled(
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
        const cancellationToken = this.createMainDialogWriteBackCancellationToken(
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

  static async clearPendingCourseStartPrompt(
    dialogId: DialogID,
    msgId: string,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    const normalizedMsgId = msgId.trim();
    if (normalizedMsgId === '') {
      throw new Error(
        `clearPendingCourseStartPrompt invariant violation: empty msgId for dialog=${dialogId.valueOf()}`,
      );
    }
    await this.mutateDialogLatest(
      dialogId,
      (previous) => {
        const pending = previous.pendingCourseStartPrompt;
        if (!pending || pending.msgId !== normalizedMsgId) {
          return { kind: 'noop' };
        }
        const previousDisplayState = previous.displayState;
        const displayState =
          previousDisplayState?.kind === 'stopped' &&
          previousDisplayState.reason.kind === 'pending_course_start'
            ? previous.generating === true
              ? (() => {
                  const warningDetails: Record<string, unknown> = {
                    trigger: 'clearPendingCourseStartPrompt',
                    dialogId: dialogId.valueOf(),
                    rootId: dialogId.rootId,
                    selfId: dialogId.selfId,
                    status,
                    pendingCourseStartMsgId: normalizedMsgId,
                    previous: summarizeLatestProjectionState(previous),
                    intendedPatch: summarizeLatestMutationPatch({
                      pendingCourseStartPrompt: undefined,
                      needsDrive: false,
                      displayState: { kind: 'proceeding' },
                      executionMarker:
                        previous.executionMarker?.kind === 'interrupted' &&
                        previous.executionMarker.reason.kind === 'pending_course_start'
                          ? undefined
                          : previous.executionMarker,
                    }),
                    callStack: captureInvariantWarningStack(),
                  };
                  emitInvariantWarning(
                    'clearPendingCourseStartPrompt invariant warning: generating dialog still projected as pending_course_start; healing displayState to proceeding',
                    warningDetails,
                  );
                  return { kind: 'proceeding' } as const;
                })()
              : ({ kind: 'idle_waiting_user' } as const)
            : previousDisplayState;
        return {
          kind: 'patch',
          patch: {
            pendingCourseStartPrompt: undefined,
            needsDrive: false,
            displayState,
            executionMarker:
              previous.executionMarker?.kind === 'interrupted' &&
              previous.executionMarker.reason.kind === 'pending_course_start'
                ? undefined
                : previous.executionMarker,
          },
        };
      },
      status,
    );
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
   * Count sideDialogs under a main dialog (no single-layer listing exposed)
   */
  static async countAllSideDialogsUnderRoot(
    mainDialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<number> {
    if (mainDialogId.rootId !== mainDialogId.selfId) {
      throw new Error(
        `countAllSideDialogsUnderRoot invariant violation: expected main dialog id, got ${mainDialogId.valueOf()}`,
      );
    }
    try {
      const dialogIds = await this.listAllDialogIds(status);
      return dialogIds.filter(
        (dialogId) =>
          dialogId.rootId === mainDialogId.rootId && dialogId.selfId !== dialogId.rootId,
      ).length;
    } catch (error) {
      log.error(`Failed to count all sideDialogs under root ${mainDialogId.selfId}:`, error);
      throw error;
    }
  }

  // === HIERARCHICAL DIALOG RESTORATION ===

  /**
   * Restore complete dialog tree from disk
   */
  static async restoreDialogTree(
    mainDialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<DialogPersistenceState | null> {
    try {
      // First restore the main dialog
      const rootState = await this.restoreDialog(mainDialogId, status);
      if (!rootState) {
        return null;
      }

      // Recursively restore sideDialogs
      const sideDialogIds = await this.listSideDialogIdsUnderRoot(mainDialogId, status);
      for (const sideDialogId of sideDialogIds) {
        await this.restoreDialogTree(new DialogID(sideDialogId, mainDialogId.rootId), status);
      }

      return rootState;
    } catch (error) {
      log.error(`Failed to restore dialog tree for ${mainDialogId.valueOf()}:`, error);
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
            contentItems: event.contentItems,
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
        case 'user_image_ingest_record':
          // UI-only per-generation image projection diagnostics for user attachments.
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
            callId: event.callId,
            callName: event.callName,
            status: event.status,
            content: event.content,
            contentItems: event.contentItems,
            ...(event.callSiteCourse !== undefined ? { callSiteCourse: event.callSiteCourse } : {}),
            ...(event.callSiteGenseq !== undefined ? { callSiteGenseq: event.callSiteGenseq } : {}),
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
            contentItems: event.contentItems,
            callSiteCourse: event.callSiteCourse,
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
        case 'sideDialog_request_record':
          // These events are handled separately in dialog restoration
          // Skip them for message reconstruction
          break;
        case 'tellask_call_anchor_record':
          // This record is UI navigation metadata for deep links in tellaskee dialogs.
          // It does not contribute to model context or chat transcript reconstruction.
          break;
        case 'ui_only_markdown_record':
          // UI-only records are replay-only rendering facts. They do not enter dialog messages or ctx.
          break;
        case 'sideDialog_created_record':
        case 'reminders_reconciled_record':
        case 'questions4human_reconciled_record':
        case 'pending_sideDialogs_reconciled_record':
        case 'sideDialog_registry_reconciled_record':
        case 'sideDialog_responses_reconciled_record':
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
   * Delete a main dialog directory (including sideDialogs) from disk.
   * Caller must provide the source status explicitly.
   */
  static async deleteMainDialog(
    mainDialogId: DialogID,
    fromStatus: DialogStatusKind,
  ): Promise<boolean> {
    if (mainDialogId.selfId !== mainDialogId.rootId) {
      throw new Error('deleteMainDialog expects a main dialog id');
    }
    const exists = await this.loadMainDialogMetadata(mainDialogId, fromStatus);
    if (!exists) return false;

    // Best-effort cleanup: remove the dialog from all status directories to avoid leaving behind
    // orphaned placeholder paths (e.g. `run/<id>/latest.yaml`) after a delete.
    for (const candidate of PERSISTABLE_DIALOG_STATUSES) {
      this.cancelMainDialogWriteBacks(mainDialogId, candidate);
      const candidatePath = this.getMainDialogPath(mainDialogId, candidate);
      await fs.promises.rm(candidatePath, { recursive: true, force: true });
    }
    return true;
  }

  // === REGISTRY PERSISTENCE ===

  /**
   * Save sideDialog registry (TYPE B entries).
   */
  static async saveSideDialogRegistry(
    mainDialogId: DialogID,
    entries: Array<{
      key: string;
      sideDialogId: DialogID;
      agentId: string;
      sessionSlug?: string;
    }>,
    status: DialogStatusKind = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogResponsesPath(mainDialogId, status);
      const registryFilePath = path.join(dialogPath, 'registry.yaml');

      const serializableEntries = entries.map((entry) => ({
        key: entry.key,
        sideDialogId: entry.sideDialogId.selfId,
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
      log.error(`Failed to save sideDialog registry for dialog ${mainDialogId}:`, error);
      throw error;
    }
  }

  /**
   * Load sideDialog registry.
   */
  static async loadSideDialogRegistry(
    mainDialogId: DialogID,
    status: DialogStatusKind = 'running',
  ): Promise<
    Array<{
      key: string;
      sideDialogId: DialogID;
      agentId: string;
      sessionSlug?: string;
    }>
  > {
    try {
      const dialogPath = this.getDialogResponsesPath(mainDialogId, status);
      const registryFilePath = path.join(dialogPath, 'registry.yaml');

      const content = await readPersistenceTextFile({
        filePath: registryFilePath,
        source: 'sideDialog_registry',
        format: 'yaml',
      });
      const parsed: unknown = parsePersistenceYaml({
        content,
        filePath: registryFilePath,
        source: 'sideDialog_registry',
      });

      if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
        throw buildInvalidPersistenceFileError({
          source: 'sideDialog_registry',
          format: 'yaml',
          filePath: registryFilePath,
        });
      }

      const entries = parsed.entries.map((entry: unknown) => {
        if (
          !isRecord(entry) ||
          typeof entry.key !== 'string' ||
          typeof entry.sideDialogId !== 'string' ||
          typeof entry.agentId !== 'string' ||
          (entry.sessionSlug !== undefined && typeof entry.sessionSlug !== 'string')
        ) {
          throw buildInvalidPersistenceFileError({
            source: 'sideDialog_registry',
            format: 'yaml',
            filePath: registryFilePath,
          });
        }
        return {
          key: entry.key,
          sideDialogId: new DialogID(entry.sideDialogId, mainDialogId.rootId),
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
        mainDialogId,
        status,
        'loadSideDialogRegistry',
        error,
      );
      throw new Error('unreachable after loadSideDialogRegistry persistence rethrow');
    }
  }
}
