import { inspect } from 'util';

import type { NewQ4HAskedEvent } from '@longrun-ai/kernel/types/dialog';
import {
  toCallerCourseNumber,
  toCallingCourseNumber,
  toRootGenerationAnchor,
  type HumanQuestion,
  type PendingSubdialogStateRecord,
} from '@longrun-ai/kernel/types/storage';
import { generateShortId } from '@longrun-ai/kernel/utils/id';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { AssignmentFromSup } from '../../dialog';
import { Dialog, DialogID, RootDialog, SubDialog } from '../../dialog';
import { ensureDialogLoaded } from '../../dialog-instance-registry';
import { postDialogEvent } from '../../evt-registry';
import { log } from '../../log';
import { DialogPersistence } from '../../persistence';
import {
  formatDomindsNoteDirectSelfCall,
  formatDomindsNoteFbrDisabled,
  formatDomindsNoteFbrToollessViolation,
  formatDomindsNoteQ4HRegisterFailed,
  formatDomindsNoteTellaskForTeammatesOnly,
  formatRegisteredTellaskCallerUpdateNotice,
} from '../../runtime/driver-messages';
import { appendDistinctPerspectiveFbrBody } from '../../runtime/fbr-body';
import {
  formatAssignmentFromSupdialog,
  formatSupdialogCallPrompt,
  formatTellaskCarryoverResultContent,
  formatTellaskReplacementNoticeContent,
  formatTellaskResponseContent,
  formatUpdatedAssignmentFromSupdialog,
} from '../../runtime/inter-dialog-format';
import { getWorkLanguage } from '../../runtime/work-language';
import { Team } from '../../team';
import { syncPendingTellaskReminderState } from '../../tools/pending-tellask-reminder';
import type { ChatMessage, FuncCallMsg } from '../client';
import {
  buildFbrConvergencePrompt,
  buildFbrFinalizationPrompt,
  buildProgrammaticFbrUnreasonableSituationContent,
  inspectFbrConclusionAttempt,
} from './fbr';
import { supplyResponseToSupdialog } from './subdialog';
import { withSubdialogTxnLock, withSubdialogTxnLocks } from './subdialog-txn';
import type { KernelDriverDriveCallbacks, KernelDriverHumanPrompt } from './types';

export type TellaskRoutingParseResult =
  | {
      type: 'A';
      agentId: string;
    }
  | {
      type: 'B';
      agentId: string;
      sessionSlug: string;
    }
  | {
      type: 'C';
      agentId: string;
    };

const TELLASK_SPECIAL_FUNCTION_NAMES = [
  'tellaskBack',
  'tellask',
  'tellaskSessionless',
  'askHuman',
  'freshBootsReasoning',
] as const;

export type TellaskSpecialFunctionName = (typeof TELLASK_SPECIAL_FUNCTION_NAMES)[number];

export type TellaskSpecialCall =
  | Readonly<{
      callId: string;
      callName: 'tellaskBack';
      tellaskContent: string;
    }>
  | Readonly<{
      callId: string;
      callName: 'tellask';
      targetAgentId: string;
      sessionSlug: string;
      mentionList: string[];
      tellaskContent: string;
    }>
  | Readonly<{
      callId: string;
      callName: 'tellaskSessionless';
      targetAgentId: string;
      mentionList: string[];
      tellaskContent: string;
    }>
  | Readonly<{
      callId: string;
      callName: 'askHuman';
      tellaskContent: string;
    }>
  | Readonly<{
      callId: string;
      callName: 'freshBootsReasoning';
      tellaskContent: string;
      effort?: number;
    }>;

export type TellaskSpecialCallParseIssue = Readonly<{
  call: FuncCallMsg;
  error: string;
}>;

export function isTellaskSpecialFunctionName(name: string): name is TellaskSpecialFunctionName {
  return (TELLASK_SPECIAL_FUNCTION_NAMES as readonly string[]).includes(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFuncCallArgsObject(call: FuncCallMsg):
  | { ok: true; value: Record<string, unknown> }
  | {
      ok: false;
      error: string;
    } {
  try {
    const parsed: unknown = JSON.parse(call.arguments || '{}');
    if (!isRecord(parsed)) {
      return { ok: false, error: 'arguments must be a JSON object' };
    }
    return { ok: true, value: parsed };
  } catch (err) {
    return {
      ok: false,
      error: `arguments must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function readRequiredStringField(
  obj: Record<string, unknown>,
  field: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = obj[field];
  if (typeof value !== 'string') {
    return { ok: false, error: `field '${field}' must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return { ok: false, error: `field '${field}' must not be empty` };
  }
  return { ok: true, value: trimmed };
}

function readOptionalStringField(obj: Record<string, unknown>, field: string): string | null {
  const value = obj[field];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readOptionalEffortField(
  obj: Record<string, unknown>,
  field: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const value = obj[field];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return {
      ok: false,
      error: `field '${field}' must be an integer in [0, 100] when provided`,
    };
  }
  if (value < 0 || value > 100) {
    return {
      ok: false,
      error: `field '${field}' must be an integer in [0, 100] when provided`,
    };
  }
  return { ok: true, value };
}

function readTargetAgentId(obj: Record<string, unknown>):
  | { ok: true; value: string }
  | {
      ok: false;
      error: string;
    } {
  const target =
    readOptionalStringField(obj, 'targetAgentId') ??
    readOptionalStringField(obj, 'agentId') ??
    readOptionalStringField(obj, 'target');
  if (!target) {
    return {
      ok: false,
      error: "missing target agent id (expected 'targetAgentId' or 'agentId')",
    };
  }
  return { ok: true, value: target };
}

function normalizeTeammateTargetAgentId(rawTarget: string):
  | { ok: true; value: string }
  | {
      ok: false;
      error: string;
    } {
  const trimmed = rawTarget.trim();
  const withoutAt = trimmed.startsWith('@') ? trimmed.slice(1).trim() : trimmed;
  if (withoutAt === '') {
    return {
      ok: false,
      error: 'targetAgentId must not be empty',
    };
  }
  return { ok: true, value: withoutAt };
}

function parseTellaskSpecialCall(
  call: FuncCallMsg,
): { ok: true; value: TellaskSpecialCall } | { ok: false; error: string } {
  if (!isTellaskSpecialFunctionName(call.name)) {
    return { ok: false, error: `unsupported tellask special function '${call.name}'` };
  }

  const argsResult = parseFuncCallArgsObject(call);
  if (!argsResult.ok) {
    return argsResult;
  }
  const args = argsResult.value;

  const tellaskContent = readRequiredStringField(args, 'tellaskContent');
  if (!tellaskContent.ok) {
    return tellaskContent;
  }

  switch (call.name) {
    case 'tellaskBack': {
      return {
        ok: true,
        value: {
          callId: call.id,
          callName: 'tellaskBack',
          tellaskContent: tellaskContent.value,
        },
      };
    }
    case 'askHuman': {
      return {
        ok: true,
        value: {
          callId: call.id,
          callName: 'askHuman',
          tellaskContent: tellaskContent.value,
        },
      };
    }
    case 'freshBootsReasoning': {
      const effort = readOptionalEffortField(args, 'effort');
      if (!effort.ok) {
        return effort;
      }
      return {
        ok: true,
        value: {
          callId: call.id,
          callName: 'freshBootsReasoning',
          tellaskContent: tellaskContent.value,
          effort: effort.value,
        },
      };
    }
    case 'tellask': {
      const target = readTargetAgentId(args);
      if (!target.ok) {
        return target;
      }
      const normalizedTarget = normalizeTeammateTargetAgentId(target.value);
      if (!normalizedTarget.ok) {
        return normalizedTarget;
      }
      const sessionSlug = readRequiredStringField(args, 'sessionSlug');
      if (!sessionSlug.ok) {
        return sessionSlug;
      }
      if (!isValidSessionSlug(sessionSlug.value)) {
        return {
          ok: false,
          error:
            "field 'sessionSlug' must match <alpha>[<alnum|_|->]*(.<segment>)*, e.g. 'build-loop' or 'repo.sync'",
        };
      }
      return {
        ok: true,
        value: {
          callId: call.id,
          callName: 'tellask',
          targetAgentId: normalizedTarget.value,
          sessionSlug: sessionSlug.value,
          mentionList: [`@${normalizedTarget.value}`],
          tellaskContent: tellaskContent.value,
        },
      };
    }
    case 'tellaskSessionless': {
      const target = readTargetAgentId(args);
      if (!target.ok) {
        return target;
      }
      const normalizedTarget = normalizeTeammateTargetAgentId(target.value);
      if (!normalizedTarget.ok) {
        return normalizedTarget;
      }
      return {
        ok: true,
        value: {
          callId: call.id,
          callName: 'tellaskSessionless',
          targetAgentId: normalizedTarget.value,
          mentionList: [`@${normalizedTarget.value}`],
          tellaskContent: tellaskContent.value,
        },
      };
    }
  }
}

export function classifyTellaskSpecialFunctionCalls(
  funcCalls: readonly FuncCallMsg[],
  options?: { allowedSpecials?: ReadonlySet<TellaskSpecialFunctionName> },
): {
  specialCalls: TellaskSpecialCall[];
  normalCalls: FuncCallMsg[];
  parseIssues: TellaskSpecialCallParseIssue[];
} {
  const specialCalls: TellaskSpecialCall[] = [];
  const normalCalls: FuncCallMsg[] = [];
  const parseIssues: TellaskSpecialCallParseIssue[] = [];
  const allowed = options?.allowedSpecials ?? null;

  for (const call of funcCalls) {
    if (!isTellaskSpecialFunctionName(call.name)) {
      normalCalls.push(call);
      continue;
    }
    if (allowed && !allowed.has(call.name)) {
      normalCalls.push(call);
      continue;
    }
    const parsed = parseTellaskSpecialCall(call);
    if (!parsed.ok) {
      parseIssues.push({ call, error: parsed.error });
      continue;
    }
    specialCalls.push(parsed.value);
  }

  return { specialCalls, normalCalls, parseIssues };
}

function showErrorToAi(err: unknown): string {
  try {
    if (err instanceof Error) {
      return `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`;
    }

    if (typeof err === 'string') {
      const s = err.trim();
      return s.length > 500 ? `${s.slice(0, 497)}...` : s;
    }
    return inspect(err, { depth: 5, breakLength: 120, compact: false, sorted: true });
  } catch {
    return `Unknown error of type ${typeof err}`;
  }
}

async function syncPendingTellaskReminderBestEffort(dlg: Dialog, where: string): Promise<void> {
  try {
    const changed = await syncPendingTellaskReminderState(dlg);
    if (!changed) return;
    await dlg.processReminderUpdates();
  } catch (err) {
    log.warn('Failed to sync pending tellask reminder', undefined, {
      where,
      dialogId: dlg.id.selfId,
      rootId: dlg.id.rootId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function isValidSessionSlug(sessionSlug: string): boolean {
  const segments = sessionSlug.split('.');
  if (segments.length === 0) return false;
  return segments.every((segment) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(segment));
}

function resolveFbrEffort(member: Team.Member | null | undefined): number {
  const raw = member?.fbr_effort;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  if (!Number.isInteger(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 100) return 0;
  return raw;
}

async function driveFbrStageRound(args: {
  callbacks: KernelDriverDriveCallbacks;
  subdialog: SubDialog;
  prompt: KernelDriverHumanPrompt;
  reason: string;
  iteration: number;
  total: number;
  ownerDialogId: string;
  callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  callId: string;
}): Promise<void> {
  try {
    await args.callbacks.driveDialog(args.subdialog, {
      humanPrompt: args.prompt,
      waitInQue: true,
      driveOptions: {
        source: 'kernel_driver_fbr_subdialog_round',
        reason: args.reason,
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error('FBR serial drive failed', error, {
      rootId: args.subdialog.id.rootId,
      ownerDialogId: args.ownerDialogId,
      subdialogId: args.subdialog.id.selfId,
      iteration: args.iteration,
      total: args.total,
      callName: args.callName,
      callId: args.callId,
      detail,
      reason: args.reason,
    });
    throw new Error(`FBR serial round ${args.iteration}/${args.total} failed: ${detail}`);
  }
}

async function tryExtractFbrConclusionFromLatestDrive(args: {
  subdialog: SubDialog;
  previousMessageCount: number;
}): Promise<
  | {
      kind: 'accepted';
      responseText: string;
      responseGenseq: number;
    }
  | {
      kind: 'none';
    }
> {
  const newMessages = args.subdialog.msgs.slice(args.previousMessageCount);
  const inspection = inspectFbrConclusionAttempt(newMessages);
  if (inspection.kind === 'accepted') {
    return {
      kind: 'accepted',
      responseText: inspection.content,
      responseGenseq: inspection.genseq,
    };
  }
  if (inspection.kind === 'rejected') {
    const detail = `FBR conclusion attempt rejected: ${inspection.reason}`;
    await args.subdialog.streamError(detail);
    log.warn(detail, undefined, {
      rootId: args.subdialog.id.rootId,
      selfId: args.subdialog.id.selfId,
    });
  }
  return { kind: 'none' };
}

type SubdialogCreateOptions = {
  callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  originMemberId: string;
  callerDialogId: string;
  callId: string;
  sessionSlug?: string;
  collectiveTargets?: string[];
};

async function createSubDialog(
  callerDialog: Dialog,
  targetAgentId: string,
  mentionList: string[] | undefined,
  tellaskContent: string,
  options: SubdialogCreateOptions,
): Promise<SubDialog> {
  return await callerDialog.createSubDialog(targetAgentId, mentionList, tellaskContent, options);
}

async function updateSubdialogAssignment(
  subdialog: SubDialog,
  assignment: AssignmentFromSup,
): Promise<void> {
  subdialog.assignmentFromSup = assignment;
  await DialogPersistence.updateSubdialogAssignment(subdialog.id, assignment);
}

async function lookupLiveRegisteredSubdialog(
  rootDialog: RootDialog,
  agentId: string,
  sessionSlug: string,
): Promise<SubDialog | undefined> {
  const existing = rootDialog.lookupSubdialog(agentId, sessionSlug);
  if (!existing) {
    return undefined;
  }
  const existingSession = existing.sessionSlug;
  if (!existingSession) {
    throw new Error(
      `Type B registry invariant violation: lookupSubdialog returned entry without sessionSlug (root=${rootDialog.id.valueOf()} sub=${existing.id.valueOf()})`,
    );
  }
  const latest = await DialogPersistence.loadDialogLatest(existing.id, rootDialog.status);
  const executionMarker = latest?.executionMarker;
  if (!executionMarker || executionMarker.kind !== 'dead') {
    return existing;
  }
  const removed = rootDialog.unregisterSubdialog(existing.agentId, existingSession);
  if (!removed) {
    throw new Error(
      `Failed to unregister dead registered subdialog: root=${rootDialog.id.valueOf()} sub=${existing.id.valueOf()} session=${existingSession}`,
    );
  }
  await rootDialog.saveSubdialogRegistry();
  log.debug('Pruned dead registered subdialog from Type B registry', undefined, {
    rootId: rootDialog.id.rootId,
    subdialogId: existing.id.selfId,
    agentId: existing.agentId,
    sessionSlug: existingSession,
  });
  return undefined;
}

async function resolveDialogWithinRoot(
  rootDialog: RootDialog,
  callerDialogId: string,
): Promise<Dialog> {
  if (callerDialogId === rootDialog.id.selfId) {
    return rootDialog;
  }
  const live = rootDialog.lookupDialog(callerDialogId);
  if (live) {
    return live;
  }
  const restored = await ensureDialogLoaded(
    rootDialog,
    new DialogID(callerDialogId, rootDialog.id.rootId),
    rootDialog.status,
  );
  if (!restored) {
    throw new Error(
      `Type B caller restore invariant violation: root=${rootDialog.id.valueOf()} caller=${callerDialogId}`,
    );
  }
  return restored;
}

async function finishRegisteredTellaskReplacement(args: {
  ownerDialog: Dialog;
  subdialog: SubDialog;
  pendingRecord: PendingSubdialogStateRecord;
  responseBody: string;
}): Promise<void> {
  const { ownerDialog, subdialog, pendingRecord, responseBody } = args;
  const language = getWorkLanguage();
  const requesterId = ownerDialog.agentId;
  const response = formatTellaskReplacementNoticeContent({
    responderId: subdialog.agentId,
    requesterId,
    mentionList: pendingRecord.mentionList,
    sessionSlug: pendingRecord.sessionSlug,
    tellaskContent: pendingRecord.tellaskContent,
    responseBody,
    language,
  });
  const carryoverOriginCourse = pendingRecord.callingCourse;
  const carryoverContent =
    carryoverOriginCourse !== undefined && carryoverOriginCourse !== ownerDialog.currentCourse
      ? formatTellaskCarryoverResultContent({
          originCourse: carryoverOriginCourse,
          callName: pendingRecord.callName,
          responderId: subdialog.agentId,
          mentionList: pendingRecord.mentionList,
          sessionSlug: pendingRecord.sessionSlug,
          tellaskContent: pendingRecord.tellaskContent,
          responseBody,
          status: 'failed',
          language,
        })
      : undefined;

  await ownerDialog.receiveTellaskResponse(
    subdialog.agentId,
    pendingRecord.callName,
    pendingRecord.mentionList,
    pendingRecord.tellaskContent,
    'failed',
    subdialog.id,
    {
      response,
      agentId: subdialog.agentId,
      callId: pendingRecord.callId,
      originMemberId: requesterId,
      originCourse: carryoverOriginCourse,
      carryoverContent,
      sessionSlug: pendingRecord.sessionSlug,
    },
  );

  const immediateMirror: ChatMessage =
    carryoverContent !== undefined
      ? {
          type: 'tellask_carryover_result_msg',
          role: 'user',
          content: carryoverContent,
          originCourse: carryoverOriginCourse!,
          responderId: subdialog.agentId,
          callName: pendingRecord.callName,
          tellaskContent: pendingRecord.tellaskContent,
          status: 'failed',
          callId: pendingRecord.callId,
        }
      : {
          type: 'tellask_result_msg',
          role: 'tool',
          responderId: subdialog.agentId,
          mentionList: pendingRecord.mentionList,
          tellaskContent: pendingRecord.tellaskContent,
          status: 'failed',
          callId: pendingRecord.callId,
          content: response,
        };
  await ownerDialog.addChatMessages(immediateMirror);
}

async function reviveDialogIfUnblocked(
  dialog: Dialog,
  callbacks: KernelDriverDriveCallbacks,
  reason: string,
): Promise<void> {
  const hasQ4H = await dialog.hasPendingQ4H();
  const hasPendingSubdialogs = await dialog.hasPendingSubdialogs();
  if (hasQ4H || hasPendingSubdialogs) {
    return;
  }
  if (dialog instanceof RootDialog) {
    await DialogPersistence.setNeedsDrive(dialog.id, true, dialog.status);
  }
  callbacks.scheduleDrive(dialog, {
    waitInQue: true,
    driveOptions: {
      source: 'kernel_driver_supply_response_parent_revive',
      reason,
      suppressDiligencePush: dialog.disableDiligencePush,
    },
  });
}

function extractLastAssistantResponse(
  messages: Array<{ type: string; content?: string }>,
  defaultMessage: string,
): string {
  let responseText = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'saying_msg' && typeof msg.content === 'string') {
      responseText = msg.content;
      break;
    }
    if (msg.type === 'thinking_msg' && typeof msg.content === 'string') {
      responseText = msg.content;
    }
  }

  if (!responseText) {
    responseText = defaultMessage;
  }

  return responseText;
}

async function extractSupdialogResponseForTypeA(supdialog: Dialog): Promise<string> {
  try {
    return extractLastAssistantResponse(
      supdialog.msgs,
      'Supdialog completed without producing output.',
    );
  } catch (err) {
    log.warn('Failed to extract supdialog response for Type A', err);
    return 'Supdialog completed with errors.';
  }
}

async function executeTellaskCall(
  dlg: Dialog,
  mentionList: string[] | undefined,
  body: string,
  callId: string,
  callbacks: KernelDriverDriveCallbacks,
  options: {
    callName: TellaskSpecialCall['callName'];
    parseResult: TellaskRoutingParseResult | null;
    targetForError?: string;
    collectiveTargets?: string[];
    q4hRemainingCallIds?: string[];
    fbrEffortOverride?: number;
  },
): Promise<ChatMessage[]> {
  const toolOutputs: ChatMessage[] = [];
  const callName = options.callName;
  const parseResult = options.parseResult;
  const normalizedMentionList = mentionList ?? [];
  const isFreshBootsCall = callName === 'freshBootsReasoning';
  const team = await Team.load();
  const member =
    parseResult !== null && parseResult.type !== 'A' ? team.getMember(parseResult.agentId) : null;

  const isQ4H = callName === 'askHuman';
  if (isQ4H) {
    try {
      const normalizedCallId = callId.trim();
      if (normalizedCallId === '') {
        throw new Error(
          `Q4H call invariant violation: empty callId (rootId=${dlg.id.rootId} selfId=${dlg.id.selfId})`,
        );
      }
      const questionId = `q4h-${dlg.id.rootId}-${dlg.id.selfId}-c${dlg.currentCourse}-${normalizedCallId}`;
      const normalizedRemainingCallIds = Array.from(
        new Set(
          (options?.q4hRemainingCallIds ?? [])
            .map((value) => value.trim())
            .filter((value) => value !== '' && value !== normalizedCallId),
        ),
      );
      const question: HumanQuestion = {
        id: questionId,
        tellaskContent: body.trim(),
        askedAt: formatUnifiedTimestamp(new Date()),
        callId: normalizedCallId,
        remainingCallIds:
          normalizedRemainingCallIds.length > 0 ? normalizedRemainingCallIds : undefined,
        callSiteRef: {
          course: dlg.currentCourse,
          messageIndex: dlg.msgs.length,
        },
      };

      await DialogPersistence.appendQuestion4HumanState(dlg.id, question);

      const newQuestionEvent: NewQ4HAskedEvent = {
        type: 'new_q4h_asked',
        question: {
          id: question.id,
          selfId: dlg.id.selfId,
          tellaskContent: question.tellaskContent,
          askedAt: question.askedAt,
          callId: question.callId,
          remainingCallIds: question.remainingCallIds,
          callSiteRef: question.callSiteRef,
          rootId: dlg.id.rootId,
          agentId: dlg.agentId,
          taskDocPath: dlg.taskDocPath,
        },
      };

      postDialogEvent(dlg, newQuestionEvent);
      return toolOutputs;
    } catch (q4hErr: unknown) {
      const errMsg = q4hErr instanceof Error ? q4hErr.message : String(q4hErr);
      const streamErr = `Q4H register invariant violation: dialog=${dlg.id.selfId} callId=${callId.trim()} reason=${errMsg}`;
      try {
        await dlg.streamError(streamErr);
      } catch (streamErrPost) {
        log.warn('Q4H: failed to emit stream_error_evt', streamErrPost, {
          dialogId: dlg.id.selfId,
        });
      }
      log.error('Q4H: Failed to register question', q4hErr, {
        dialogId: dlg.id.selfId,
        callId,
      });

      const msg = formatDomindsNoteQ4HRegisterFailed(getWorkLanguage(), { error: errMsg });
      toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
      toolOutputs.push({
        type: 'tellask_result_msg',
        role: 'tool',
        responderId: 'dominds',
        mentionList: normalizedMentionList,
        tellaskContent: body,
        status: 'failed',
        callId,
        content: msg,
      });
      await dlg.receiveTellaskCallResult(
        'dominds',
        callName,
        mentionList,
        body,
        msg,
        'failed',
        callId,
      );
      dlg.clearCurrentCallId();
      return toolOutputs;
    }
  }

  if (parseResult) {
    if (callName === 'tellaskBack' && parseResult.type !== 'A') {
      throw new Error(
        `tellaskBack invariant violation: expected Type A parseResult (callId=${callId}, got=${parseResult.type})`,
      );
    }
    const subdialogCallName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning' =
      callName === 'tellaskBack' ? 'freshBootsReasoning' : callName;
    const rawCallingCourse = dlg.activeGenCourseOrUndefined ?? dlg.currentCourse;
    const callingCourse =
      Number.isFinite(rawCallingCourse) && rawCallingCourse > 0
        ? toCallingCourseNumber(rawCallingCourse)
        : undefined;
    const firstMentionForError = options.targetForError ?? parseResult.agentId;
    if (parseResult.type !== 'A' && member === null) {
      const msg = formatDomindsNoteTellaskForTeammatesOnly(getWorkLanguage(), {
        firstMention: firstMentionForError,
      });
      toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
      toolOutputs.push({
        type: 'tellask_result_msg',
        role: 'tool',
        responderId: 'dominds',
        mentionList: normalizedMentionList,
        tellaskContent: body,
        status: 'failed',
        callId,
        content: msg,
      });
      await dlg.receiveTellaskCallResult(
        'dominds',
        callName,
        mentionList,
        body,
        msg,
        'failed',
        callId,
      );
      dlg.clearCurrentCallId();
      return toolOutputs;
    }

    if (isFreshBootsCall) {
      const memberFbrEffort = resolveFbrEffort(member);
      if (memberFbrEffort < 1) {
        const msg = formatDomindsNoteFbrDisabled(getWorkLanguage());
        toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
        toolOutputs.push({
          type: 'tellask_result_msg',
          role: 'tool',
          responderId: 'dominds',
          mentionList: normalizedMentionList,
          tellaskContent: body,
          status: 'failed',
          callId,
          content: msg,
        });
        await dlg.receiveTellaskCallResult(
          'dominds',
          callName,
          mentionList,
          body,
          msg,
          'failed',
          callId,
        );
        dlg.clearCurrentCallId();
        return toolOutputs;
      }
      const override = options.fbrEffortOverride;
      if (
        override !== undefined &&
        (!Number.isFinite(override) ||
          !Number.isInteger(override) ||
          override < 0 ||
          override > 100)
      ) {
        throw new Error(
          `freshBootsReasoning invariant violation: effort override out of range [0,100] (got=${override})`,
        );
      }
      const fbrEffort = override ?? memberFbrEffort;
      if (fbrEffort < 1) {
        const msg = formatDomindsNoteFbrDisabled(getWorkLanguage());
        toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
        toolOutputs.push({
          type: 'tellask_result_msg',
          role: 'tool',
          responderId: 'dominds',
          mentionList: normalizedMentionList,
          tellaskContent: body,
          status: 'failed',
          callId,
          content: msg,
        });
        await dlg.receiveTellaskCallResult(
          'dominds',
          callName,
          mentionList,
          body,
          msg,
          'failed',
          callId,
        );
        dlg.clearCurrentCallId();
        return toolOutputs;
      }

      const callerDialog = dlg;
      const originMemberId = dlg.agentId;
      const workLanguage = getWorkLanguage();
      const collectiveTargets = options?.collectiveTargets ?? [parseResult.agentId];

      if (parseResult.type !== 'C') {
        const msg = formatDomindsNoteFbrToollessViolation(getWorkLanguage(), {
          kind: 'internal_error',
        });
        toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
        toolOutputs.push({
          type: 'tellask_result_msg',
          role: 'tool',
          responderId: 'dominds',
          mentionList: normalizedMentionList,
          tellaskContent: body,
          status: 'failed',
          callId,
          content: msg,
        });
        await dlg.receiveTellaskCallResult(
          'dominds',
          callName,
          mentionList,
          body,
          msg,
          'failed',
          callId,
        );
        dlg.clearCurrentCallId();
        return toolOutputs;
      }

      const buildRoundBody = (iteration: number, total: number): string =>
        appendDistinctPerspectiveFbrBody({
          body,
          iteration,
          total,
          language: workLanguage,
          isFinalRound: iteration === total,
        });

      const firstInstanceBody = buildRoundBody(1, fbrEffort);
      const sub = await createSubDialog(dlg, parseResult.agentId, mentionList, firstInstanceBody, {
        callName: subdialogCallName,
        originMemberId,
        callerDialogId: callerDialog.id.selfId,
        callId,
        collectiveTargets,
      });
      sub.setFbrConclusionToolsEnabled(false);

      for (let i = 1; i <= fbrEffort; i += 1) {
        const initPrompt: KernelDriverHumanPrompt = {
          content: formatAssignmentFromSupdialog({
            callName: subdialogCallName,
            fromAgentId: dlg.agentId,
            toAgentId: sub.agentId,
            mentionList,
            tellaskContent: buildRoundBody(i, fbrEffort),
            language: workLanguage,
            collectiveTargets: [sub.agentId],
            fbrRound: {
              iteration: i,
              total: fbrEffort,
            },
          }),
          msgId: generateShortId(),
          grammar: 'markdown',
          origin: 'runtime',
        };
        await driveFbrStageRound({
          callbacks,
          subdialog: sub,
          prompt: initPrompt,
          reason: `fbr_divergence_round_${i}_of_${fbrEffort}`,
          iteration: i,
          total: fbrEffort,
          ownerDialogId: callerDialog.id.selfId,
          callName: subdialogCallName,
          callId,
        });
      }

      for (let i = 1; i <= fbrEffort; i += 1) {
        const convergencePrompt: KernelDriverHumanPrompt = {
          content: buildFbrConvergencePrompt({
            iteration: i,
            total: fbrEffort,
            language: workLanguage,
          }),
          msgId: generateShortId(),
          grammar: 'markdown',
          origin: 'runtime',
        };
        await driveFbrStageRound({
          callbacks,
          subdialog: sub,
          prompt: convergencePrompt,
          reason: `fbr_convergence_round_${i}_of_${fbrEffort}`,
          iteration: i,
          total: fbrEffort,
          ownerDialogId: callerDialog.id.selfId,
          callName: subdialogCallName,
          callId,
        });
      }

      sub.setFbrConclusionToolsEnabled(true);

      let finalized:
        | {
            responseText: string;
            responseGenseq: number;
          }
        | undefined;

      for (let attempt = 1; attempt <= fbrEffort; attempt += 1) {
        const previousMessageCount = sub.msgs.length;
        const finalizationPrompt: KernelDriverHumanPrompt = {
          content: buildFbrFinalizationPrompt({
            attempt,
            total: fbrEffort,
            language: workLanguage,
          }),
          msgId: generateShortId(),
          grammar: 'markdown',
          origin: 'runtime',
        };
        await driveFbrStageRound({
          callbacks,
          subdialog: sub,
          prompt: finalizationPrompt,
          reason: `fbr_finalization_attempt_${attempt}_of_${fbrEffort}`,
          iteration: attempt,
          total: fbrEffort,
          ownerDialogId: callerDialog.id.selfId,
          callName: subdialogCallName,
          callId,
        });

        const conclusion = await tryExtractFbrConclusionFromLatestDrive({
          subdialog: sub,
          previousMessageCount,
        });
        if (conclusion.kind === 'accepted') {
          finalized = {
            responseText: conclusion.responseText,
            responseGenseq: conclusion.responseGenseq,
          };
          break;
        }
      }

      if (!finalized) {
        const fallbackGenseq =
          sub.activeGenSeqOrUndefined ??
          sub.msgs
            .slice()
            .reverse()
            .find(
              (msg): msg is Extract<ChatMessage, { genseq: number }> =>
                'genseq' in msg && typeof msg.genseq === 'number' && msg.genseq > 0,
            )?.genseq ??
          1;
        finalized = {
          responseText: buildProgrammaticFbrUnreasonableSituationContent({
            language: workLanguage,
            finalizationAttempts: fbrEffort,
          }),
          responseGenseq: fallbackGenseq,
        };
      }

      await supplyResponseToSupdialog({
        parentDialog: callerDialog,
        subdialogId: sub.id,
        subdialog: sub,
        responseText: finalized.responseText,
        callType: 'C',
        callId,
        status: 'completed',
        calleeResponseRef: {
          course: sub.currentCourse,
          genseq: finalized.responseGenseq,
        },
        callerCourseOverride:
          callingCourse !== undefined ? toCallerCourseNumber(callingCourse) : undefined,
        scheduleDrive: callbacks.scheduleDrive,
      });

      sub.setFbrConclusionToolsEnabled(false);
      return toolOutputs;
    }

    const isDirectSelfCall = !isFreshBootsCall && parseResult.agentId === dlg.agentId;
    if (isDirectSelfCall) {
      const msg = formatDomindsNoteDirectSelfCall(getWorkLanguage());
      toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
      toolOutputs.push({
        type: 'tellask_result_msg',
        role: 'tool',
        responderId: 'dominds',
        mentionList: normalizedMentionList,
        tellaskContent: body,
        status: 'failed',
        callId,
        content: msg,
      });
      await dlg.receiveTellaskCallResult(
        'dominds',
        callName,
        mentionList,
        body,
        msg,
        'failed',
        callId,
      );
      dlg.clearCurrentCallId();
      return toolOutputs;
    }

    if (parseResult.type === 'A') {
      if (dlg instanceof SubDialog) {
        const supdialog = dlg.supdialog;
        dlg.setSuspensionState('suspended');

        try {
          const assignment = dlg.assignmentFromSup;
          const supPrompt: KernelDriverHumanPrompt = {
            content: formatSupdialogCallPrompt({
              fromAgentId: dlg.agentId,
              toAgentId: supdialog.agentId,
              subdialogRequest: {
                callName,
                mentionList,
                tellaskContent: body,
              },
              supdialogAssignment: {
                callName: assignment.callName,
                mentionList: assignment.mentionList,
                tellaskContent: assignment.tellaskContent,
              },
              language: getWorkLanguage(),
            }),
            msgId: generateShortId(),
            grammar: 'markdown',
            origin: 'runtime',
          };
          await callbacks.driveDialog(supdialog, {
            humanPrompt: supPrompt,
            waitInQue: true,
            driveOptions: {
              source: 'kernel_driver_type_a_supdialog_call',
              reason: 'type_a_supdialog_roundtrip',
            },
          });

          const responseText = await extractSupdialogResponseForTypeA(supdialog);
          const responseContent = formatTellaskResponseContent({
            callName,
            responderId: parseResult.agentId,
            requesterId: dlg.agentId,
            mentionList,
            tellaskContent: body,
            responseBody: responseText,
            status: 'completed',
            language: getWorkLanguage(),
          });

          dlg.setSuspensionState('resumed');

          toolOutputs.push({
            type: 'tellask_result_msg',
            role: 'tool',
            responderId: parseResult.agentId,
            mentionList,
            tellaskContent: body,
            status: 'completed',
            callId,
            content: responseContent,
          });
          await dlg.receiveTellaskResponse(
            parseResult.agentId,
            callName,
            mentionList,
            body,
            'completed',
            supdialog.id,
            {
              response: responseContent,
              agentId: parseResult.agentId,
              callId,
              originMemberId: dlg.agentId,
            },
          );
        } catch (err) {
          log.warn('Type A supdialog processing error:', err);
          dlg.setSuspensionState('resumed');
          const errorText = `❌ **Error processing request to @${parseResult.agentId}:**\n\n${showErrorToAi(err)}`;
          const errorContent = formatTellaskResponseContent({
            callName,
            responderId: parseResult.agentId,
            requesterId: dlg.agentId,
            mentionList,
            tellaskContent: body,
            responseBody: errorText,
            status: 'failed',
            language: getWorkLanguage(),
          });
          toolOutputs.push({
            type: 'tellask_result_msg',
            role: 'tool',
            responderId: parseResult.agentId,
            mentionList,
            tellaskContent: body,
            status: 'failed',
            callId,
            content: errorContent,
          });
          await dlg.receiveTellaskResponse(
            parseResult.agentId,
            callName,
            mentionList,
            body,
            'failed',
            supdialog.id,
            {
              response: errorContent,
              agentId: parseResult.agentId,
              callId,
              originMemberId: dlg.agentId,
            },
          );
        }
      } else {
        log.warn('Type A call on dialog without supdialog, falling back to Type C', undefined, {
          dialogId: dlg.id.selfId,
        });
      }
    } else if (parseResult.type === 'B') {
      const callerDialog = dlg;
      let rootDialog: RootDialog | undefined;
      if (dlg instanceof RootDialog) {
        rootDialog = dlg;
      } else if (dlg instanceof SubDialog) {
        rootDialog = dlg.rootDialog;
      }

      if (!rootDialog) {
        log.warn('Type B call without root dialog, falling back to Type C', undefined, {
          dialogId: dlg.id.selfId,
        });
        try {
          const sub = await createSubDialog(dlg, parseResult.agentId, mentionList, body, {
            callName: subdialogCallName,
            originMemberId: dlg.agentId,
            callerDialogId: callerDialog.id.selfId,
            callId,
            sessionSlug: parseResult.sessionSlug,
            collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
          });

          const pendingRecord: PendingSubdialogStateRecord = {
            subdialogId: sub.id.selfId,
            createdAt: formatUnifiedTimestamp(new Date()),
            callName: subdialogCallName,
            mentionList,
            tellaskContent: body,
            targetAgentId: parseResult.agentId,
            callId,
            callingCourse,
            callType: 'C',
            sessionSlug: parseResult.sessionSlug,
          };
          await withSubdialogTxnLock(dlg.id, async () => {
            await DialogPersistence.appendPendingSubdialog(
              dlg.id,
              pendingRecord,
              toRootGenerationAnchor({
                rootCourse:
                  dlg instanceof SubDialog ? dlg.rootDialog.currentCourse : dlg.currentCourse,
                rootGenseq:
                  dlg instanceof SubDialog
                    ? (dlg.rootDialog.activeGenSeqOrUndefined ?? 0)
                    : (dlg.activeGenSeqOrUndefined ?? 0),
              }),
            );
          });
          await syncPendingTellaskReminderBestEffort(
            dlg,
            'kernel-driver:executeTellaskCall:TypeB-fallback:appendPending',
          );

          const initPrompt: KernelDriverHumanPrompt = {
            content: formatAssignmentFromSupdialog({
              callName: subdialogCallName,
              fromAgentId: dlg.agentId,
              toAgentId: sub.agentId,
              mentionList,
              tellaskContent: body,
              language: getWorkLanguage(),
              collectiveTargets: options?.collectiveTargets ?? [sub.agentId],
            }),
            msgId: generateShortId(),
            grammar: 'markdown',
            origin: 'runtime',
            subdialogReplyTarget: {
              ownerDialogId: callerDialog.id.selfId,
              callType: 'C',
              callId,
            },
          };
          callbacks.scheduleDrive(sub, {
            humanPrompt: initPrompt,
            waitInQue: true,
            driveOptions: {
              source: 'kernel_driver_subdialog_init',
              reason: 'type_b_fallback_subdialog_init',
            },
          });
        } catch (err) {
          log.warn('Type B fallback subdialog creation error:', err);
        }
      } else {
        const originMemberId = dlg.agentId;
        const assignment: AssignmentFromSup = {
          callName: subdialogCallName,
          mentionList,
          tellaskContent: body,
          originMemberId,
          callerDialogId: callerDialog.id.selfId,
          callId,
          collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
        };
        const pendingOwner = callerDialog;
        const replacementNotice = formatRegisteredTellaskCallerUpdateNotice(getWorkLanguage());

        const result = await (async (): Promise<
          | {
              kind: 'created';
              subdialog: SubDialog;
            }
          | {
              kind: 'existing';
              subdialog: SubDialog;
              previousCaller: Dialog;
              replacedPending: PendingSubdialogStateRecord | undefined;
            }
        > => {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const seededExisting = rootDialog.lookupSubdialog(
              parseResult.agentId,
              parseResult.sessionSlug,
            );
            const seededPreviousCallerId = seededExisting?.assignmentFromSup.callerDialogId;
            const lockIds: DialogID[] = [rootDialog.id, pendingOwner.id];
            if (
              seededPreviousCallerId !== undefined &&
              seededPreviousCallerId !== rootDialog.id.selfId &&
              seededPreviousCallerId !== pendingOwner.id.selfId
            ) {
              lockIds.push(new DialogID(seededPreviousCallerId, rootDialog.id.rootId));
            }

            const attemptResult = await withSubdialogTxnLocks(lockIds, async () => {
              const existing = await lookupLiveRegisteredSubdialog(
                rootDialog,
                parseResult.agentId,
                parseResult.sessionSlug,
              );
              if (existing) {
                if (existing.assignmentFromSup.callerDialogId !== seededPreviousCallerId) {
                  return { kind: 'retry' as const };
                }
                const previousCaller = await resolveDialogWithinRoot(
                  rootDialog,
                  existing.assignmentFromSup.callerDialogId,
                );
                const pendingRecord: PendingSubdialogStateRecord = {
                  subdialogId: existing.id.selfId,
                  createdAt: formatUnifiedTimestamp(new Date()),
                  callName: subdialogCallName,
                  mentionList,
                  tellaskContent: body,
                  targetAgentId: parseResult.agentId,
                  callId,
                  callingCourse,
                  callType: 'B',
                  sessionSlug: parseResult.sessionSlug,
                };
                try {
                  const previousPending = await DialogPersistence.loadPendingSubdialogs(
                    previousCaller.id,
                    previousCaller.status,
                  );
                  const replacedPending = previousPending.filter(
                    (record) => record.subdialogId === existing.id.selfId,
                  );
                  if (replacedPending.length > 1) {
                    throw new Error(
                      `Type B pending invariant violation: caller=${previousCaller.id.valueOf()} sub=${existing.id.valueOf()} count=${replacedPending.length}`,
                    );
                  }

                  if (previousCaller.id.selfId === pendingOwner.id.selfId) {
                    const nextPending = previousPending.filter(
                      (record) => record.subdialogId !== existing.id.selfId,
                    );
                    nextPending.push(pendingRecord);
                    await DialogPersistence.savePendingSubdialogs(
                      pendingOwner.id,
                      nextPending,
                      undefined,
                      pendingOwner.status,
                    );
                  } else {
                    await DialogPersistence.savePendingSubdialogs(
                      previousCaller.id,
                      previousPending.filter((record) => record.subdialogId !== existing.id.selfId),
                      undefined,
                      previousCaller.status,
                    );
                    const nextPending = (
                      await DialogPersistence.loadPendingSubdialogs(
                        pendingOwner.id,
                        pendingOwner.status,
                      )
                    ).filter((record) => record.subdialogId !== existing.id.selfId);
                    nextPending.push(pendingRecord);
                    await DialogPersistence.savePendingSubdialogs(
                      pendingOwner.id,
                      nextPending,
                      undefined,
                      pendingOwner.status,
                    );
                  }

                  await updateSubdialogAssignment(existing, assignment);
                  return {
                    kind: 'existing' as const,
                    subdialog: existing,
                    previousCaller,
                    replacedPending: replacedPending[0],
                  };
                } catch (err) {
                  log.warn('Failed to update registered subdialog assignment', err);
                  return {
                    kind: 'existing' as const,
                    subdialog: existing,
                    previousCaller,
                    replacedPending: undefined,
                  };
                }
              }

              if (seededPreviousCallerId !== undefined) {
                return { kind: 'retry' as const };
              }

              const created = await createSubDialog(
                rootDialog,
                parseResult.agentId,
                mentionList,
                body,
                {
                  callName: subdialogCallName,
                  originMemberId,
                  callerDialogId: callerDialog.id.selfId,
                  callId,
                  sessionSlug: parseResult.sessionSlug,
                  collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
                },
              );
              rootDialog.registerSubdialog(created);
              await rootDialog.saveSubdialogRegistry();
              const pendingRecord: PendingSubdialogStateRecord = {
                subdialogId: created.id.selfId,
                createdAt: formatUnifiedTimestamp(new Date()),
                callName: subdialogCallName,
                mentionList,
                tellaskContent: body,
                targetAgentId: parseResult.agentId,
                callId,
                callingCourse,
                callType: 'B',
                sessionSlug: parseResult.sessionSlug,
              };
              const nextPending = (
                await DialogPersistence.loadPendingSubdialogs(pendingOwner.id, pendingOwner.status)
              ).filter((record) => record.subdialogId !== created.id.selfId);
              nextPending.push(pendingRecord);
              await DialogPersistence.savePendingSubdialogs(
                pendingOwner.id,
                nextPending,
                undefined,
                pendingOwner.status,
              );
              return { kind: 'created' as const, subdialog: created };
            });
            if (attemptResult.kind !== 'retry') {
              return attemptResult;
            }
          }
          throw new Error(
            `Type B registered subdialog mutation failed to stabilize: root=${rootDialog.id.valueOf()} agent=${parseResult.agentId} session=${parseResult.sessionSlug}`,
          );
        })();

        await syncPendingTellaskReminderBestEffort(
          pendingOwner,
          'kernel-driver:executeTellaskCall:TypeB:replacePending',
        );
        if (result.kind === 'existing' && result.replacedPending) {
          await finishRegisteredTellaskReplacement({
            ownerDialog: result.previousCaller,
            subdialog: result.subdialog,
            pendingRecord: result.replacedPending,
            responseBody: replacementNotice,
          });
          if (result.previousCaller.id.selfId !== pendingOwner.id.selfId) {
            await syncPendingTellaskReminderBestEffort(
              result.previousCaller,
              'kernel-driver:executeTellaskCall:TypeB:clearPreviousPending',
            );
            await reviveDialogIfUnblocked(
              result.previousCaller,
              callbacks,
              'type_b_registered_subdialog_replaced_pending_round',
            );
          }
        }

        if (result.kind === 'existing') {
          const resumePrompt: KernelDriverHumanPrompt = {
            content: formatUpdatedAssignmentFromSupdialog({
              callName: subdialogCallName,
              fromAgentId: dlg.agentId,
              toAgentId: result.subdialog.agentId,
              mentionList,
              sessionSlug: parseResult.sessionSlug,
              tellaskContent: body,
              language: getWorkLanguage(),
              collectiveTargets: options?.collectiveTargets ?? [result.subdialog.agentId],
            }),
            msgId: generateShortId(),
            grammar: 'markdown',
            origin: 'runtime',
            subdialogReplyTarget: {
              ownerDialogId: pendingOwner.id.selfId,
              callType: 'B',
              callId,
            },
          };
          let queuedIntoActiveLoop = false;
          let queuedRuntimePrompt = false;
          try {
            result.subdialog.queueRegisteredAssignmentUpdatePrompt({
              prompt: resumePrompt.content,
              msgId: resumePrompt.msgId,
              grammar: resumePrompt.grammar,
              userLanguageCode: resumePrompt.userLanguageCode,
              q4hAnswerCallIds: resumePrompt.q4hAnswerCallIds,
              skipTaskdoc: resumePrompt.skipTaskdoc,
              subdialogReplyTarget: resumePrompt.subdialogReplyTarget,
            });
            queuedRuntimePrompt = true;
            queuedIntoActiveLoop = result.subdialog.isLocked();
          } catch (err) {
            log.warn('Failed to queue registered subdialog update into active loop', err, {
              subdialogId: result.subdialog.id.valueOf(),
              sessionSlug: parseResult.sessionSlug,
              callId,
            });
          }
          if (queuedRuntimePrompt && !queuedIntoActiveLoop) {
            callbacks.scheduleDrive(result.subdialog, {
              waitInQue: true,
              driveOptions: {
                source: 'kernel_driver_subdialog_resume',
                reason: 'type_b_registered_subdialog_resume',
              },
            });
          } else if (!queuedRuntimePrompt) {
            callbacks.scheduleDrive(result.subdialog, {
              humanPrompt: resumePrompt,
              waitInQue: true,
              driveOptions: {
                source: 'kernel_driver_subdialog_resume',
                reason: 'type_b_registered_subdialog_resume',
              },
            });
          }
        } else {
          const initPrompt: KernelDriverHumanPrompt = {
            content: formatAssignmentFromSupdialog({
              callName: subdialogCallName,
              fromAgentId: rootDialog.agentId,
              toAgentId: result.subdialog.agentId,
              mentionList,
              sessionSlug: parseResult.sessionSlug,
              tellaskContent: body,
              language: getWorkLanguage(),
              collectiveTargets: options?.collectiveTargets ?? [result.subdialog.agentId],
            }),
            msgId: generateShortId(),
            grammar: 'markdown',
            origin: 'runtime',
            subdialogReplyTarget: {
              ownerDialogId: pendingOwner.id.selfId,
              callType: 'B',
              callId,
            },
          };
          callbacks.scheduleDrive(result.subdialog, {
            humanPrompt: initPrompt,
            waitInQue: true,
            driveOptions: {
              source: 'kernel_driver_subdialog_init',
              reason: 'type_b_registered_subdialog_init',
            },
          });
        }
      }
    }

    if (parseResult.type === 'C') {
      try {
        const sub = await createSubDialog(dlg, parseResult.agentId, mentionList, body, {
          callName: subdialogCallName,
          originMemberId: dlg.agentId,
          callerDialogId: dlg.id.selfId,
          callId,
          collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
        });
        const pendingRecord: PendingSubdialogStateRecord = {
          subdialogId: sub.id.selfId,
          createdAt: formatUnifiedTimestamp(new Date()),
          callName: subdialogCallName,
          mentionList,
          tellaskContent: body,
          targetAgentId: parseResult.agentId,
          callId,
          callingCourse,
          callType: 'C',
        };
        await withSubdialogTxnLock(dlg.id, async () => {
          await DialogPersistence.appendPendingSubdialog(
            dlg.id,
            pendingRecord,
            toRootGenerationAnchor({
              rootCourse:
                dlg instanceof SubDialog ? dlg.rootDialog.currentCourse : dlg.currentCourse,
              rootGenseq:
                dlg instanceof SubDialog
                  ? (dlg.rootDialog.activeGenSeqOrUndefined ?? 0)
                  : (dlg.activeGenSeqOrUndefined ?? 0),
            }),
          );
        });
        await syncPendingTellaskReminderBestEffort(
          dlg,
          'kernel-driver:executeTellaskCall:TypeC:appendPending',
        );

        const initPrompt: KernelDriverHumanPrompt = {
          content: formatAssignmentFromSupdialog({
            callName,
            fromAgentId: dlg.agentId,
            toAgentId: sub.agentId,
            mentionList,
            tellaskContent: body,
            language: getWorkLanguage(),
            collectiveTargets: options?.collectiveTargets ?? [sub.agentId],
          }),
          msgId: generateShortId(),
          grammar: 'markdown',
          origin: 'runtime',
          subdialogReplyTarget: {
            ownerDialogId: dlg.id.selfId,
            callType: 'C',
            callId,
          },
        };
        callbacks.scheduleDrive(sub, {
          humanPrompt: initPrompt,
          waitInQue: true,
          driveOptions: {
            source: 'kernel_driver_subdialog_init',
            reason: 'type_c_subdialog_init',
          },
        });
      } catch (err) {
        log.warn('Subdialog creation error:', err);
      }
    }
  } else {
    const msg = formatDomindsNoteTellaskForTeammatesOnly(getWorkLanguage(), {
      firstMention: options.targetForError ?? 'unknown',
    });
    toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
    toolOutputs.push({
      type: 'tellask_result_msg',
      role: 'tool',
      responderId: 'dominds',
      mentionList: normalizedMentionList,
      tellaskContent: body,
      status: 'failed',
      callId,
      content: msg,
    });
    await dlg.receiveTellaskCallResult(
      'dominds',
      callName,
      mentionList,
      body,
      msg,
      'failed',
      callId,
    );
    dlg.clearCurrentCallId();
  }

  return toolOutputs;
}

async function emitTellaskSpecialCallEvents(args: {
  dlg: Dialog;
  callName: TellaskSpecialCall['callName'];
  mentionList?: string[];
  sessionSlug?: string;
  tellaskContent: string;
  callId: string;
}): Promise<void> {
  await args.dlg.callingStart({
    callName: args.callName,
    callId: args.callId,
    mentionList: args.mentionList,
    sessionSlug: args.sessionSlug,
    tellaskContent: args.tellaskContent,
  });
}

type ExecutableValidTellaskCall =
  | Readonly<{
      callName: 'tellask';
      mentionList: string[];
      tellaskContent: string;
      callId: string;
      targetAgentId: string;
      sessionSlug: string;
      q4hRemainingCallIds?: string[];
    }>
  | Readonly<{
      callName: 'tellaskSessionless';
      mentionList: string[];
      tellaskContent: string;
      callId: string;
      targetAgentId: string;
      q4hRemainingCallIds?: string[];
    }>
  | Readonly<{
      callName: 'tellaskBack';
      tellaskContent: string;
      callId: string;
      q4hRemainingCallIds?: string[];
    }>
  | Readonly<{
      callName: 'askHuman';
      tellaskContent: string;
      callId: string;
      q4hRemainingCallIds?: string[];
    }>
  | Readonly<{
      callName: 'freshBootsReasoning';
      tellaskContent: string;
      callId: string;
      effort?: number;
      q4hRemainingCallIds?: string[];
    }>;

function toExecutableValidTellaskCall(call: TellaskSpecialCall): ExecutableValidTellaskCall {
  switch (call.callName) {
    case 'tellaskBack':
      return {
        callName: call.callName,
        tellaskContent: call.tellaskContent,
        callId: call.callId,
      };
    case 'tellask':
      return {
        callName: call.callName,
        mentionList: [...call.mentionList],
        tellaskContent: call.tellaskContent,
        targetAgentId: call.targetAgentId,
        sessionSlug: call.sessionSlug,
        callId: call.callId,
      };
    case 'tellaskSessionless':
      return {
        callName: call.callName,
        mentionList: [...call.mentionList],
        tellaskContent: call.tellaskContent,
        targetAgentId: call.targetAgentId,
        callId: call.callId,
      };
    case 'askHuman':
      return {
        callName: call.callName,
        tellaskContent: call.tellaskContent,
        callId: call.callId,
      };
    case 'freshBootsReasoning':
      return {
        callName: call.callName,
        tellaskContent: call.tellaskContent,
        callId: call.callId,
        effort: call.effort,
      };
  }
}

function normalizeQ4HCalls(
  calls: readonly ExecutableValidTellaskCall[],
  dlg: Dialog,
): ExecutableValidTellaskCall[] {
  const q4hCalls = calls.filter((call) => call.callName === 'askHuman');
  const nonQ4HCalls = calls
    .filter((call) => call.callName !== 'askHuman')
    .map((call) => {
      switch (call.callName) {
        case 'tellask':
        case 'tellaskSessionless':
          return { ...call, mentionList: [...call.mentionList] };
        case 'tellaskBack':
        case 'freshBootsReasoning':
          return { ...call };
      }
    });
  if (q4hCalls.length <= 1) {
    return q4hCalls.length === 1 ? [...nonQ4HCalls, { ...q4hCalls[0]! }] : nonQ4HCalls;
  }

  const primary = q4hCalls[0]!;
  const remainingCallIds = q4hCalls
    .slice(1)
    .map((call) => call.callId.trim())
    .filter((callId) => callId !== '');
  const language = getWorkLanguage();
  const intro =
    language === 'zh'
      ? `我这次有 ${q4hCalls.length} 个问题，想请你一次性回复：`
      : `I have ${q4hCalls.length} questions this round. Please answer them in one response:`;
  const mergedBody = [
    intro,
    ...q4hCalls.map((call, index) => {
      const body = call.tellaskContent.trim();
      const normalizedBody =
        body !== ''
          ? body
          : language === 'zh'
            ? '请结合当前上下文补充这一项。'
            : 'Please provide this item based on the current context.';
      return language === 'zh'
        ? `问题 ${index + 1}：\n${normalizedBody}`
        : `Question ${index + 1}:\n${normalizedBody}`;
    }),
  ].join('\n\n');
  const mergedQ4HCall: ExecutableValidTellaskCall = {
    callName: 'askHuman',
    callId: primary.callId,
    tellaskContent: mergedBody,
    q4hRemainingCallIds: remainingCallIds.length > 0 ? remainingCallIds : undefined,
  };
  log.debug('Q4H multi-question normalized into a single prompt', undefined, {
    rootId: dlg.id.rootId,
    selfId: dlg.id.selfId,
    mergedCount: q4hCalls.length,
    primaryCallId: primary.callId,
    remainingCallIds,
  });
  return [...nonQ4HCalls, mergedQ4HCall];
}

async function executeValidTellaskCalls(args: {
  dlg: Dialog;
  calls: readonly ExecutableValidTellaskCall[];
  callbacks: KernelDriverDriveCallbacks;
}): Promise<ChatMessage[]> {
  const executionCalls = normalizeQ4HCalls(args.calls, args.dlg);
  const results: ChatMessage[][] = [];
  for (const call of executionCalls) {
    const runtimeMentionList = (() => {
      switch (call.callName) {
        case 'tellask':
        case 'tellaskSessionless':
          return call.mentionList;
        case 'tellaskBack':
        case 'askHuman':
        case 'freshBootsReasoning':
          return undefined;
      }
    })();
    const sessionSlug = call.callName === 'tellask' ? call.sessionSlug : undefined;
    await emitTellaskSpecialCallEvents({
      dlg: args.dlg,
      callName: call.callName,
      mentionList: runtimeMentionList,
      sessionSlug,
      tellaskContent: call.tellaskContent,
      callId: call.callId,
    });
    let targetForError: string | undefined;
    let parseResult: TellaskRoutingParseResult | null;
    switch (call.callName) {
      case 'tellaskBack': {
        targetForError = args.dlg instanceof SubDialog ? args.dlg.supdialog.agentId : undefined;
        parseResult =
          args.dlg instanceof SubDialog ? { type: 'A', agentId: args.dlg.supdialog.agentId } : null;
        break;
      }
      case 'tellask': {
        const targetAgentId = call.targetAgentId;
        if (targetAgentId.trim() === '') {
          throw new Error(
            `tellask invariant violation: missing targetAgentId for callId=${call.callId}`,
          );
        }
        if (!call.sessionSlug) {
          throw new Error(
            `tellask invariant violation: missing sessionSlug for callId=${call.callId}`,
          );
        }
        targetForError = targetAgentId;
        parseResult = { type: 'B', agentId: targetAgentId, sessionSlug: call.sessionSlug };
        break;
      }
      case 'tellaskSessionless': {
        const targetAgentId = call.targetAgentId;
        if (targetAgentId.trim() === '') {
          throw new Error(
            `tellaskSessionless invariant violation: missing targetAgentId for callId=${call.callId}`,
          );
        }
        targetForError = targetAgentId;
        parseResult = { type: 'C', agentId: targetAgentId };
        break;
      }
      case 'askHuman': {
        targetForError = undefined;
        parseResult = null;
        break;
      }
      case 'freshBootsReasoning': {
        targetForError = args.dlg.agentId;
        parseResult = { type: 'C', agentId: args.dlg.agentId };
        break;
      }
    }
    const toolOutputs = await executeTellaskCall(
      args.dlg,
      runtimeMentionList,
      call.tellaskContent,
      call.callId,
      args.callbacks,
      {
        callName: call.callName,
        parseResult,
        targetForError,
        q4hRemainingCallIds: call.q4hRemainingCallIds,
        fbrEffortOverride: call.callName === 'freshBootsReasoning' ? call.effort : undefined,
      },
    );
    results.push(toolOutputs);
  }

  return results.flatMap((result) => result);
}

export async function executeTellaskSpecialCalls(args: {
  dlg: Dialog;
  calls: readonly TellaskSpecialCall[];
  callbacks: KernelDriverDriveCallbacks;
}): Promise<ChatMessage[]> {
  if (args.calls.length === 0) {
    return [];
  }

  return await executeValidTellaskCalls({
    dlg: args.dlg,
    calls: args.calls.map((call) => toExecutableValidTellaskCall(call)),
    callbacks: args.callbacks,
  });
}
