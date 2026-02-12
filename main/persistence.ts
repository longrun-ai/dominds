/**
 * Module: persistence
 *
 * Modern dialog persistence with strong typing and latest.yaml support.
 * Provides file-based storage with append-only events and atomic operations.
 */

import * as fs from 'fs';
import { randomUUID } from 'node:crypto';
import * as path from 'path';
import { WebSocket } from 'ws';
import * as yaml from 'yaml';
import type { PendingSubdialog } from './dialog';
import { Dialog, DialogID, DialogStore, RootDialog, SubDialog } from './dialog';
import { postDialogEvent, postDialogEventById } from './evt-registry';
import { ChatMessage, FuncResultMsg } from './llm/client';
import { log } from './log';
import { AsyncFifoMutex } from './shared/async-fifo-mutex';
import type { ContextHealthSnapshot } from './shared/types/context-health';
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
  Q4HAnsweredEvent,
  StreamErrorEvent,
  SubdialogEvent,
  TeammateCallResponseEvent,
  TeammateCallStartEvent,
  TeammateResponseEvent,
  ThinkingChunkEvent,
  ThinkingFinishEvent,
  ThinkingStartEvent,
  WebSearchCallAction,
  WebSearchCallEvent,
} from './shared/types/dialog';
import type { LanguageCode } from './shared/types/language';
import type {
  AgentThoughtRecord,
  AgentWordsRecord,
  DialogLatestFile,
  DialogMetadataFile,
  FuncCallRecord,
  FuncResultRecord,
  HumanQuestion,
  HumanTextRecord,
  PersistedDialogRecord,
  ProviderData,
  Questions4HumanFile,
  ReminderStateFile,
  RootDialogMetadataFile,
  SubdialogMetadataFile,
  TeammateCallResultRecord,
  TeammateResponseRecord,
  ToolArguments,
  UiOnlyMarkdownRecord,
  WebSearchCallRecord,
} from './shared/types/storage';
import { formatUnifiedTimestamp } from './shared/utils/time';
import { Reminder } from './tool';
import { getReminderOwner } from './tools/registry';

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === 'string' ? maybeCode : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRootDialogMetadataFile(value: unknown): value is RootDialogMetadataFile {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (typeof value.agentId !== 'string') return false;
  if (typeof value.taskDocPath !== 'string') return false;
  if (typeof value.createdAt !== 'string') return false;
  if (
    value.subdialogAgentPrimingMode !== undefined &&
    value.subdialogAgentPrimingMode !== 'do' &&
    value.subdialogAgentPrimingMode !== 'reuse' &&
    value.subdialogAgentPrimingMode !== 'skip'
  ) {
    return false;
  }
  if (value.supdialogId !== undefined) return false;
  if (value.sessionSlug !== undefined) return false;
  if (value.assignmentFromSup !== undefined) return false;
  return true;
}

function isSubdialogMetadataFile(value: unknown): value is SubdialogMetadataFile {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (typeof value.agentId !== 'string') return false;
  if (typeof value.taskDocPath !== 'string') return false;
  if (typeof value.createdAt !== 'string') return false;
  if (typeof value.supdialogId !== 'string') return false;
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

  switch (assignment.callName) {
    case 'tellask':
    case 'tellaskSessionless': {
      if (!Array.isArray(assignment.mentionList)) return false;
      if (assignment.mentionList.length < 1) return false;
      if (!assignment.mentionList.every((item) => typeof item === 'string')) return false;
      break;
    }
    case 'freshBootsReasoning': {
      if (assignment.mentionList !== undefined) return false;
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

  const runStateRaw = (value as Record<string, unknown>).runState;
  const runState: DialogLatestFile['runState'] | null = (() => {
    if (runStateRaw === undefined) return undefined;
    if (!isRecord(runStateRaw)) return null;
    if (typeof runStateRaw.kind !== 'string') return null;
    const kind = runStateRaw.kind;
    if (kind === 'idle_waiting_user') return { kind: 'idle_waiting_user' } as const;
    if (kind === 'proceeding') return { kind: 'proceeding' } as const;
    if (kind === 'proceeding_stop_requested') {
      const reason = runStateRaw.reason;
      if (reason !== 'user_stop' && reason !== 'emergency_stop') return null;
      return { kind: 'proceeding_stop_requested', reason } as const;
    }
    if (kind === 'interrupted') {
      const reason = runStateRaw.reason;
      if (!isRecord(reason) || typeof reason.kind !== 'string') return null;
      switch (reason.kind) {
        case 'user_stop':
          return { kind: 'interrupted', reason: { kind: 'user_stop' } } as const;
        case 'emergency_stop':
          return { kind: 'interrupted', reason: { kind: 'emergency_stop' } } as const;
        case 'server_restart':
          return { kind: 'interrupted', reason: { kind: 'server_restart' } } as const;
        case 'system_stop': {
          const detail = (reason as Record<string, unknown>).detail;
          if (typeof detail !== 'string') return null;
          return { kind: 'interrupted', reason: { kind: 'system_stop', detail } } as const;
        }
        default:
          return null;
      }
    }
    if (kind === 'blocked') {
      const reason = runStateRaw.reason;
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
      const reason = runStateRaw.reason;
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
    if (kind === 'terminal') {
      const status = runStateRaw.status;
      if (status !== 'completed' && status !== 'archived') return null;
      return { kind: 'terminal', status };
    }
    return null;
  })();
  if (runState === null) return null;

  return {
    currentCourse,
    lastModified: value.lastModified,
    messageCount: value.messageCount,
    functionCallCount: value.functionCallCount,
    subdialogCount: value.subdialogCount,
    status: value.status,
    generating: value.generating,
    needsDrive: value.needsDrive,
    runState,
    disableDiligencePush: value.disableDiligencePush,
    diligencePushRemainingBudget: value.diligencePushRemainingBudget,
  };
}

function isSubdialogResponseRecord(value: unknown): value is {
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
} {
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

// Remove old type definitions - now using shared/types/storage.ts
import { generateDialogID } from './utils/id';

const TELLASK_SPECIAL_FUNCTION_NAMES = new Set([
  'tellaskBack',
  'tellask',
  'tellaskSessionless',
  'askHuman',
  'freshBootsReasoning',
]);

type ReplayTellaskSpecialCall =
  | Readonly<{
      callName: 'tellaskBack';
      tellaskContent: string;
      callId: string;
    }>
  | Readonly<{
      callName: 'tellask';
      mentionList: string[];
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

function isTellaskSpecialFunctionName(name: string): boolean {
  return TELLASK_SPECIAL_FUNCTION_NAMES.has(name);
}

function readRequiredStringArgument(args: ToolArguments, field: string): string | null {
  const value = args[field];
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readOptionalStringArgument(args: ToolArguments, field: string): string | null {
  const value = args[field];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseReplayTellaskSpecialCall(record: FuncCallRecord): ReplayTellaskSpecialCall | null {
  if (!isTellaskSpecialFunctionName(record.name)) {
    return null;
  }
  const tellaskContent = readRequiredStringArgument(record.arguments, 'tellaskContent');
  if (!tellaskContent) {
    return null;
  }

  switch (record.name) {
    case 'tellaskBack': {
      return {
        callName: 'tellaskBack',
        tellaskContent,
        callId: record.id,
      };
    }
    case 'askHuman': {
      return {
        callName: 'askHuman',
        tellaskContent,
        callId: record.id,
      };
    }
    case 'freshBootsReasoning': {
      return {
        callName: 'freshBootsReasoning',
        tellaskContent,
        callId: record.id,
      };
    }
    case 'tellask': {
      const targetAgentId = readRequiredStringArgument(record.arguments, 'targetAgentId');
      const sessionSlug = readRequiredStringArgument(record.arguments, 'sessionSlug');
      if (!targetAgentId || !sessionSlug) {
        return null;
      }
      return {
        callName: 'tellask',
        mentionList: [`@${targetAgentId}`],
        tellaskContent,
        callId: record.id,
      };
    }
    case 'tellaskSessionless': {
      const targetAgentId = readRequiredStringArgument(record.arguments, 'targetAgentId');
      if (!targetAgentId) {
        return null;
      }
      return {
        callName: 'tellaskSessionless',
        mentionList: [`@${targetAgentId}`],
        tellaskContent,
        callId: record.id,
      };
    }
    default:
      return null;
  }
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
    supdialog: RootDialog,
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
    },
  ): Promise<SubDialog> {
    const generatedId = generateDialogID();
    const nowTs = formatUnifiedTimestamp(new Date());
    // For subdialogs, use the supdialog's root dialog ID as the root
    const subdialogId = new DialogID(generatedId, supdialog.id.rootId);

    // Prepare subdialog store
    const subdialogStore = new DiskFileDialogStore(subdialogId);
    const subdialog = new SubDialog(
      subdialogStore,
      supdialog,
      supdialog.taskDocPath,
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
      },
      options.sessionSlug,
    );

    // Initial subdialog user prompt is now persisted at first drive (driver.ts)

    // Ensure subdialog directory and persist metadata under supdialog/.subdialogs/
    await this.ensureSubdialogDirectory(subdialogId);
    const metadata: SubdialogMetadataFile = {
      id: subdialogId.selfId,
      agentId: targetAgentId,
      taskDocPath: supdialog.taskDocPath,
      createdAt: nowTs,
      supdialogId: supdialog.id.selfId,
      sessionSlug: options.sessionSlug,
      assignmentFromSup: {
        callName: options.callName,
        mentionList,
        tellaskContent,
        originMemberId: options.originMemberId,
        callerDialogId: options.callerDialogId,
        callId: options.callId,
        collectiveTargets: options.collectiveTargets,
      },
    };
    await DialogPersistence.saveSubdialogMetadata(subdialogId, metadata);
    await DialogPersistence.saveDialogMetadata(subdialogId, metadata);

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
        runState: { kind: 'idle_waiting_user' },
        disableDiligencePush: false,
      },
    }));

    // Supdialog clarification context is persisted in subdialog metadata (supdialogCall)

    const parentCourse = await DialogPersistence.getCurrentCourseNumber(supdialog.id);
    const subdialogCreatedEvt: SubdialogEvent = {
      type: 'subdialog_created_evt',
      dialog: {
        selfId: subdialogId.selfId,
        rootId: subdialogId.rootId,
      },
      timestamp: new Date().toISOString(),
      course: parentCourse,
      parentDialog: {
        selfId: supdialog.id.selfId,
        rootId: supdialog.id.rootId,
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
        supdialogId: supdialog.id.selfId,
        agentId: targetAgentId,
        taskDocPath: supdialog.taskDocPath,
        status: 'running',
        currentCourse: 1,
        createdAt: nowTs,
        lastModified: nowTs,
        runState: { kind: 'idle_waiting_user' },
        sessionSlug: options.sessionSlug,
        assignmentFromSup: {
          callName: options.callName,
          mentionList,
          tellaskContent,
          originMemberId: options.originMemberId,
          callerDialogId: options.callerDialogId,
          callId: options.callId,
        },
      },
    };
    // Post subdialog_created_evt to PARENT's PubChan so frontend can receive it
    // The frontend subscribes to the parent's events, not the subdialog's
    postDialogEvent(supdialog, subdialogCreatedEvt);

    return subdialog;
  }

  /**
   * Receive and handle function call results (includes logging)
   */
  public async receiveFuncResult(dialog: Dialog, funcResult: FuncResultMsg): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    // Persist function result record
    const funcResultRecord: FuncResultRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'func_result_record',
      id: funcResult.id,
      name: funcResult.name,
      content: funcResult.content,
      contentItems: funcResult.contentItems,
      genseq: dialog.activeGenSeq,
    };
    await this.appendEvent(course, funcResultRecord);

    // Send event to frontend
    const funcResultEvt: FunctionResultEvent = {
      type: 'func_result_evt',
      id: funcResult.id,
      name: funcResult.name,
      content: funcResult.content,
      contentItems: funcResult.contentItems,
      course,
    };
    postDialogEvent(dialog, funcResultEvt);
  }

  /**
   * Receive and handle tellask call results with callId for inline result display
   *
   * Call Types:
   * - tellask-special function call (inline bubble)
   *   - Result displays INLINE in the same bubble
   *   - Uses callId for correlation between call_start and response
   *   - Uses receiveTeammateCallResult() + callId parameter
   *
   * - Teammate Tellask (subdialog response bubble)
   *   - Result displays in SEPARATE bubble (subdialog response)
   *   - Uses calleeDialogId for correlation
   *   - Uses receiveTeammateResponse() instead
   *
   * @param dialog - The dialog receiving the response
   * @param responderId - ID of the tool/agent that responded (e.g., "add_reminder")
   * @param mentionList - Mention list of the original call
   * @param tellaskContent - Tellask content of the original call
   * @param result - The result content to display
   * @param status - Response status ('completed' | 'failed')
   * @param callId - Correlation ID from call_start_evt (REQUIRED for inline display)
   */
  public async receiveTeammateCallResult(
    dialog: Dialog,
    responderId: string,
    callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'askHuman' | 'freshBootsReasoning',
    mentionList: string[] | undefined,
    tellaskContent: string,
    result: string,
    status: 'completed' | 'failed',
    callId: string,
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const calling_genseq = dialog.activeGenSeqOrUndefined;
    // Persist record WITH callId for replay correlation
    const ev: TeammateCallResultRecord = (() => {
      switch (callName) {
        case 'tellask':
        case 'tellaskSessionless':
          return {
            ts: formatUnifiedTimestamp(new Date()),
            type: 'teammate_call_result_record',
            responderId,
            callName,
            mentionList: mentionList ?? [],
            tellaskContent,
            status,
            result,
            calling_genseq,
            callId,
          };
        case 'tellaskBack':
        case 'askHuman':
        case 'freshBootsReasoning':
          return {
            ts: formatUnifiedTimestamp(new Date()),
            type: 'teammate_call_result_record',
            responderId,
            callName,
            tellaskContent,
            status,
            result,
            calling_genseq,
            callId,
          };
      }
    })();
    await this.appendEvent(course, ev);

    // Emit TeammateCallResponseEvent WITH callId for UI correlation
    const toolResponseEvt: TeammateCallResponseEvent = (() => {
      switch (callName) {
        case 'tellask':
        case 'tellaskSessionless':
          return {
            type: 'teammate_call_response_evt',
            responderId,
            callName,
            mentionList: mentionList ?? [],
            tellaskContent,
            status,
            result,
            course,
            calling_genseq,
            callId,
          };
        case 'tellaskBack':
        case 'askHuman':
        case 'freshBootsReasoning':
          return {
            type: 'teammate_call_response_evt',
            responderId,
            callName,
            tellaskContent,
            status,
            result,
            course,
            calling_genseq,
            callId,
          };
      }
    })();
    postDialogEvent(dialog, toolResponseEvt);
  }

  /**
   * Receive and handle TEAMMATE TELLASK responses (separate bubble for subdialog/supdialog replies)
   *
   * Call Types:
   * - Teammate Tellask response
   *   - Result displays in SEPARATE bubble (subdialog or supdialog response)
   *   - Uses calleeDialogId for correlation (not callId)
   *   - Uses this method (receiveTeammateResponse)
   *
   * @param dialog - The dialog receiving the response
   * @param responderId - ID of the teammate agent (e.g., "coder")
   * @param mentionList - Mention list of the original teammate tellask
   * @param tellaskContent - Tellask content of the original teammate tellask
   * @param status - Response status ('completed' | 'failed')
   * @param calleeDialogId - ID of the callee dialog (subdialog OR supdialog) for navigation links
   */
  public async receiveTeammateResponse(
    dialog: Dialog,
    responderId: string,
    callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning',
    mentionList: string[] | undefined,
    tellaskContent: string,
    status: 'completed' | 'failed',
    calleeDialogId: DialogID | undefined,
    options: {
      response: string;
      agentId: string;
      callId: string;
      originMemberId: string;
      calleeCourse?: number;
      calleeGenseq?: number;
    },
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const calling_genseq = dialog.activeGenSeqOrUndefined;
    const calleeDialogSelfId = calleeDialogId ? calleeDialogId.selfId : undefined;
    const response = options.response;
    const agentId = options.agentId;
    const callId = options.callId;
    const originMemberId = options.originMemberId;
    const calleeCourse = options.calleeCourse;
    const calleeGenseq = options.calleeGenseq;
    const normalizedMentionList = mentionList ?? [];
    const ev: TeammateResponseRecord = (() => {
      switch (callName) {
        case 'tellask':
        case 'tellaskSessionless':
          return {
            ts: formatUnifiedTimestamp(new Date()),
            type: 'teammate_response_record',
            responderId,
            callName,
            calleeDialogId: calleeDialogSelfId,
            calleeCourse,
            calleeGenseq,
            mentionList: normalizedMentionList,
            tellaskContent,
            status,
            calling_genseq,
            response,
            agentId,
            callId,
            originMemberId,
          };
        case 'tellaskBack':
        case 'freshBootsReasoning':
          return {
            ts: formatUnifiedTimestamp(new Date()),
            type: 'teammate_response_record',
            responderId,
            callName,
            calleeDialogId: calleeDialogSelfId,
            calleeCourse,
            calleeGenseq,
            tellaskContent,
            status,
            calling_genseq,
            response,
            agentId,
            callId,
            originMemberId,
          };
      }
    })();
    await this.appendEvent(course, ev);

    const teammateResponseEvt: TeammateResponseEvent = (() => {
      switch (callName) {
        case 'tellask':
        case 'tellaskSessionless':
          return {
            type: 'teammate_response_evt',
            responderId,
            callName,
            calleeDialogId: calleeDialogSelfId,
            calleeCourse,
            calleeGenseq,
            mentionList: normalizedMentionList,
            tellaskContent,
            status,
            course,
            calling_genseq,
            response,
            agentId,
            callId,
            originMemberId,
          };
        case 'tellaskBack':
        case 'freshBootsReasoning':
          return {
            type: 'teammate_response_evt',
            responderId,
            callName,
            calleeDialogId: calleeDialogSelfId,
            calleeCourse,
            calleeGenseq,
            tellaskContent,
            status,
            course,
            calling_genseq,
            response,
            agentId,
            callId,
            originMemberId,
          };
      }
    })();
    postDialogEvent(dialog, teammateResponseEvt);
  }

  /**
   * Ensure subdialog directory exists (delegate to DialogPersistence)
   */
  private async ensureSubdialogDirectory(dialogId: DialogID): Promise<string> {
    return await DialogPersistence.ensureSubdialogDirectory(dialogId);
  }

  /**
   * Append event to course JSONL file (delegate to DialogPersistence)
   */
  private async appendEvent(course: number, event: PersistedDialogRecord): Promise<void> {
    await DialogPersistence.appendEvent(this.dialogId, course, event);
  }

  /**
   * Notify start of LLM generation for frontend bubble management
   * CRITICAL: This must be called BEFORE any substream events (thinking_start, markdown_start, etc.)
   * to ensure proper event ordering on the frontend.
   */
  public async notifyGeneratingStart(dialog: Dialog): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const genseq = dialog.activeGenSeq;
    try {
      const ev: PersistedDialogRecord = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'gen_start_record',
        genseq: genseq,
      };
      await this.appendEvent(course, ev);

      // Emit generating_start_evt event
      // This event MUST be emitted and processed before any substream events
      // to ensure the frontend has created the generation bubble before receiving
      // thinking/markdown/calling events
      const genStartEvt: GeneratingStartEvent = {
        type: 'generating_start_evt',
        course,
        genseq: genseq,
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
      await this.appendEvent(course, ev);

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
      await this.appendEvent(course, sayingMessageEvent);
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
  public async thinkingFinish(dialog: Dialog): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    // Persist thinking content as a message event
    const thinkingContent = this.thinkingContent;
    if (thinkingContent) {
      const thinkingMessageEvent: AgentThoughtRecord = {
        ts: formatUnifiedTimestamp(new Date()),
        type: 'agent_thought_record',
        genseq: dialog.activeGenSeq,
        content: thinkingContent,
      };
      await this.appendEvent(course, thinkingMessageEvent);
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
      tellaskContent: string;
    },
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const evt: TeammateCallStartEvent = (() => {
      switch (payload.callName) {
        case 'tellask':
        case 'tellaskSessionless':
          return {
            type: 'teammate_call_start_evt',
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
            type: 'teammate_call_start_evt',
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
      phase: 'added' | 'done';
      itemId?: string;
      status?: string;
      action?: WebSearchCallAction;
    },
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;

    const record: WebSearchCallRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'web_search_call_record',
      genseq: dialog.activeGenSeq,
      phase: payload.phase,
      itemId: payload.itemId,
      status: payload.status,
      action: payload.action,
    };
    await this.appendEvent(course, record);

    const evt: WebSearchCallEvent = {
      type: 'web_search_call_evt',
      course,
      genseq: dialog.activeGenSeq,
      phase: payload.phase,
      itemId: payload.itemId,
      status: payload.status,
      action: payload.action,
    };
    postDialogEvent(dialog, evt);
  }

  /**
   * Emit stream error for current generation lifecycle (uses active genseq when present)
   */
  public async streamError(dialog: Dialog, error: string): Promise<void> {
    log.error(`Dialog stream error '${error}'`, new Error(), { dialog });

    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;
    const genseq = typeof dialog.activeGenSeq === 'number' ? dialog.activeGenSeq : undefined;

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
    userLanguageCode?: LanguageCode,
    q4hAnswerCallIds?: string[],
  ): Promise<void> {
    const course = dialog.currentCourse;
    // Use activeGenSeqOrUndefined to handle case when genseq hasn't been initialized yet
    const genseq = dialog.activeGenSeqOrUndefined ?? 1;
    const normalizedQ4HAnswerCallIds = (() => {
      if (!q4hAnswerCallIds || q4hAnswerCallIds.length === 0) {
        return undefined;
      }
      const seen = new Set<string>();
      const normalized: string[] = [];
      for (const raw of q4hAnswerCallIds) {
        const callId = raw.trim();
        if (callId === '' || seen.has(callId)) continue;
        seen.add(callId);
        normalized.push(callId);
      }
      return normalized.length > 0 ? normalized : undefined;
    })();

    const humanEv: HumanTextRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'human_text_record',
      genseq: genseq,
      content: String(content || ''),
      msgId: msgId,
      grammar,
      userLanguageCode,
      q4hAnswerCallIds: normalizedQ4HAnswerCallIds,
    };
    await this.appendEvent(course, humanEv);

    // Note: end_of_user_saying_evt is now emitted by llm/driver.ts after tellask calls complete
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
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;

    const event: AgentThoughtRecord | AgentWordsRecord =
      type === 'thinking_msg'
        ? {
            ts: formatUnifiedTimestamp(new Date()),
            type: 'agent_thought_record',
            genseq,
            content: content || '',
            provider_data,
          }
        : {
            ts: formatUnifiedTimestamp(new Date()),
            type: 'agent_words_record',
            genseq,
            content: content || '',
          };

    await this.appendEvent(course, event);
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
    await this.appendEvent(course, ev);
  }

  /**
   * Persist a function call to storage
   */
  public async persistFunctionCall(
    dialog: Dialog,
    id: string,
    name: string,
    arguments_: ToolArguments,
    genseq: number,
  ): Promise<void> {
    const course = dialog.activeGenCourseOrUndefined ?? dialog.currentCourse;

    const funcCallEvent: FuncCallRecord = {
      ts: formatUnifiedTimestamp(new Date()),
      type: 'func_call_record',
      genseq,
      id,
      name,
      arguments: arguments_,
    };

    await this.appendEvent(course, funcCallEvent);

    // NOTE: func_call_evt REMOVED - persistence uses FuncCallRecord directly
    // UI display uses func_call_requested_evt instead
  }

  /**
   * Update questions for human state (exceptional overwrite pattern)
   */
  public async updateQuestions4Human(dialog: Dialog, questions: HumanQuestion[]): Promise<void> {
    await DialogPersistence._saveQuestions4HumanState(this.dialogId, questions);
  }

  /**
   * Load Questions for Human state from storage
   */
  public async loadQuestions4Human(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived',
  ): Promise<HumanQuestion[]> {
    return await DialogPersistence.loadQuestions4HumanState(dialogId, status);
  }

  public async loadDialogMetadata(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived',
  ): Promise<DialogMetadataFile | null> {
    return await DialogPersistence.loadDialogMetadata(dialogId, status);
  }

  public async loadPendingSubdialogs(
    rootDialogId: DialogID,
    status: 'running' | 'completed' | 'archived',
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
    rootDialogId: DialogID,
    entries: Array<{
      key: string;
      subdialogId: DialogID;
      agentId: string;
      sessionSlug?: string;
    }>,
    status: 'running' | 'completed' | 'archived',
  ): Promise<void> {
    await DialogPersistence.saveSubdialogRegistry(rootDialogId, entries, status);
  }

  public async loadSubdialogRegistry(
    rootDialog: RootDialog,
    status: 'running' | 'completed' | 'archived',
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
        const runState = latest?.runState;
        if (runState && runState.kind === 'dead') {
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
    status: 'running' | 'completed' | 'archived' = 'running',
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
        await this.sendEventDirectlyToWebSocket(ws, dialog, currentCourse, event, status);
      }

      // Rehydrate reminders from dialog state
      const dialogState = await DialogPersistence.restoreDialog(dialog.id, status);
      const rehydrated: Reminder[] = (dialogState?.reminders ?? []).map((r) => {
        return { content: r.content, owner: r.owner, meta: r.meta };
      });
      dialog.reminders.length = 0;
      dialog.reminders.push(...rehydrated);
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
    status: 'running' | 'completed' | 'archived',
  ): Promise<void> {
    switch (event.type) {
      case 'human_text_record': {
        const genseq = event.genseq;
        const content = event.content || '';
        const grammar: 'markdown' = 'markdown';
        const userLanguageCode = event.userLanguageCode;

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
              userLanguageCode,
              q4hAnswerCallIds: event.q4hAnswerCallIds,
              dialog: { selfId: dialog.id.selfId, rootId: dialog.id.rootId },
              timestamp: event.ts,
            }),
          );
        }
        break;
      }

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

      case 'ui_only_markdown_record': {
        const content = event.content || '';
        if (!content.trim()) break;

        const dialogIdent = { selfId: dialog.id.selfId, rootId: dialog.id.rootId };
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
        break;
      }

      case 'func_call_record': {
        const specialCall = parseReplayTellaskSpecialCall(event);
        if (specialCall) {
          const dialogIdent = {
            selfId: dialog.id.selfId,
            rootId: dialog.id.rootId,
          };
          const callStartEvent = (() => {
            switch (specialCall.callName) {
              case 'tellask':
              case 'tellaskSessionless':
                return {
                  type: 'teammate_call_start_evt',
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
                  type: 'teammate_call_start_evt',
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

        // Handle normal function call events from persistence.
        const funcCall = {
          type: 'func_call_requested_evt',
          funcId: event.id,
          funcName: event.name,
          arguments: JSON.stringify(event.arguments),
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

      case 'web_search_call_record': {
        const webSearchCall = {
          type: 'web_search_call_evt',
          phase: event.phase,
          itemId: event.itemId,
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

      case 'func_result_record': {
        // Handle function result events from persistence
        const funcResult = {
          type: 'func_result_evt',
          id: event.id,
          name: event.name,
          content: event.content,
          contentItems: event.contentItems,
          course,
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
            runState: subLatest?.runState,
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

      case 'teammate_call_result_record': {
        // Handle teammate-call inline results
        const responseEvent = (() => {
          switch (event.callName) {
            case 'tellask':
            case 'tellaskSessionless':
              return {
                type: 'teammate_call_response_evt',
                responderId: event.responderId,
                callName: event.callName,
                mentionList: event.mentionList,
                tellaskContent: event.tellaskContent,
                status: event.status,
                result: event.result,
                callId: event.callId || '',
                course,
                calling_genseq: event.calling_genseq,
                dialog: {
                  selfId: dialog.id.selfId,
                  rootId: dialog.id.rootId,
                },
                timestamp: event.ts,
              };
            case 'tellaskBack':
            case 'askHuman':
            case 'freshBootsReasoning':
              return {
                type: 'teammate_call_response_evt',
                responderId: event.responderId,
                callName: event.callName,
                tellaskContent: event.tellaskContent,
                status: event.status,
                result: event.result,
                callId: event.callId || '',
                course,
                calling_genseq: event.calling_genseq,
                dialog: {
                  selfId: dialog.id.selfId,
                  rootId: dialog.id.rootId,
                },
                timestamp: event.ts,
              };
          }
        })();

        if (ws.readyState === 1) {
          ws.send(JSON.stringify(responseEvent));
        }
        break;
      }

      case 'teammate_call_anchor_record': {
        const anchorEvent = {
          type: 'teammate_call_anchor_evt',
          course,
          genseq: event.genseq,
          anchorRole: event.anchorRole ?? 'response',
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

      case 'teammate_response_record': {
        // Handle teammate response events (separate bubble for @teammate tellasks)
        const mentionList = (() => {
          switch (event.callName) {
            case 'tellask':
            case 'tellaskSessionless':
              return event.mentionList;
            case 'tellaskBack':
            case 'freshBootsReasoning':
              return undefined;
          }
        })();
        const teammateResponseEvent = (() => {
          switch (event.callName) {
            case 'tellask':
            case 'tellaskSessionless':
              return {
                type: 'teammate_response_evt',
                responderId: event.responderId,
                callName: event.callName,
                calleeDialogId: event.calleeDialogId,
                calleeCourse: event.calleeCourse,
                calleeGenseq: event.calleeGenseq,
                mentionList,
                tellaskContent: event.tellaskContent,
                status: event.status,
                response: event.response,
                agentId: event.agentId,
                callId: event.callId,
                originMemberId: event.originMemberId,
                course,
                calling_genseq: event.calling_genseq,
                dialog: {
                  selfId: dialog.id.selfId,
                  rootId: dialog.id.rootId,
                },
                timestamp: event.ts,
              };
            case 'tellaskBack':
            case 'freshBootsReasoning':
              return {
                type: 'teammate_response_evt',
                responderId: event.responderId,
                callName: event.callName,
                calleeDialogId: event.calleeDialogId,
                calleeCourse: event.calleeCourse,
                calleeGenseq: event.calleeGenseq,
                tellaskContent: event.tellaskContent,
                status: event.status,
                response: event.response,
                agentId: event.agentId,
                callId: event.callId,
                originMemberId: event.originMemberId,
                course,
                calling_genseq: event.calling_genseq,
                dialog: {
                  selfId: dialog.id.selfId,
                  rootId: dialog.id.rootId,
                },
                timestamp: event.ts,
              };
          }
        })();

        if (ws.readyState === 1) {
          ws.send(JSON.stringify(teammateResponseEvent));
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
      status: 'running' | 'completed' | 'archived';
      latest: DialogLatestFile;
      timer: NodeJS.Timeout;
    }
  | {
      kind: 'flushing';
      dialogId: DialogID;
      status: 'running' | 'completed' | 'archived';
      latest: DialogLatestFile;
      dirty: boolean;
      inFlight: Promise<void>;
    };

type Q4HWriteBackState = { kind: 'file'; file: Questions4HumanFile } | { kind: 'deleted' };

type Q4HWriteBackEntry =
  | {
      kind: 'scheduled';
      dialogId: DialogID;
      status: 'running' | 'completed' | 'archived';
      state: Q4HWriteBackState;
      timer: NodeJS.Timeout;
    }
  | {
      kind: 'flushing';
      dialogId: DialogID;
      status: 'running' | 'completed' | 'archived';
      state: Q4HWriteBackState;
      dirty: boolean;
      inFlight: Promise<void>;
    };

type PendingSubdialogsWriteBackState =
  | { kind: 'file'; records: PendingSubdialogRecord[] }
  | { kind: 'deleted' };

type PendingSubdialogsWriteBackEntry =
  | {
      kind: 'scheduled';
      dialogId: DialogID;
      status: 'running' | 'completed' | 'archived';
      state: PendingSubdialogsWriteBackState;
      timer: NodeJS.Timeout;
    }
  | {
      kind: 'flushing';
      dialogId: DialogID;
      status: 'running' | 'completed' | 'archived';
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

type PendingSubdialogRecord = {
  subdialogId: string;
  createdAt: string;
  callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  mentionList?: string[];
  tellaskContent: string;
  targetAgentId: string;
  callId: string;
  callingCourse?: number;
  callType: 'A' | 'B' | 'C';
  sessionSlug?: string;
};

type PendingSubdialogsMutation =
  | { kind: 'noop' }
  | { kind: 'append'; record: PendingSubdialogRecord }
  | { kind: 'removeBySubdialogId'; subdialogId: string }
  | { kind: 'removeBySubdialogIds'; subdialogIds: string[] }
  | { kind: 'replace'; records: PendingSubdialogRecord[] }
  | { kind: 'clear' };

type PendingSubdialogsMutateOutcome = {
  previousRecords: PendingSubdialogRecord[];
  records: PendingSubdialogRecord[];
  removedRecords: PendingSubdialogRecord[];
};

type DialogLatestPatch = Partial<Omit<DialogLatestFile, 'currentCourse' | 'lastModified'>> & {
  currentCourse?: number;
  lastModified?: string;
};

type DialogLatestMutation =
  | { kind: 'noop' }
  | { kind: 'patch'; patch: DialogLatestPatch }
  | { kind: 'replace'; next: DialogLatestFile };

/**
 * Utility class for managing dialog persistence
 */
export class DialogPersistence {
  private static readonly DIALOGS_DIR = '.dialogs';
  private static readonly RUN_DIR = 'run';
  private static readonly DONE_DIR = 'done';
  private static readonly ARCHIVE_DIR = 'archive';
  private static readonly SUBDIALOGS_DIR = 'subdialogs';

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

  private static getPendingSubdialogsWriteBackMutex(key: string): AsyncFifoMutex {
    const existing = this.pendingSubdialogsWriteBackMutexes.get(key);
    if (existing) return existing;
    const created = new AsyncFifoMutex();
    this.pendingSubdialogsWriteBackMutexes.set(key, created);
    return created;
  }

  private static getLatestWriteBackKey(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived',
  ): string {
    // Include dialogs root dir to avoid cross-test/process.cwd collisions.
    return `${this.getDialogsRootDir()}|${status}|${dialogId.valueOf()}`;
  }

  private static getQ4HWriteBackKey(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived',
  ): string {
    // Include dialogs root dir to avoid cross-test/process.cwd collisions.
    return `${this.getDialogsRootDir()}|${status}|${dialogId.valueOf()}|q4h`;
  }

  private static getPendingSubdialogsWriteBackKey(
    rootDialogId: DialogID,
    status: 'running' | 'completed' | 'archived',
  ): string {
    return `${this.getDialogsRootDir()}|${status}|${rootDialogId.valueOf()}|pending-subdialogs`;
  }

  /**
   * Get the base dialogs directory path
   */
  static getDialogsRootDir(): string {
    return path.join(process.cwd(), this.DIALOGS_DIR);
  }

  /**
   * Save dialog state to JSON file for persistence (internal use only)
   */
  private static async saveDialogState(state: DialogPersistenceState): Promise<void> {
    try {
      const dialogPath = await this.ensureRootDialogDirectory(new DialogID(state.metadata.id));

      // Save state as JSON file
      const stateFile = path.join(dialogPath, 'state.json');
      await fs.promises.writeFile(
        stateFile,
        JSON.stringify(
          {
            metadata: state.metadata,
            currentCourse: state.currentCourse,
            messages: state.messages,
            reminders: state.reminders,
            savedAt: formatUnifiedTimestamp(new Date()),
          },
          null,
          2,
        ),
        'utf-8',
      );
    } catch (error) {
      log.error(`Failed to save dialog state for ${state.metadata.id}:`, error);
      throw error;
    }
  }

  /**
   * Load dialog state from JSON file
   */
  static async loadDialogState(dialogId: DialogID): Promise<DialogPersistenceState | null> {
    try {
      const dialogPath = this.getRootDialogPath(dialogId, 'running');
      const stateFile = path.join(dialogPath, 'state.json');

      // Check if state file exists
      try {
        await fs.promises.access(stateFile);
      } catch {
        log.warn(`No state file found for dialog ${dialogId.selfId}, returning null`);
        return null;
      }

      const stateData = JSON.parse(await fs.promises.readFile(stateFile, 'utf-8'));

      const currentCourse =
        typeof (stateData as { currentCourse?: unknown }).currentCourse === 'number'
          ? (stateData as { currentCourse: number }).currentCourse
          : 1;

      return {
        metadata: stateData.metadata,
        currentCourse,
        messages: stateData.messages,
        reminders: stateData.reminders || [],
      };
    } catch (error) {
      log.error(`Failed to load dialog state for root ${dialogId.selfId}:`, error);
      return null;
    }
  }

  /**
   * Get the full path for a dialog directory
   */
  static getRootDialogPath(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): string {
    if (dialogId.rootId !== dialogId.selfId) {
      throw new Error('Expected root dialog id');
    }
    let statusDir: string;
    if (status === 'running') {
      statusDir = this.RUN_DIR;
    } else if (status === 'completed') {
      statusDir = this.DONE_DIR;
    } else {
      statusDir = this.ARCHIVE_DIR;
    }
    return path.join(this.getDialogsRootDir(), statusDir, dialogId.selfId);
  }

  /**
   * Get the events/state directory for a dialog (composite ID for subdialogs)
   */
  static getDialogEventsPath(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): string {
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
  static getSubdialogPath(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): string {
    if (dialogId.rootId === dialogId.selfId) {
      throw new Error('Expected subdialog id (self differs from root)');
    }
    const rootPath = this.getRootDialogPath(new DialogID(dialogId.rootId), status);
    return path.join(rootPath, this.SUBDIALOGS_DIR, dialogId.selfId);
  }

  /**
   * Ensure dialog directory structure exists
   */
  static async ensureRootDialogDirectory(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
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
    status: 'running' | 'completed' | 'archived' = 'running',
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
   * List all dialog IDs by scanning for dialog.yaml files and validating their IDs
   */
  static async listDialogs(
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<string[]> {
    try {
      const statusDir = this.getDialogsRootDir();
      const specificDir = path.join(
        statusDir,
        status === 'running'
          ? this.RUN_DIR
          : status === 'completed'
            ? this.DONE_DIR
            : this.ARCHIVE_DIR,
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
              // Found a dialog.yaml file, record its ID regardless of nesting structure
              try {
                const content = await fs.promises.readFile(fullPath, 'utf-8');
                const parsed = yaml.parse(content);
                if (parsed?.id && typeof parsed.id === 'string') {
                  validDialogIds.push(parsed.id);
                }
              } catch (yamlError) {
                log.warn(`🔍 listDialogs: Failed to parse dialog.yaml at ${fullPath}:`, yamlError);
              }
            }
          }
        } catch (error) {
          log.warn(`🔍 listDialogs: Error reading directory ${dirPath}:`, error);
        }
      };

      try {
        // Check if directory exists before trying to read it
        const dirExists = await fs.promises
          .stat(specificDir)
          .then(() => true)
          .catch(() => false);
        if (dirExists) {
          await findDialogYamls(specificDir);
        }
        return validDialogIds;
      } catch (error) {
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
   */
  static async listAllDialogIds(
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<DialogID[]> {
    const statusDir = this.getDialogsRootDir();
    const specificDir = path.join(
      statusDir,
      status === 'running'
        ? this.RUN_DIR
        : status === 'completed'
          ? this.DONE_DIR
          : this.ARCHIVE_DIR,
    );

    const result: DialogID[] = [];
    const rootDialogIdByDialogYamlPath = new Map<string, string | null>();

    const readDialogYamlId = async (dialogYamlPath: string): Promise<string | null> => {
      const cached = rootDialogIdByDialogYamlPath.get(dialogYamlPath);
      if (cached !== undefined) return cached;
      try {
        const content = await fs.promises.readFile(dialogYamlPath, 'utf-8');
        const parsed: unknown = yaml.parse(content);
        if (typeof parsed !== 'object' || parsed === null) {
          rootDialogIdByDialogYamlPath.set(dialogYamlPath, null);
          return null;
        }
        const idValue = (parsed as { id?: unknown }).id;
        if (typeof idValue !== 'string' || idValue.trim() === '') {
          rootDialogIdByDialogYamlPath.set(dialogYamlPath, null);
          return null;
        }
        const normalized = idValue.trim();
        rootDialogIdByDialogYamlPath.set(dialogYamlPath, normalized);
        return normalized;
      } catch {
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
          const content = await fs.promises.readFile(fullPath, 'utf-8');
          const parsed: unknown = yaml.parse(content);
          if (typeof parsed !== 'object' || parsed === null) continue;
          const idValue = (parsed as { id?: unknown }).id;
          if (typeof idValue !== 'string' || idValue.trim() === '') continue;
          result.push(new DialogID(idValue, rootId));
        } catch (yamlError) {
          log.warn(`🔍 listAllDialogIds: Failed to parse dialog.yaml at ${fullPath}:`, yamlError);
        }
      }
    };

    const dirExists = await fs.promises
      .stat(specificDir)
      .then(() => true)
      .catch(() => false);
    if (!dirExists) return [];

    await findDialogYamls(specificDir);
    return result;
  }

  // === NEW JSONL COURSE-BASED METHODS ===

  /**
   * Append event to course JSONL file (append-only pattern)
   */
  static async appendEvent(
    dialogId: DialogID,
    course: number,
    event: PersistedDialogRecord,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    const appendMutexKey = `${this.getDialogsRootDir()}|${status}|${dialogId.valueOf()}|course:${course}`;
    const release = await this.getCourseAppendMutex(appendMutexKey).acquire();
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const courseFilename = this.getCourseFilename(course);
      const courseFilePath = path.join(dialogPath, courseFilename);

      // Ensure directory exists
      await fs.promises.mkdir(dialogPath, { recursive: true });

      // Serialize appends per dialog+course file. Concurrent `appendFile` calls can interleave and
      // corrupt JSONL lines (e.g. tool results appended in parallel), which later manifests as
      // `Unterminated string in JSON ...` during resume.
      const eventLine = JSON.stringify(event) + '\n';
      await fs.promises.appendFile(courseFilePath, eventLine, 'utf-8');

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
      );
    } catch (error) {
      log.error(`Failed to append event to dialog ${dialogId} course ${course}:`, error);
      throw error;
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
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<PersistedDialogRecord[]> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const courseFilePath = path.join(dialogPath, this.getCourseFilename(course));

      try {
        const content = await fs.promises.readFile(courseFilePath, 'utf-8');
        const events: PersistedDialogRecord[] = [];

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.trim()) continue;
          try {
            events.push(JSON.parse(line));
          } catch (err) {
            const isLastNonEmptyLine = (() => {
              for (let j = lines.length - 1; j > i; j--) {
                if (lines[j].trim().length > 0) return false;
              }
              return true;
            })();
            const msg = err instanceof Error ? err.message : String(err);
            // If the last JSONL line was truncated (e.g. process crash mid-append), ignore it so
            // dialogs remain resumable. Do not mask corruption in the middle of the file.
            if (
              isLastNonEmptyLine &&
              (msg.includes('Unterminated string in JSON') ||
                msg.includes('Unexpected end of JSON input'))
            ) {
              log.warn(
                `Ignoring truncated JSONL tail for dialog ${dialogId} course ${course} at line ${i + 1}: ${msg}`,
              );
              break;
            }
            throw err;
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
    status: 'running' | 'completed' | 'archived' = 'running',
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
    status: 'running' | 'completed' | 'archived' = 'running',
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
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      await fs.promises.mkdir(dialogPath, { recursive: true });
      const remindersFilePath = path.join(dialogPath, 'reminders.json');

      const reminderState: ReminderStateFile = {
        reminders: reminders.map((r, index) => ({
          id: `reminder-${index}`,
          content: r.content,
          ownerName: r.owner ? r.owner.name : undefined,
          meta: r.meta,
          createdAt: formatUnifiedTimestamp(new Date()),
          priority: 'medium',
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
      await this.renameWithRetry(tempFile, remindersFilePath, jsonContent);
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
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<Reminder[]> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const remindersFilePath = path.join(dialogPath, 'reminders.json');

      try {
        const content = await fs.promises.readFile(remindersFilePath, 'utf-8');
        const reminderState: ReminderStateFile = JSON.parse(content);
        return reminderState.reminders.map((r) => {
          const ownerNameFromFile = typeof r.ownerName === 'string' ? r.ownerName : undefined;
          const owner = ownerNameFromFile ? getReminderOwner(ownerNameFromFile) : undefined;

          return {
            id: r.id,
            content: r.content,
            owner,
            meta: r.meta,
            createdAt: r.createdAt,
            priority: r.priority,
          };
        });
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          // reminders.json doesn't exist - return empty array
          return [];
        }
        throw error;
      }
    } catch (error) {
      log.error(`Failed to load reminder state for dialog ${dialogId}:`, error);
      return [];
    }
  }

  /**
   * Save questions for human state (exceptional overwrite pattern) (internal use only)
   */
  public static async _saveQuestions4HumanState(
    dialogId: DialogID,
    questions: HumanQuestion[],
    status: 'running' | 'completed' | 'archived' = 'running',
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
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<HumanQuestion[]> {
    const key = this.getQ4HWriteBackKey(dialogId, status);
    const staged = this.q4hWriteBack.get(key);
    if (staged) {
      if (staged.state.kind === 'deleted') return [];
      return staged.state.file.questions;
    }

    try {
      return await this.loadQuestions4HumanStateFromDisk(dialogId, status);
    } catch (error) {
      log.error(`Failed to load q4h.yaml for dialog ${dialogId}:`, error);
      return [];
    }
  }

  private static async loadQuestions4HumanStateFromDisk(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived',
  ): Promise<HumanQuestion[]> {
    const dialogPath = this.getDialogEventsPath(dialogId, status);
    const questionsFilePath = path.join(dialogPath, 'q4h.yaml');

    try {
      const content = await fs.promises.readFile(questionsFilePath, 'utf-8');
      try {
        const parsed = yaml.parse(content) as unknown;
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'questions' in parsed &&
          Array.isArray((parsed as { questions?: unknown }).questions)
        ) {
          return (parsed as Questions4HumanFile).questions;
        }
        log.warn(`q4h.yaml has unexpected shape for dialog ${dialogId}`, undefined, {
          filePath: questionsFilePath,
        });
        return [];
      } catch (parseError: unknown) {
        // Attempt to auto-repair the common corruption pattern where extra trailing lines are appended
        // due to concurrent writers clobbering a shared temp file.
        const lines = content.split(/\r?\n/);
        let repairedQuestions: HumanQuestion[] | null = null;

        for (let cut = lines.length - 1; cut > 0 && lines.length - cut <= 12; cut--) {
          const candidate = lines.slice(0, cut).join('\n');
          if (candidate.trim() === '') continue;
          try {
            const candidateState = yaml.parse(candidate) as unknown;
            if (
              typeof candidateState === 'object' &&
              candidateState !== null &&
              'questions' in candidateState &&
              Array.isArray((candidateState as { questions?: unknown }).questions)
            ) {
              repairedQuestions = (candidateState as Questions4HumanFile).questions;
              break;
            }
          } catch {
            // keep trimming
          }
        }

        if (repairedQuestions) {
          log.warn(`Repaired corrupted q4h.yaml for dialog ${dialogId}`, undefined, {
            filePath: questionsFilePath,
          });
          const repairedFile: Questions4HumanFile = {
            questions: repairedQuestions,
            updatedAt: formatUnifiedTimestamp(new Date()),
          };
          try {
            await this.writeQ4HStateToDisk(dialogId, { kind: 'file', file: repairedFile }, status);
          } catch (repairSaveError: unknown) {
            log.warn(`Failed to persist repaired q4h.yaml for dialog ${dialogId}`, repairSaveError);
          }
          return repairedQuestions;
        }

        // Quarantine the bad file to avoid repeated parse errors, then treat as "no questions".
        try {
          const quarantinePath = `${questionsFilePath}.corrupt-${randomUUID()}`;
          await fs.promises.rename(questionsFilePath, quarantinePath);
          log.warn(`Quarantined corrupted q4h.yaml for dialog ${dialogId}`, undefined, {
            filePath: questionsFilePath,
            quarantinePath,
          });
        } catch (quarantineError: unknown) {
          log.warn(
            `Failed to quarantine corrupted q4h.yaml for dialog ${dialogId}`,
            quarantineError,
          );
        }
        log.warn(`Failed to parse q4h.yaml for dialog ${dialogId}`, parseError);
        return [];
      }
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  static async mutateQuestions4HumanState(
    dialogId: DialogID,
    mutator: (previous: HumanQuestion[]) => Q4HMutation,
    status: 'running' | 'completed' | 'archived' = 'running',
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
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    const questionId = question.id;
    const normalizedCallId =
      typeof question.callId === 'string' && question.callId.trim() !== ''
        ? question.callId.trim()
        : null;

    await this.mutateQuestions4HumanState(
      dialogId,
      (previousQuestions) => {
        const byId = previousQuestions.find((q) => q.id === questionId);
        if (byId) {
          throw new Error(
            `Q4H duplicate question id violation: dialog=${dialogId.valueOf()} status=${status} questionId=${questionId} existingAskedAt=${byId.askedAt} incomingAskedAt=${question.askedAt}`,
          );
        }

        if (normalizedCallId) {
          const byCallId = previousQuestions.find((q) => {
            return typeof q.callId === 'string' && q.callId.trim() === normalizedCallId;
          });
          if (byCallId) {
            throw new Error(
              `Q4H duplicate call id violation: dialog=${dialogId.valueOf()} status=${status} callId=${normalizedCallId} existingQuestionId=${byCallId.id} incomingQuestionId=${questionId} existingAskedAt=${byCallId.askedAt} incomingAskedAt=${question.askedAt}`,
            );
          }
        }

        if (previousQuestions.length > 0) {
          const existingIds = previousQuestions.map((q) => q.id).join(',');
          const existingCallIds = previousQuestions
            .map((q) => (typeof q.callId === 'string' ? q.callId.trim() : ''))
            .filter((value) => value !== '')
            .join(',');
          throw new Error(
            `Q4H multi-pending violation: dialog=${dialogId.valueOf()} status=${status} existingCount=${previousQuestions.length} existingQuestionIds=${existingIds} existingCallIds=${existingCallIds} incomingQuestionId=${questionId} incomingCallId=${normalizedCallId ?? ''}`,
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
    status: 'running' | 'completed' | 'archived' = 'running',
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
          status: 'running' | 'completed' | 'archived';
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

        const inFlight = this.writeQ4HStateToDisk(entry.dialogId, entry.state, entry.status);
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
    status: 'running' | 'completed' | 'archived',
  ): Promise<void> {
    const dialogPath = this.getDialogEventsPath(dialogId, status);
    const questionsFilePath = path.join(dialogPath, 'q4h.yaml');

    await fs.promises.mkdir(dialogPath, { recursive: true });

    if (state.kind === 'deleted') {
      await fs.promises.rm(questionsFilePath, { force: true });
      return;
    }

    const yamlContent = yaml.stringify(state.file);
    const tempFile = path.join(
      dialogPath,
      `.${path.basename(questionsFilePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await fs.promises.writeFile(tempFile, yamlContent, 'utf-8');
    await this.renameWithRetry(tempFile, questionsFilePath, yamlContent);
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
      callId?: string;
      remainingCallIds?: string[];
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
        callId?: string;
        remainingCallIds?: string[];
        callSiteRef: { course: number; messageIndex: number };
      }> = [];

      for (const dialogIdObj of dialogIds) {
        try {
          const questions = await this.loadQuestions4HumanState(dialogIdObj, 'running');
          const metadata = await this.loadDialogMetadata(dialogIdObj, 'running');

          if (metadata && questions.length > 0) {
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
    status: 'running' | 'completed' | 'archived' = 'running',
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
    pendingSubdialogs: PendingSubdialogRecord[],
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    const next = pendingSubdialogs.map((r) => ({ ...r }));
    await this.mutatePendingSubdialogs(
      rootDialogId,
      () => ({ kind: 'replace', records: next }),
      status,
    );
  }

  /**
   * Load pending subdialogs for Type A supply mechanism.
   */
  static async loadPendingSubdialogs(
    rootDialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<PendingSubdialogRecord[]> {
    const key = this.getPendingSubdialogsWriteBackKey(rootDialogId, status);
    const staged = this.pendingSubdialogsWriteBack.get(key);
    if (staged) {
      return staged.state.kind === 'deleted' ? [] : staged.state.records;
    }

    try {
      return await this.loadPendingSubdialogsFromDisk(rootDialogId, status);
    } catch (error) {
      log.error(`Failed to load pending subdialogs for dialog ${rootDialogId}:`, error);
      return [];
    }
  }

  private static isPendingSubdialogRecord(value: unknown): value is PendingSubdialogRecord {
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
    status: 'running' | 'completed' | 'archived',
  ): Promise<PendingSubdialogRecord[]> {
    const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
    const filePath = path.join(dialogPath, 'pending-subdialogs.json');
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(this.isPendingSubdialogRecord);
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  static async mutatePendingSubdialogs(
    rootDialogId: DialogID,
    mutator: (previous: PendingSubdialogRecord[]) => PendingSubdialogsMutation,
    status: 'running' | 'completed' | 'archived' = 'running',
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
      let nextRecords: PendingSubdialogRecord[] = previousRecords;
      const removedRecords: PendingSubdialogRecord[] = [];

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

      return { previousRecords, records: nextRecords, removedRecords };
    } finally {
      release();
    }
  }

  static async appendPendingSubdialog(
    rootDialogId: DialogID,
    record: PendingSubdialogRecord,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    await this.mutatePendingSubdialogs(rootDialogId, () => ({ kind: 'append', record }), status);
  }

  static async removePendingSubdialog(
    rootDialogId: DialogID,
    subdialogId: string,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    await this.mutatePendingSubdialogs(
      rootDialogId,
      () => ({ kind: 'removeBySubdialogId', subdialogId }),
      status,
    );
  }

  static async clearPendingSubdialogs(
    rootDialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    await this.mutatePendingSubdialogs(rootDialogId, () => ({ kind: 'clear' }), status);
  }

  private static async flushPendingSubdialogsWriteBack(key: string): Promise<void> {
    const mutex = this.getPendingSubdialogsWriteBackMutex(key);

    let captured:
      | {
          dialogId: DialogID;
          status: 'running' | 'completed' | 'archived';
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

        const inFlight = this.writePendingSubdialogsToDisk(
          entry.dialogId,
          entry.state,
          entry.status,
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
    } catch {
      const release = await mutex.acquire();
      try {
        const entry = this.pendingSubdialogsWriteBack.get(key);
        if (!entry) return;
        if (entry.kind !== 'flushing') return;
        if (entry.inFlight !== captured.inFlight) return;

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
    status: 'running' | 'completed' | 'archived',
  ): Promise<void> {
    const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
    await fs.promises.mkdir(dialogPath, { recursive: true });
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
    await fs.promises.writeFile(tempFile, jsonContent, 'utf-8');
    await this.renameWithRetry(tempFile, filePath, jsonContent);
  }

  /**
   * Get the path for storing subdialog responses (supports both root and subdialog parents).
   * For Type C subdialogs created inside another subdialog, responses are stored at the parent's level.
   */
  static getDialogResponsesPath(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): string {
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
    responses: Array<{
      responseId: string;
      subdialogId: string;
      response: string;
      completedAt: string;
      callType: 'A' | 'B' | 'C';
      callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
      mentionList?: string[];
      tellaskContent: string;
      responderId: string;
      originMemberId: string;
      callId: string;
    }>,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
      await fs.promises.mkdir(dialogPath, { recursive: true });
      const filePath = path.join(dialogPath, 'subdialog-responses.json');

      // Atomic write operation
      const jsonContent = JSON.stringify(responses, null, 2);
      const tempFile = path.join(
        dialogPath,
        `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      await fs.promises.writeFile(tempFile, jsonContent, 'utf-8');
      await this.renameWithRetry(tempFile, filePath, jsonContent);
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
    status: 'running' | 'completed' | 'archived' = 'running',
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
      const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
      const filePath = path.join(dialogPath, 'subdialog-responses.json');
      const inflightPath = path.join(dialogPath, 'subdialog-responses.processing.json');

      try {
        const results: Array<{
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
        }> = [];

        const tryReadArray = async (p: string): Promise<unknown[]> => {
          try {
            const content = await fs.promises.readFile(p, 'utf-8');
            const parsed: unknown = JSON.parse(content);
            return Array.isArray(parsed) ? parsed : [];
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
          if (isSubdialogResponseRecord(item)) {
            results.push(item);
          }
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
    } catch (error) {
      log.error(`Failed to load subdialog responses for dialog ${rootDialogId}:`, error);
      return [];
    }
  }

  static async loadSubdialogResponsesQueue(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
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
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(isSubdialogResponseRecord);
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  static async appendSubdialogResponse(
    dialogId: DialogID,
    response: {
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
    },
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    const existing = await this.loadSubdialogResponsesQueue(dialogId, status);
    existing.push(response);
    await this.saveSubdialogResponses(dialogId, existing, status);
  }

  static async takeSubdialogResponses(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
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
    const dialogPath = this.getDialogResponsesPath(dialogId, status);
    await fs.promises.mkdir(dialogPath, { recursive: true });

    const filePath = path.join(dialogPath, 'subdialog-responses.json');
    const inflightPath = path.join(dialogPath, 'subdialog-responses.processing.json');

    // If a previous processing file exists, merge it back so it will be re-processed.
    try {
      await fs.promises.access(inflightPath);
      await this.rollbackTakenSubdialogResponses(dialogId, status);
    } catch {
      // no-op
    }

    try {
      await fs.promises.rename(filePath, inflightPath);
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return [];
      }
      throw error;
    }

    try {
      const raw = await fs.promises.readFile(inflightPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(isSubdialogResponseRecord);
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  static async commitTakenSubdialogResponses(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    const dialogPath = this.getDialogResponsesPath(dialogId, status);
    const inflightPath = path.join(dialogPath, 'subdialog-responses.processing.json');
    await fs.promises.rm(inflightPath, { force: true });
  }

  static async rollbackTakenSubdialogResponses(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    const dialogPath = this.getDialogResponsesPath(dialogId, status);
    await fs.promises.mkdir(dialogPath, { recursive: true });

    const filePath = path.join(dialogPath, 'subdialog-responses.json');
    const inflightPath = path.join(dialogPath, 'subdialog-responses.processing.json');

    let inflight: unknown[] = [];
    try {
      const raw = await fs.promises.readFile(inflightPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      inflight = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return;
      }
      throw error;
    }

    let primary: unknown[] = [];
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      primary = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }
    }

    const merged = [...inflight, ...primary].filter(isSubdialogResponseRecord);
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
    await this.renameWithRetry(tempFile, filePath, jsonContent);
    await fs.promises.rm(inflightPath, { force: true });
  }

  /**
   * Save root dialog metadata (write-once pattern)
   */
  static async saveRootDialogMetadata(
    dialogId: DialogID,
    metadata: RootDialogMetadataFile,
    status: 'running' | 'completed' | 'archived' = 'running',
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
      await this.renameWithRetry(tempFile, metadataFilePath, yamlContent);
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
    status: 'running' | 'completed' | 'archived' = 'running',
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
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    return this.saveRootDialogMetadata(dialogId, metadata, status);
  }

  /**
   * Save subdialog metadata under the supdialog's .subdialogs directory
   */
  static async saveSubdialogMetadata(
    dialogId: DialogID,
    metadata: SubdialogMetadataFile,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    try {
      const subPath = this.getSubdialogPath(dialogId, status);
      const metadataFilePath = path.join(subPath, 'dialog.yaml');

      await fs.promises.mkdir(subPath, { recursive: true });

      const yamlContent = yaml.stringify(metadata);
      const tempFile = path.join(
        subPath,
        `.${path.basename(metadataFilePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      await fs.promises.writeFile(tempFile, yamlContent, 'utf-8');
      await this.renameWithRetry(tempFile, metadataFilePath, yamlContent);
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
   * Persists both subdialog metadata locations for consistency.
   */
  static async updateSubdialogAssignment(
    dialogId: DialogID,
    assignment: SubdialogMetadataFile['assignmentFromSup'],
    status: 'running' | 'completed' | 'archived' = 'running',
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
    await this.saveDialogMetadata(dialogId, next, status);
  }

  /**
   * Load root dialog metadata
   */
  static async loadRootDialogMetadata(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<DialogMetadataFile | null> {
    try {
      const dialogPath = this.getRootDialogPath(dialogId, status);
      const metadataFilePath = path.join(dialogPath, 'dialog.yaml');

      try {
        const content = await fs.promises.readFile(metadataFilePath, 'utf-8');
        const parsed: unknown = yaml.parse(content);

        if (!isDialogMetadataFile(parsed)) {
          throw new Error(`Invalid dialog metadata in ${metadataFilePath}`);
        }

        // Validate that the ID in the file matches the expected dialogId
        if (parsed.id !== dialogId.selfId) {
          log.warn(
            `Dialog ID mismatch in ${metadataFilePath}: expected ${dialogId.selfId}, got ${parsed.id}`,
          );
          return null;
        }

        return parsed;
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return null;
        }
        throw error;
      }
    } catch (error) {
      log.error(`Failed to load dialog YAML for dialog ${dialogId.selfId}:`, error);
      return null;
    }
  }

  /**
   * Load dialog metadata (universal - works with any DialogID)
   */
  static async loadDialogMetadata(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
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
      const content = await fs.promises.readFile(metadataFilePath, 'utf-8');
      const parsed: unknown = yaml.parse(content);
      if (!isDialogMetadataFile(parsed)) {
        throw new Error(`Invalid dialog metadata in ${metadataFilePath}`);
      }
      return parsed;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Save latest.yaml with current course and lastModified info
   */
  private static async writeDialogLatestToDisk(
    dialogId: DialogID,
    latest: DialogLatestFile,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const latestFilePath = path.join(dialogPath, 'latest.yaml');

      // Ensure directory exists before writing (handles race conditions and new dialogs)
      await fs.promises.mkdir(dialogPath, { recursive: true });

      // NOTE: Use a unique temp file name to avoid collisions when multiple updates
      // happen concurrently for the same dialog (e.g., parallel tool responses).
      const tempFile = path.join(
        dialogPath,
        `.${path.basename(latestFilePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      const yamlContent = yaml.stringify(latest);
      await fs.promises.writeFile(tempFile, yamlContent, 'utf-8');

      // Rename with retry logic for filesystem sync issues
      await this.renameWithRetry(tempFile, latestFilePath, yamlContent);

      // todo: publish CourseEvent here or where more suitable?
    } catch (error) {
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
    yamlContent: string,
    maxRetries: number = 5,
  ): Promise<void> {
    let lastError: Error | undefined;
    const destinationDir = path.dirname(destination);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Ensure directory exists (handles race conditions)
        await fs.promises.mkdir(destinationDir, { recursive: true });

        // Check if source file exists, re-create if missing
        try {
          await fs.promises.access(source);
        } catch {
          // Source file missing - re-create it
          await fs.promises.writeFile(source, yamlContent, 'utf-8');
        }

        await fs.promises.rename(source, destination);
        return;
      } catch (error) {
        lastError = error as Error;
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
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<DialogLatestFile | null> {
    try {
      const key = this.getLatestWriteBackKey(dialogId, status);
      const staged = this.latestWriteBack.get(key);
      if (staged) {
        return staged.latest;
      }
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const latestFilePath = path.join(dialogPath, 'latest.yaml');

      const content = await fs.promises.readFile(latestFilePath, 'utf-8');
      const parsed: unknown = yaml.parse(content);
      const latest = parseDialogLatestFile(parsed);
      if (!latest) {
        throw new Error(`Invalid latest.yaml in ${latestFilePath}`);
      }
      return latest;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
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
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<DialogLatestFile> {
    const key = this.getLatestWriteBackKey(dialogId, status);
    const mutex = this.getLatestWriteBackMutex(key);

    const release = await mutex.acquire();
    try {
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
    status: 'running' | 'completed' | 'archived',
  ): Promise<DialogLatestFile | null> {
    try {
      const dialogPath = this.getDialogEventsPath(dialogId, status);
      const latestFilePath = path.join(dialogPath, 'latest.yaml');

      const content = await fs.promises.readFile(latestFilePath, 'utf-8');
      const parsed: unknown = yaml.parse(content);
      const latest = parseDialogLatestFile(parsed);
      if (!latest) {
        throw new Error(`Invalid latest.yaml in ${latestFilePath}`);
      }
      return latest;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private static async flushLatestWriteBack(key: string): Promise<void> {
    const mutex = this.getLatestWriteBackMutex(key);

    let captured:
      | {
          dialogId: DialogID;
          status: 'running' | 'completed' | 'archived';
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
        const inFlight = this.writeDialogLatestToDisk(entry.dialogId, latestToWrite, entry.status);

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
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    await this.mutateDialogLatest(
      dialogId,
      () => ({ kind: 'patch', patch: { needsDrive } }),
      status,
    );
  }

  static async getNeedsDrive(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<boolean> {
    const latest = await this.loadDialogLatest(dialogId, status);
    return latest?.needsDrive === true;
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
  static getStatusFromPath(dialogPath: string): 'running' | 'completed' | 'archived' {
    const parentDir = path.basename(path.dirname(dialogPath));
    if (parentDir === this.RUN_DIR) return 'running';
    if (parentDir === this.DONE_DIR) return 'completed';
    if (parentDir === this.ARCHIVE_DIR) return 'archived';
    throw new Error(`Unknown dialog status from path: ${parentDir}`);
  }

  static async loadQuestions4Human(
    dialogId: DialogID,
    course: number,
    status: 'running' | 'completed' | 'archived' = 'running',
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
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<number> {
    try {
      const rootPath = this.getRootDialogPath(rootDialogId, status);
      const subdialogsPath = path.join(rootPath, this.SUBDIALOGS_DIR);
      try {
        const entries = await fs.promises.readdir(subdialogsPath, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).length;
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return 0;
        }
        throw error;
      }
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
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<DialogPersistenceState | null> {
    try {
      // First restore the root dialog
      const rootState = await this.restoreDialog(rootDialogId, status);
      if (!rootState) {
        return null;
      }

      // Recursively restore subdialogs
      const rootPath = this.getRootDialogPath(rootDialogId, status);
      const subdialogsPath = path.join(rootPath, this.SUBDIALOGS_DIR);
      let subdialogIds: string[] = [];
      try {
        const entries = await fs.promises.readdir(subdialogsPath, { withFileTypes: true });
        subdialogIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch (err) {
        if (getErrorCode(err) !== 'ENOENT') {
          throw err;
        }
      }
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
   * Restore dialog from disk using JSONL events (optimized: only latest course loaded)
   * For historical courses, use loadCourseEvents() on-demand for UI navigation
   */
  static async restoreDialog(
    dialogId: DialogID,
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<DialogPersistenceState | null> {
    try {
      const metadata = await this.loadDialogMetadata(dialogId, status);
      if (!metadata) {
        log.debug(`No metadata found for dialog ${dialogId}`);
        return null;
      }

      const reminders = await this.loadReminderState(dialogId, status);
      // Only load latest course for dialog state restoration
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
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<PersistedDialogRecord[]> {
    return await this.readCourseEvents(dialogId, course, status);
  }

  /**
   * Reconstruct dialog state from JSONL events (optimized: only latest course needed)
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

        case 'ui_only_markdown_record': {
          messages.push({
            type: 'ui_only_markdown_msg',
            role: 'assistant',
            genseq: event.genseq,
            content: event.content,
          });
          break;
        }

        case 'human_text_record': {
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

        case 'func_call_record': {
          // Convert function call to ChatMessage
          messages.push({
            type: 'func_call_msg',
            role: 'assistant',
            genseq: event.genseq,
            id: event.id,
            name: event.name,
            arguments: event.arguments ? JSON.stringify(event.arguments) : '{}',
          });
          break;
        }
        case 'web_search_call_record':
          // UI-only timeline event for native web_search tool call visualization.
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

        case 'teammate_call_result_record': {
          // Convert teammate-call inline result to ChatMessage
          const mentionList = (() => {
            switch (event.callName) {
              case 'tellask':
              case 'tellaskSessionless':
                return event.mentionList;
              case 'tellaskBack':
              case 'askHuman':
              case 'freshBootsReasoning':
                return undefined;
            }
          })();
          messages.push({
            type: 'tellask_result_msg',
            role: 'tool',
            responderId: event.responderId,
            mentionList,
            tellaskContent: event.tellaskContent,
            status: event.status,
            callId: event.callId,
            content: event.result,
          });
          break;
        }

        case 'teammate_response_record': {
          // Convert teammate response to ChatMessage (teammate - separate bubble)
          // Note: Teammate responses are stored as separate records but use same message type
          const mentionList = (() => {
            switch (event.callName) {
              case 'tellask':
              case 'tellaskSessionless':
                return event.mentionList;
              case 'tellaskBack':
              case 'freshBootsReasoning':
                return undefined;
            }
          })();
          messages.push({
            type: 'tellask_result_msg',
            role: 'tool',
            responderId: event.responderId,
            mentionList,
            tellaskContent: event.tellaskContent,
            status: event.status,
            callId: event.callId,
            content: event.response,
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
        case 'teammate_call_anchor_record':
          // This record is UI navigation metadata for deep links in callee dialogs.
          // It does not contribute to model context or chat transcript reconstruction.
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
    fromStatus: 'running' | 'completed' | 'archived',
    toStatus: 'running' | 'completed' | 'archived',
  ): Promise<void> {
    try {
      const fromPath = path.join(
        this.getDialogsRootDir(),
        fromStatus === 'running'
          ? this.RUN_DIR
          : fromStatus === 'completed'
            ? this.DONE_DIR
            : this.ARCHIVE_DIR,
        dialogId.selfId,
      );
      const toPath = path.join(
        this.getDialogsRootDir(),
        toStatus === 'running'
          ? this.RUN_DIR
          : toStatus === 'completed'
            ? this.DONE_DIR
            : this.ARCHIVE_DIR,
        dialogId.selfId,
      );

      // Ensure destination directory exists
      await fs.promises.mkdir(toPath, { recursive: true });

      // Move all files and directories
      const entries = await fs.promises.readdir(fromPath, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(fromPath, entry.name);
        const destPath = path.join(toPath, entry.name);
        await fs.promises.rename(srcPath, destPath);
      }

      // Remove the (now-empty) source directory so the dialog is not detected under both statuses.
      await fs.promises.rm(fromPath, { recursive: true, force: true });
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
    fromStatus: 'running' | 'completed' | 'archived',
  ): Promise<boolean> {
    if (rootDialogId.selfId !== rootDialogId.rootId) {
      throw new Error('deleteRootDialog expects a root dialog id');
    }
    const exists = await this.loadRootDialogMetadata(rootDialogId, fromStatus);
    if (!exists) return false;

    // Best-effort cleanup: remove the dialog from all status directories to avoid leaving behind
    // orphaned placeholder paths (e.g. `run/<id>/latest.yaml`) after a delete.
    const allStatuses: Array<'running' | 'completed' | 'archived'> = [
      'running',
      'completed',
      'archived',
    ];
    for (const candidate of allStatuses) {
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
    status: 'running' | 'completed' | 'archived' = 'running',
  ): Promise<void> {
    try {
      const dialogPath = this.getDialogResponsesPath(rootDialogId, status);
      const registryFilePath = path.join(dialogPath, 'registry.yaml');

      await fs.promises.mkdir(dialogPath, { recursive: true });

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
      await this.renameWithRetry(tempFile, registryFilePath, yamlContent);
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
    status: 'running' | 'completed' | 'archived' = 'running',
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

      const content = await fs.promises.readFile(registryFilePath, 'utf-8');
      const parsed: unknown = yaml.parse(content);

      if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
        log.warn(`Invalid registry.yaml format for dialog ${rootDialogId}`);
        return [];
      }

      const entries = parsed.entries.map((entry: unknown) => {
        if (!isRecord(entry)) {
          throw new Error('Invalid registry entry');
        }
        return {
          key: entry.key as string,
          subdialogId: new DialogID(entry.subdialogId as string, rootDialogId.rootId),
          agentId: entry.agentId as string,
          sessionSlug: entry.sessionSlug as string | undefined,
        };
      });

      return entries;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return [];
      }
      log.error(`Failed to load subdialog registry for dialog ${rootDialogId}:`, error);
      return [];
    }
  }
}
