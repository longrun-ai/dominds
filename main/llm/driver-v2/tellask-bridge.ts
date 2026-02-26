import { inspect } from 'util';

import type { AssignmentFromSup } from '../../dialog';
import { Dialog, DialogID, RootDialog, SubDialog, type DialogID as TDialogID } from '../../dialog';
import { postDialogEvent } from '../../evt-registry';
import { log } from '../../log';
import { DialogPersistence } from '../../persistence';
import {
  formatDomindsNoteDirectSelfCall,
  formatDomindsNoteFbrDisabled,
  formatDomindsNoteFbrToollessViolation,
  formatDomindsNoteQ4HRegisterFailed,
  formatDomindsNoteTellaskForTeammatesOnly,
} from '../../shared/i18n/driver-messages';
import { getWorkLanguage } from '../../shared/runtime-language';
import type { NewQ4HAskedEvent } from '../../shared/types/dialog';
import type { HumanQuestion } from '../../shared/types/storage';
import { appendDistinctPerspectiveFbrBody } from '../../shared/utils/fbr';
import { generateShortId } from '../../shared/utils/id';
import {
  formatAssignmentFromSupdialog,
  formatSupdialogCallPrompt,
} from '../../shared/utils/inter-dialog-format';
import { formatUnifiedTimestamp } from '../../shared/utils/time';
import { Team } from '../../team';
import { syncPendingTellaskReminderState } from '../../tools/pending-tellask-reminder';
import type { ChatMessage, FuncCallMsg } from '../client';
import { withSubdialogTxnLock } from './subdialog-txn';
import type { DriverV2DriveInvoker, DriverV2DriveScheduler, DriverV2HumanPrompt } from './types';

type PendingSubdialogRecordType = {
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

export type TeammateTellaskParseResult =
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

type ExecuteCallbacks = {
  scheduleDrive: DriverV2DriveScheduler;
  driveDialog: DriverV2DriveInvoker;
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

function ensureCallbacks(callbacks: ExecuteCallbacks | undefined): ExecuteCallbacks {
  if (!callbacks) {
    throw new Error('driver-v2 tellask executor requires drive callbacks');
  }
  return callbacks;
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
  const runState = latest?.runState;
  if (!runState || runState.kind !== 'dead') {
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
  agent: Team.Member,
  mentionList: string[] | undefined,
  body: string,
  callId: string,
  callbacks: ExecuteCallbacks,
  options: {
    callName: TellaskSpecialCall['callName'];
    parseResult: TeammateTellaskParseResult | null;
    targetForError?: string;
    collectiveTargets?: string[];
    q4hRemainingCallIds?: string[];
    fbrEffortOverride?: number;
  },
): Promise<{
  toolOutputs: ChatMessage[];
  suspend: boolean;
  subdialogsCreated: TDialogID[];
}> {
  const toolOutputs: ChatMessage[] = [];
  let suspend = false;
  const subdialogsCreated: TDialogID[] = [];
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
      return { toolOutputs, suspend: true, subdialogsCreated: [] };
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
      await dlg.receiveTeammateCallResult(
        'dominds',
        callName,
        mentionList,
        body,
        msg,
        'failed',
        callId,
      );
      dlg.clearCurrentCallId();
      return { toolOutputs, suspend: false, subdialogsCreated: [] };
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
        ? Math.floor(rawCallingCourse)
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
      await dlg.receiveTeammateCallResult(
        'dominds',
        callName,
        mentionList,
        body,
        msg,
        'failed',
        callId,
      );
      dlg.clearCurrentCallId();
      return { toolOutputs, suspend: false, subdialogsCreated: [] };
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
        await dlg.receiveTeammateCallResult(
          'dominds',
          callName,
          mentionList,
          body,
          msg,
          'failed',
          callId,
        );
        dlg.clearCurrentCallId();
        return { toolOutputs, suspend: false, subdialogsCreated: [] };
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
        await dlg.receiveTeammateCallResult(
          'dominds',
          callName,
          mentionList,
          body,
          msg,
          'failed',
          callId,
        );
        dlg.clearCurrentCallId();
        return { toolOutputs, suspend: false, subdialogsCreated: [] };
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
        await dlg.receiveTeammateCallResult(
          'dominds',
          callName,
          mentionList,
          body,
          msg,
          'failed',
          callId,
        );
        dlg.clearCurrentCallId();
        return { toolOutputs, suspend: false, subdialogsCreated: [] };
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
      subdialogsCreated.push(sub.id);

      for (let i = 1; i <= fbrEffort; i++) {
        const instanceBody = buildRoundBody(i, fbrEffort);

        const isFinalRound = i === fbrEffort;
        const shouldReplyToCaller = isFinalRound;

        if (shouldReplyToCaller) {
          const pendingRecord: PendingSubdialogRecordType = {
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
            await DialogPersistence.appendPendingSubdialog(dlg.id, pendingRecord);
          });
          await syncPendingTellaskReminderBestEffort(
            dlg,
            'driver-v2:executeTellaskCall:FBR-TypeC:appendPending:lastRound',
          );
        }

        const initPrompt: DriverV2HumanPrompt = {
          content: formatAssignmentFromSupdialog({
            callName: subdialogCallName,
            fromAgentId: dlg.agentId,
            toAgentId: sub.agentId,
            mentionList,
            tellaskContent: instanceBody,
            language: workLanguage,
            collectiveTargets: [sub.agentId],
            fbrRound: {
              iteration: i,
              total: fbrEffort,
            },
          }),
          msgId: generateShortId(),
          grammar: 'markdown',
          ...(shouldReplyToCaller
            ? {
                subdialogReplyTarget: {
                  ownerDialogId: callerDialog.id.selfId,
                  callType: 'C',
                  callId,
                },
              }
            : {}),
        };
        try {
          await callbacks.driveDialog(sub, { humanPrompt: initPrompt, waitInQue: true });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          log.error('FBR Type C serial drive failed', error, {
            rootId: dlg.id.rootId,
            ownerDialogId: callerDialog.id.selfId,
            subdialogId: sub.id.selfId,
            iteration: i,
            total: fbrEffort,
            callName: subdialogCallName,
            callId,
            detail,
          });
          throw new Error(`FBR serial round ${i}/${fbrEffort} failed: ${detail}`);
        }
      }

      // FBR Type-C rounds are driven inline via callbacks.driveDialog(...), and the final round
      // may already have supplied a teammate response back to the caller before we return here.
      // Suspending unconditionally in that case would stop the caller turn and can race with
      // backend-loop queue cleanup (needsDrive gets cleared as "idle"), dropping continuation.
      // Only suspend when there is still a pending response record for this call.
      const hasPendingFbrResponse = await withSubdialogTxnLock(dlg.id, async () => {
        const pending = await DialogPersistence.loadPendingSubdialogs(dlg.id, dlg.status);
        return pending.some(
          (record) =>
            record.callId === callId &&
            record.callType === 'C' &&
            record.subdialogId === sub.id.selfId,
        );
      });

      return { toolOutputs, suspend: hasPendingFbrResponse, subdialogsCreated };
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
      await dlg.receiveTeammateCallResult(
        'dominds',
        callName,
        mentionList,
        body,
        msg,
        'failed',
        callId,
      );
      dlg.clearCurrentCallId();
      return { toolOutputs, suspend: false, subdialogsCreated: [] };
    }

    if (parseResult.type === 'A') {
      if (dlg instanceof SubDialog) {
        const supdialog = dlg.supdialog;
        dlg.setSuspensionState('suspended');

        try {
          const assignment = dlg.assignmentFromSup;
          const supPrompt: DriverV2HumanPrompt = {
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
          };
          await callbacks.driveDialog(supdialog, { humanPrompt: supPrompt, waitInQue: true });

          const responseText = await extractSupdialogResponseForTypeA(supdialog);
          const responseContent = responseText;

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
          await dlg.receiveTeammateResponse(
            parseResult.agentId,
            callName,
            mentionList,
            body,
            'completed',
            supdialog.id,
            {
              response: responseText,
              agentId: parseResult.agentId,
              callId,
              originMemberId: dlg.agentId,
            },
          );
        } catch (err) {
          log.warn('Type A supdialog processing error:', err);
          dlg.setSuspensionState('resumed');
          const errorText = `❌ **Error processing request to @${parseResult.agentId}:**\n\n${showErrorToAi(err)}`;
          toolOutputs.push({
            type: 'tellask_result_msg',
            role: 'tool',
            responderId: parseResult.agentId,
            mentionList,
            tellaskContent: body,
            status: 'failed',
            callId,
            content: errorText,
          });
          await dlg.receiveTeammateResponse(
            parseResult.agentId,
            callName,
            mentionList,
            body,
            'failed',
            supdialog.id,
            {
              response: errorText,
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

          const pendingRecord: PendingSubdialogRecordType = {
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
            await DialogPersistence.appendPendingSubdialog(dlg.id, pendingRecord);
          });
          await syncPendingTellaskReminderBestEffort(
            dlg,
            'driver-v2:executeTellaskCall:TypeB-fallback:appendPending',
          );

          const initPrompt: DriverV2HumanPrompt = {
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
            subdialogReplyTarget: {
              ownerDialogId: callerDialog.id.selfId,
              callType: 'C',
              callId,
            },
          };
          callbacks.scheduleDrive(sub, { humanPrompt: initPrompt, waitInQue: true });
          subdialogsCreated.push(sub.id);
          suspend = true;
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

        const result = await withSubdialogTxnLock(rootDialog.id, async () => {
          const existing = await lookupLiveRegisteredSubdialog(
            rootDialog,
            parseResult.agentId,
            parseResult.sessionSlug,
          );
          if (existing) {
            try {
              await updateSubdialogAssignment(existing, assignment);
            } catch (err) {
              log.warn('Failed to update registered subdialog assignment', err);
            }
            return { kind: 'existing' as const, subdialog: existing };
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
          return { kind: 'created' as const, subdialog: created };
        });

        const pendingRecord: PendingSubdialogRecordType = {
          subdialogId: result.subdialog.id.selfId,
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
        await withSubdialogTxnLock(pendingOwner.id, async () => {
          await DialogPersistence.mutatePendingSubdialogs(pendingOwner.id, (previous) => {
            const next = previous.filter((p) => p.subdialogId !== pendingRecord.subdialogId);
            next.push(pendingRecord);
            return { kind: 'replace', records: next };
          });
        });
        await syncPendingTellaskReminderBestEffort(
          pendingOwner,
          'driver-v2:executeTellaskCall:TypeB:replacePending',
        );

        if (result.kind === 'existing') {
          const resumePrompt: DriverV2HumanPrompt = {
            content: formatAssignmentFromSupdialog({
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
            subdialogReplyTarget: {
              ownerDialogId: pendingOwner.id.selfId,
              callType: 'B',
              callId,
            },
          };
          callbacks.scheduleDrive(result.subdialog, { humanPrompt: resumePrompt, waitInQue: true });
        } else {
          const initPrompt: DriverV2HumanPrompt = {
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
            subdialogReplyTarget: {
              ownerDialogId: pendingOwner.id.selfId,
              callType: 'B',
              callId,
            },
          };
          callbacks.scheduleDrive(result.subdialog, { humanPrompt: initPrompt, waitInQue: true });
        }

        subdialogsCreated.push(result.subdialog.id);
        suspend = true;
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
        const pendingRecord: PendingSubdialogRecordType = {
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
          await DialogPersistence.appendPendingSubdialog(dlg.id, pendingRecord);
        });
        await syncPendingTellaskReminderBestEffort(
          dlg,
          'driver-v2:executeTellaskCall:TypeC:appendPending',
        );

        const initPrompt: DriverV2HumanPrompt = {
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
          subdialogReplyTarget: {
            ownerDialogId: dlg.id.selfId,
            callType: 'C',
            callId,
          },
        };
        callbacks.scheduleDrive(sub, { humanPrompt: initPrompt, waitInQue: true });
        subdialogsCreated.push(sub.id);
        suspend = true;
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
    await dlg.receiveTeammateCallResult(
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

  return { toolOutputs, suspend, subdialogsCreated };
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
  agent: Team.Member;
  calls: readonly ExecutableValidTellaskCall[];
  callbacks: ExecuteCallbacks;
  emitCallEvents: boolean;
}): Promise<{ suspend: boolean; toolOutputs: ChatMessage[]; subdialogsCreated: DialogID[] }> {
  const executionCalls = normalizeQ4HCalls(args.calls, args.dlg);
  const results: Array<{
    toolOutputs: ChatMessage[];
    suspend: boolean;
    subdialogsCreated: TDialogID[];
  }> = [];
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
    if (args.emitCallEvents) {
      const sessionSlug = call.callName === 'tellask' ? call.sessionSlug : undefined;
      await emitTellaskSpecialCallEvents({
        dlg: args.dlg,
        callName: call.callName,
        mentionList: runtimeMentionList,
        sessionSlug,
        tellaskContent: call.tellaskContent,
        callId: call.callId,
      });
    }
    let targetForError: string | undefined;
    let parseResult: TeammateTellaskParseResult | null;
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
    const result = await executeTellaskCall(
      args.dlg,
      args.agent,
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
    results.push(result);
  }

  return {
    suspend: results.some((result) => result.suspend),
    toolOutputs: results.flatMap((result) => result.toolOutputs),
    subdialogsCreated: results.flatMap((result) => result.subdialogsCreated),
  };
}

export async function executeTellaskSpecialCalls(args: {
  dlg: Dialog;
  agent: Team.Member;
  calls: readonly TellaskSpecialCall[];
  callbacks?: {
    scheduleDrive: DriverV2DriveScheduler;
    driveDialog: DriverV2DriveInvoker;
  };
}): Promise<{
  suspend: boolean;
  toolOutputs: ChatMessage[];
  subdialogsCreated: DialogID[];
}> {
  const callbacks = ensureCallbacks(args.callbacks);
  if (args.calls.length === 0) {
    return { suspend: false, toolOutputs: [], subdialogsCreated: [] };
  }

  const tellaskResult = await executeValidTellaskCalls({
    dlg: args.dlg,
    agent: args.agent,
    calls: args.calls.map((call) => toExecutableValidTellaskCall(call)),
    callbacks,
    emitCallEvents: true,
  });

  return {
    suspend: tellaskResult.suspend,
    toolOutputs: tellaskResult.toolOutputs,
    subdialogsCreated: tellaskResult.subdialogsCreated,
  };
}
