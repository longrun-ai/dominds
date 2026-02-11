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
  formatDomindsNoteInvalidMultiTeammateTargets,
  formatDomindsNoteInvalidTellaskSessionDirective,
  formatDomindsNoteMultipleTellaskSessionDirectives,
  formatDomindsNoteQ4HRegisterFailed,
  formatDomindsNoteTellaskForTeammatesOnly,
} from '../../shared/i18n/driver-messages';
import { getWorkLanguage } from '../../shared/runtime-language';
import type { NewQ4HAskedEvent } from '../../shared/types/dialog';
import type { HumanQuestion } from '../../shared/types/storage';
import { generateShortId } from '../../shared/utils/id';
import {
  formatAssignmentFromSupdialog,
  formatSupdialogCallPrompt,
  formatTeammateResponseContent,
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
  mentionList: string[];
  tellaskContent: string;
  targetAgentId: string;
  callId: string;
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
] as const;

export type TellaskSpecialFunctionName = (typeof TELLASK_SPECIAL_FUNCTION_NAMES)[number];

export type TellaskSpecialCall =
  | Readonly<{
      kind: 'tellaskBack';
      callId: string;
      callName: 'tellaskBack';
      mentionList: string[];
      tellaskContent: string;
    }>
  | Readonly<{
      kind: 'tellask';
      callId: string;
      callName: 'tellask';
      targetAgentId: string;
      sessionSlug: string;
      mentionList: string[];
      tellaskContent: string;
    }>
  | Readonly<{
      kind: 'tellaskSessionless';
      callId: string;
      callName: 'tellaskSessionless';
      targetAgentId: string;
      mentionList: string[];
      tellaskContent: string;
    }>
  | Readonly<{
      kind: 'askHuman';
      callId: string;
      callName: 'askHuman';
      mentionList: string[];
      tellaskContent: string;
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
          kind: 'tellaskBack',
          callId: call.id,
          callName: 'tellaskBack',
          mentionList: ['@upstream'],
          tellaskContent: tellaskContent.value,
        },
      };
    }
    case 'askHuman': {
      return {
        ok: true,
        value: {
          kind: 'askHuman',
          callId: call.id,
          callName: 'askHuman',
          mentionList: ['@human'],
          tellaskContent: tellaskContent.value,
        },
      };
    }
    case 'tellask': {
      const target = readTargetAgentId(args);
      if (!target.ok) {
        return target;
      }
      const sessionSlug = readRequiredStringField(args, 'sessionSlug');
      if (!sessionSlug.ok) {
        return sessionSlug;
      }
      return {
        ok: true,
        value: {
          kind: 'tellask',
          callId: call.id,
          callName: 'tellask',
          targetAgentId: target.value,
          sessionSlug: sessionSlug.value,
          mentionList: [`@${target.value}`],
          tellaskContent: tellaskContent.value,
        },
      };
    }
    case 'tellaskSessionless': {
      const target = readTargetAgentId(args);
      if (!target.ok) {
        return target;
      }
      return {
        ok: true,
        value: {
          kind: 'tellaskSessionless',
          callId: call.id,
          callName: 'tellaskSessionless',
          targetAgentId: target.value,
          mentionList: [`@${target.value}`],
          tellaskContent: tellaskContent.value,
        },
      };
    }
  }
}

export function classifyTellaskSpecialFunctionCalls(funcCalls: readonly FuncCallMsg[]): {
  specialCalls: TellaskSpecialCall[];
  normalCalls: FuncCallMsg[];
  parseIssues: TellaskSpecialCallParseIssue[];
} {
  const specialCalls: TellaskSpecialCall[] = [];
  const normalCalls: FuncCallMsg[] = [];
  const parseIssues: TellaskSpecialCallParseIssue[] = [];

  for (const call of funcCalls) {
    if (!isTellaskSpecialFunctionName(call.name)) {
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
    log.warn('Failed to sync pending tellask reminder', {
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

type TellaskSessionDirectiveParse =
  | { kind: 'none' }
  | { kind: 'one'; sessionSlug: string }
  | { kind: 'invalid' }
  | { kind: 'multiple' };

function parseSessionSlugDirectiveFromHeadline(tellaskHead: string): TellaskSessionDirectiveParse {
  const re = /(^|\s)!tellaskSession\s+([^\s]+)/g;
  const ids: string[] = [];
  for (const match of tellaskHead.matchAll(re)) {
    const raw = match[2] ?? '';
    const candidate = raw.trim();
    const m = candidate.match(/^([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*)/);
    const sessionSlug = (m?.[1] ?? '').trim();
    if (!isValidSessionSlug(sessionSlug)) {
      return { kind: 'invalid' };
    }
    ids.push(sessionSlug);
  }

  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return { kind: 'none' };
  if (unique.length === 1) return { kind: 'one', sessionSlug: unique[0] ?? '' };
  return { kind: 'multiple' };
}

function extractSingleSessionSlugFromHeadline(tellaskHead: string): string | null {
  const parsed = parseSessionSlugDirectiveFromHeadline(tellaskHead);
  if (parsed.kind === 'one') return parsed.sessionSlug;
  return null;
}

export function parseTeammateTellask(
  firstMention: string,
  tellaskHead: string,
  currentDialog?: Dialog,
): TeammateTellaskParseResult {
  if (firstMention === 'self') {
    const agentId = currentDialog?.agentId ?? 'self';
    const sessionSlug = extractSingleSessionSlugFromHeadline(tellaskHead);
    if (sessionSlug) {
      return {
        type: 'B',
        agentId,
        sessionSlug,
      };
    }
    return {
      type: 'C',
      agentId,
    };
  }

  const sessionSlug = extractSingleSessionSlugFromHeadline(tellaskHead);
  if (sessionSlug) {
    return {
      type: 'B',
      agentId: firstMention,
      sessionSlug,
    };
  }

  if (
    currentDialog &&
    currentDialog.supdialog &&
    firstMention === currentDialog.supdialog.agentId
  ) {
    return {
      type: 'A',
      agentId: firstMention,
    };
  }

  return {
    type: 'C',
    agentId: firstMention,
  };
}

function resolveFbrEffort(member: Team.Member | null | undefined): number {
  const raw = member?.fbr_effort;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  if (!Number.isInteger(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 100) return 0;
  return raw;
}

let agentPrimingModulePromise: Promise<typeof import('../../agent-priming')> | null = null;

async function scheduleInheritedAgentPrimingForSubdialog(
  callerDialog: Dialog,
  subdialog: SubDialog,
): Promise<void> {
  const rootDialog =
    callerDialog instanceof RootDialog
      ? callerDialog
      : callerDialog instanceof SubDialog
        ? callerDialog.rootDialog
        : undefined;
  if (!rootDialog) return;
  const inheritedMode = rootDialog.subdialogAgentPrimingMode;
  if (inheritedMode === 'skip') return;
  if (!agentPrimingModulePromise) {
    agentPrimingModulePromise = import('../../agent-priming');
  }
  const agentPrimingModule = await agentPrimingModulePromise;
  await agentPrimingModule.scheduleAgentPrimingForNewDialog(subdialog, { mode: inheritedMode });
}

type SubdialogCreateOptions = {
  originMemberId: string;
  callerDialogId: string;
  callId: string;
  sessionSlug?: string;
  collectiveTargets?: string[];
};

async function createSubDialogWithInheritedPriming(
  callerDialog: Dialog,
  targetAgentId: string,
  mentionList: string[],
  tellaskContent: string,
  options: SubdialogCreateOptions,
): Promise<SubDialog> {
  const subdialog = await callerDialog.createSubDialog(
    targetAgentId,
    mentionList,
    tellaskContent,
    options,
  );
  await scheduleInheritedAgentPrimingForSubdialog(callerDialog, subdialog);
  return subdialog;
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
  log.info('Pruned dead registered subdialog from Type B registry', undefined, {
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
    log.warn('Failed to extract supdialog response for Type A', { error: err });
    return 'Supdialog completed with errors.';
  }
}

function isValidMentionChar(char: string): boolean {
  const charCode = char.charCodeAt(0);
  return (
    (charCode >= 48 && charCode <= 57) ||
    (charCode >= 65 && charCode <= 90) ||
    (charCode >= 97 && charCode <= 122) ||
    char === '_' ||
    char === '-' ||
    char === '.' ||
    /\p{L}/u.test(char) ||
    /\p{N}/u.test(char)
  );
}

function trimTrailingDots(value: string): string {
  let out = value;
  while (out.endsWith('.')) out = out.slice(0, -1);
  return out;
}

function isMentionBoundaryChar(char: string): boolean {
  if (char === '' || char === '\n' || char === '\t' || char === ' ') return true;
  return !isValidMentionChar(char);
}

function extractMentionIdsFromHeadline(tellaskHead: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < tellaskHead.length; i++) {
    const ch = tellaskHead[i] ?? '';
    if (ch !== '@') continue;
    const prev = i === 0 ? '' : (tellaskHead[i - 1] ?? '');
    if (!isMentionBoundaryChar(prev)) continue;

    let j = i + 1;
    let raw = '';
    while (j < tellaskHead.length) {
      const c = tellaskHead[j] ?? '';
      if (c !== '' && isValidMentionChar(c)) {
        raw += c;
        j += 1;
        continue;
      }
      break;
    }

    const id = trimTrailingDots(raw);
    if (id === '') continue;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
    i = j - 1;
  }
  return out;
}

function mentionListFromTellaskHead(tellaskHead: string, fallbackMention: string): string[] {
  const ids = extractMentionIdsFromHeadline(tellaskHead);
  if (ids.length > 0) {
    return ids.map((id) => `@${id}`);
  }
  return [`@${fallbackMention}`];
}

async function executeTellaskCall(
  dlg: Dialog,
  agent: Team.Member,
  firstMention: string,
  tellaskHead: string,
  body: string,
  callId: string,
  callbacks: ExecuteCallbacks,
  options?: {
    allowMultiTeammateTargets?: boolean;
    collectiveTargets?: string[];
    skipTellaskSessionDirectiveValidation?: boolean;
    q4hRemainingCallIds?: string[];
    callKind?: TellaskSpecialCall['kind'];
    mentionListOverride?: string[];
    forcedParseResult?: TeammateTellaskParseResult | null;
  },
): Promise<{
  toolOutputs: ChatMessage[];
  suspend: boolean;
  subdialogsCreated: TDialogID[];
}> {
  const toolOutputs: ChatMessage[] = [];
  let suspend = false;
  const subdialogsCreated: TDialogID[] = [];
  const mentionList =
    options?.mentionListOverride ?? mentionListFromTellaskHead(tellaskHead, firstMention);
  const callKind = options?.callKind;
  const hasForcedParseResult = options?.forcedParseResult !== undefined;

  const team = await Team.load();
  const isSelfAlias = firstMention === 'self';
  const member = isSelfAlias ? team.getMember(dlg.agentId) : team.getMember(firstMention);

  const allowMultiTeammateTargets =
    (options?.allowMultiTeammateTargets ?? true) && !hasForcedParseResult;
  if (allowMultiTeammateTargets && member && !isSelfAlias && callKind !== 'tellaskBack') {
    const mentioned = extractMentionIdsFromHeadline(tellaskHead);
    const uniqueMentioned = Array.from(new Set(mentioned));
    const knownTargets = uniqueMentioned.filter((id) => team.getMember(id) !== null);
    if (!knownTargets.includes(firstMention)) {
      knownTargets.unshift(firstMention);
    }

    if (knownTargets.length >= 2) {
      const unknown = uniqueMentioned.filter(
        (id) => team.getMember(id) === null && id !== 'self' && id !== 'human' && id !== 'dominds',
      );
      if (unknown.length > 0) {
        const msg = formatDomindsNoteInvalidMultiTeammateTargets(getWorkLanguage(), { unknown });
        toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
        toolOutputs.push({
          type: 'tellask_result_msg',
          role: 'tool',
          responderId: 'dominds',
          mentionList,
          tellaskContent: body,
          status: 'failed',
          callId,
          content: msg,
        });
        await dlg.receiveTeammateCallResult('dominds', mentionList, body, msg, 'failed', callId);
        dlg.clearCurrentCallId();
        return { toolOutputs, suspend: false, subdialogsCreated: [] };
      }

      if (!hasForcedParseResult && options?.skipTellaskSessionDirectiveValidation !== true) {
        const sessionSlugDirective = parseSessionSlugDirectiveFromHeadline(tellaskHead);
        if (sessionSlugDirective.kind === 'multiple') {
          const msg = formatDomindsNoteMultipleTellaskSessionDirectives(getWorkLanguage());
          toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
          toolOutputs.push({
            type: 'tellask_result_msg',
            role: 'tool',
            responderId: 'dominds',
            mentionList,
            tellaskContent: body,
            status: 'failed',
            callId,
            content: msg,
          });
          await dlg.receiveTeammateCallResult('dominds', mentionList, body, msg, 'failed', callId);
          dlg.clearCurrentCallId();
          return { toolOutputs, suspend: false, subdialogsCreated: [] };
        }
        if (sessionSlugDirective.kind === 'invalid') {
          const msg = formatDomindsNoteInvalidTellaskSessionDirective(getWorkLanguage());
          toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
          toolOutputs.push({
            type: 'tellask_result_msg',
            role: 'tool',
            responderId: 'dominds',
            mentionList,
            tellaskContent: body,
            status: 'failed',
            callId,
            content: msg,
          });
          await dlg.receiveTeammateCallResult('dominds', mentionList, body, msg, 'failed', callId);
          dlg.clearCurrentCallId();
          return { toolOutputs, suspend: false, subdialogsCreated: [] };
        }
      }

      const perTargetResults = await Promise.all(
        knownTargets.map(async (targetId) => {
          return await executeTellaskCall(
            dlg,
            agent,
            targetId,
            tellaskHead,
            body,
            callId,
            callbacks,
            {
              allowMultiTeammateTargets: false,
              collectiveTargets: knownTargets,
              skipTellaskSessionDirectiveValidation: true,
            },
          );
        }),
      );

      return {
        toolOutputs: perTargetResults.flatMap((r) => r.toolOutputs),
        suspend: perTargetResults.some((r) => r.suspend),
        subdialogsCreated: perTargetResults.flatMap((r) => r.subdialogsCreated),
      };
    }
  }

  const isQ4H = callKind === 'askHuman';
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
        mentionList,
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
          mentionList: question.mentionList,
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
        mentionList: mentionList.join(' '),
      });

      const msg = formatDomindsNoteQ4HRegisterFailed(getWorkLanguage(), { error: errMsg });
      toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
      toolOutputs.push({
        type: 'tellask_result_msg',
        role: 'tool',
        responderId: 'dominds',
        mentionList,
        tellaskContent: body,
        status: 'failed',
        callId,
        content: msg,
      });
      await dlg.receiveTeammateCallResult('dominds', mentionList, body, msg, 'failed', callId);
      dlg.clearCurrentCallId();
      return { toolOutputs, suspend: false, subdialogsCreated: [] };
    }
  }

  if (member || isSelfAlias || callKind === 'tellaskBack') {
    if (!hasForcedParseResult && options?.skipTellaskSessionDirectiveValidation !== true) {
      const sessionSlugDirective = parseSessionSlugDirectiveFromHeadline(tellaskHead);
      if (sessionSlugDirective.kind === 'multiple') {
        const msg = formatDomindsNoteMultipleTellaskSessionDirectives(getWorkLanguage());
        toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
        toolOutputs.push({
          type: 'tellask_result_msg',
          role: 'tool',
          responderId: 'dominds',
          mentionList,
          tellaskContent: body,
          status: 'failed',
          callId,
          content: msg,
        });
        await dlg.receiveTeammateCallResult('dominds', mentionList, body, msg, 'failed', callId);
        dlg.clearCurrentCallId();
        return { toolOutputs, suspend: false, subdialogsCreated: [] };
      }
      if (sessionSlugDirective.kind === 'invalid') {
        const msg = formatDomindsNoteInvalidTellaskSessionDirective(getWorkLanguage());
        toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
        toolOutputs.push({
          type: 'tellask_result_msg',
          role: 'tool',
          responderId: 'dominds',
          mentionList,
          tellaskContent: body,
          status: 'failed',
          callId,
          content: msg,
        });
        await dlg.receiveTeammateCallResult('dominds', mentionList, body, msg, 'failed', callId);
        dlg.clearCurrentCallId();
        return { toolOutputs, suspend: false, subdialogsCreated: [] };
      }
    }

    const parseResult: TeammateTellaskParseResult | null =
      options?.forcedParseResult ??
      (callKind === 'tellaskBack'
        ? dlg instanceof SubDialog
          ? { type: 'A', agentId: dlg.supdialog.agentId }
          : null
        : parseTeammateTellask(firstMention, tellaskHead, dlg));
    if (!parseResult) {
      const msg = formatDomindsNoteTellaskForTeammatesOnly(getWorkLanguage(), { firstMention });
      toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
      toolOutputs.push({
        type: 'tellask_result_msg',
        role: 'tool',
        responderId: 'dominds',
        mentionList,
        tellaskContent: body,
        status: 'failed',
        callId,
        content: msg,
      });
      await dlg.receiveTeammateCallResult('dominds', mentionList, body, msg, 'failed', callId);
      dlg.clearCurrentCallId();
      return { toolOutputs, suspend: false, subdialogsCreated: [] };
    }

    if (isSelfAlias) {
      const fbrEffort = resolveFbrEffort(member);
      if (fbrEffort < 1) {
        const msg = formatDomindsNoteFbrDisabled(getWorkLanguage());
        toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
        toolOutputs.push({
          type: 'tellask_result_msg',
          role: 'tool',
          responderId: 'dominds',
          mentionList,
          tellaskContent: body,
          status: 'failed',
          callId,
          content: msg,
        });
        await dlg.receiveTeammateCallResult('dominds', mentionList, body, msg, 'failed', callId);
        dlg.clearCurrentCallId();
        return { toolOutputs, suspend: false, subdialogsCreated: [] };
      }

      const callerDialog = dlg;
      const originMemberId = dlg.agentId;

      if (parseResult.type === 'C') {
        const createdSubs: SubDialog[] = [];
        const pendingRecords: PendingSubdialogRecordType[] = [];
        for (let i = 1; i <= fbrEffort; i++) {
          const sub = await createSubDialogWithInheritedPriming(
            dlg,
            parseResult.agentId,
            mentionList,
            body,
            {
              originMemberId,
              callerDialogId: callerDialog.id.selfId,
              callId,
              collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
            },
          );
          createdSubs.push(sub);
          pendingRecords.push({
            subdialogId: sub.id.selfId,
            createdAt: formatUnifiedTimestamp(new Date()),
            mentionList,
            tellaskContent: body,
            targetAgentId: parseResult.agentId,
            callId,
            callType: 'C',
          });
        }

        await withSubdialogTxnLock(dlg.id, async () => {
          await DialogPersistence.mutatePendingSubdialogs(dlg.id, (previous) => ({
            kind: 'replace',
            records: [...previous, ...pendingRecords],
          }));
        });
        await syncPendingTellaskReminderBestEffort(
          dlg,
          'driver-v2:executeTellaskCall:FBR-TypeC:replacePending',
        );

        for (const sub of createdSubs) {
          const initPrompt: DriverV2HumanPrompt = {
            content: formatAssignmentFromSupdialog({
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
        }

        return { toolOutputs, suspend: true, subdialogsCreated };
      }

      if (parseResult.type === 'B') {
        let rootDialog: RootDialog | undefined;
        if (dlg instanceof RootDialog) {
          rootDialog = dlg;
        } else if (dlg instanceof SubDialog) {
          rootDialog = dlg.rootDialog;
        }

        if (!rootDialog) {
          const msg = formatDomindsNoteFbrToollessViolation(getWorkLanguage(), {
            kind: 'internal_error',
          });
          toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
          toolOutputs.push({
            type: 'tellask_result_msg',
            role: 'tool',
            responderId: 'dominds',
            mentionList,
            tellaskContent: body,
            status: 'failed',
            callId,
            content: msg,
          });
          await dlg.receiveTeammateCallResult('dominds', mentionList, body, msg, 'failed', callId);
          dlg.clearCurrentCallId();
          return { toolOutputs, suspend: false, subdialogsCreated: [] };
        }

        const pendingOwner = callerDialog;
        const baseSession = parseResult.sessionSlug;
        const derivedPrefix = `${baseSession}.fbr-`;

        const createdOrExisting = await withSubdialogTxnLock(rootDialog.id, async () => {
          const results: Array<{
            kind: 'existing' | 'created';
            subdialog: SubDialog;
            sessionSlug: string;
            indexedHeadLine: string;
          }> = [];

          const ensurePoolSessions = (desired: number): string[] => {
            if (desired <= 1) return [baseSession];
            const set = new Set<string>();
            for (const sub of rootDialog.getRegisteredSubdialogs()) {
              const sessionSlug = sub.sessionSlug;
              if (typeof sessionSlug !== 'string') continue;
              if (sub.agentId !== parseResult.agentId) continue;
              if (!sessionSlug.startsWith(derivedPrefix)) continue;
              set.add(sessionSlug);
            }
            while (set.size < desired) {
              const candidate = `${derivedPrefix}${generateShortId()}`;
              set.add(candidate);
            }
            const pool = Array.from(set);
            for (let i = pool.length - 1; i >= 1; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              const tmp = pool[i];
              pool[i] = pool[j] ?? '';
              pool[j] = tmp ?? '';
            }
            return pool.slice(0, desired);
          };

          const sessions = ensurePoolSessions(fbrEffort);
          for (const derivedSession of sessions) {
            const indexedHeadLine = tellaskHead;

            const assignment: AssignmentFromSup = {
              mentionList: mentionListFromTellaskHead(indexedHeadLine, firstMention),
              tellaskContent: body,
              originMemberId,
              callerDialogId: callerDialog.id.selfId,
              callId,
              collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
            };

            const existing = await lookupLiveRegisteredSubdialog(
              rootDialog,
              parseResult.agentId,
              derivedSession,
            );
            if (existing) {
              try {
                await updateSubdialogAssignment(existing, assignment);
              } catch (err) {
                log.warn('Failed to update registered FBR subdialog assignment', err);
              }
              results.push({
                kind: 'existing',
                subdialog: existing,
                sessionSlug: derivedSession,
                indexedHeadLine,
              });
              continue;
            }

            const created = await createSubDialogWithInheritedPriming(
              rootDialog,
              parseResult.agentId,
              mentionListFromTellaskHead(indexedHeadLine, firstMention),
              body,
              {
                originMemberId,
                callerDialogId: callerDialog.id.selfId,
                callId,
                sessionSlug: derivedSession,
                collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
              },
            );
            rootDialog.registerSubdialog(created);
            results.push({
              kind: 'created',
              subdialog: created,
              sessionSlug: derivedSession,
              indexedHeadLine,
            });
          }

          await rootDialog.saveSubdialogRegistry();
          return results;
        });

        const pendingRecords: PendingSubdialogRecordType[] = createdOrExisting.map((r) => ({
          subdialogId: r.subdialog.id.selfId,
          createdAt: formatUnifiedTimestamp(new Date()),
          mentionList: mentionListFromTellaskHead(r.indexedHeadLine, firstMention),
          tellaskContent: body,
          targetAgentId: parseResult.agentId,
          callId,
          callType: 'B',
          sessionSlug: r.sessionSlug,
        }));
        await withSubdialogTxnLock(pendingOwner.id, async () => {
          const toRemove = new Set(pendingRecords.map((p) => p.subdialogId));
          await DialogPersistence.mutatePendingSubdialogs(pendingOwner.id, (previous) => {
            const next = previous.filter((p) => !toRemove.has(p.subdialogId));
            next.push(...pendingRecords);
            return { kind: 'replace', records: next };
          });
        });
        await syncPendingTellaskReminderBestEffort(
          pendingOwner,
          'driver-v2:executeTellaskCall:FBR-TypeB:replacePending',
        );

        for (const r of createdOrExisting) {
          const prompt: DriverV2HumanPrompt = {
            content: formatAssignmentFromSupdialog({
              fromAgentId: dlg.agentId,
              toAgentId: r.subdialog.agentId,
              mentionList: mentionListFromTellaskHead(r.indexedHeadLine, firstMention),
              tellaskContent: body,
              language: getWorkLanguage(),
              collectiveTargets: options?.collectiveTargets ?? [r.subdialog.agentId],
            }),
            msgId: generateShortId(),
            grammar: 'markdown',
            subdialogReplyTarget: {
              ownerDialogId: pendingOwner.id.selfId,
              callType: 'B',
              callId,
            },
          };
          callbacks.scheduleDrive(r.subdialog, { humanPrompt: prompt, waitInQue: true });
          subdialogsCreated.push(r.subdialog.id);
        }

        return { toolOutputs, suspend: true, subdialogsCreated };
      }
    }

    const isDirectSelfCall =
      !isSelfAlias && callKind !== 'tellaskBack' && parseResult.agentId === dlg.agentId;
    if (isDirectSelfCall) {
      const response = formatDomindsNoteDirectSelfCall(getWorkLanguage());
      try {
        await dlg.receiveTeammateResponse('dominds', mentionList, body, 'completed', dlg.id, {
          response,
          agentId: 'dominds',
          callId,
          originMemberId: dlg.agentId,
        });
      } catch (err) {
        log.warn('Failed to emit self-tellask correction response', err, {
          dialogId: dlg.id.selfId,
          agentId: dlg.agentId,
        });
      }
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
                mentionList,
                tellaskContent: body,
              },
              supdialogAssignment: {
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
          const responseContent = formatTeammateResponseContent({
            responderId: parseResult.agentId,
            requesterId: dlg.agentId,
            mentionList,
            tellaskContent: body,
            responseBody: responseText,
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
          await dlg.receiveTeammateResponse(
            parseResult.agentId,
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
        log.warn('Type A call on dialog without supdialog, falling back to Type C', {
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
        log.warn('Type B call without root dialog, falling back to Type C', {
          dialogId: dlg.id.selfId,
        });
        try {
          const sub = await createSubDialogWithInheritedPriming(
            dlg,
            parseResult.agentId,
            mentionList,
            body,
            {
              originMemberId: dlg.agentId,
              callerDialogId: callerDialog.id.selfId,
              callId,
              sessionSlug: parseResult.sessionSlug,
              collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
            },
          );

          const pendingRecord: PendingSubdialogRecordType = {
            subdialogId: sub.id.selfId,
            createdAt: formatUnifiedTimestamp(new Date()),
            mentionList,
            tellaskContent: body,
            targetAgentId: parseResult.agentId,
            callId,
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

          const created = await createSubDialogWithInheritedPriming(
            rootDialog,
            parseResult.agentId,
            mentionList,
            body,
            {
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
          mentionList,
          tellaskContent: body,
          targetAgentId: parseResult.agentId,
          callId,
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
              fromAgentId: dlg.agentId,
              toAgentId: result.subdialog.agentId,
              mentionList,
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
              fromAgentId: rootDialog.agentId,
              toAgentId: result.subdialog.agentId,
              mentionList,
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
        const sub = await createSubDialogWithInheritedPriming(
          dlg,
          parseResult.agentId,
          mentionList,
          body,
          {
            originMemberId: dlg.agentId,
            callerDialogId: dlg.id.selfId,
            callId,
            collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
          },
        );
        const pendingRecord: PendingSubdialogRecordType = {
          subdialogId: sub.id.selfId,
          createdAt: formatUnifiedTimestamp(new Date()),
          mentionList,
          tellaskContent: body,
          targetAgentId: parseResult.agentId,
          callId,
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
    const msg = formatDomindsNoteTellaskForTeammatesOnly(getWorkLanguage(), { firstMention });
    toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
    toolOutputs.push({
      type: 'tellask_result_msg',
      role: 'tool',
      responderId: 'dominds',
      mentionList,
      tellaskContent: body,
      status: 'failed',
      callId,
      content: msg,
    });
    await dlg.receiveTeammateCallResult('dominds', mentionList, body, msg, 'failed', callId);
    dlg.clearCurrentCallId();
  }

  return { toolOutputs, suspend, subdialogsCreated };
}

async function emitTellaskSpecialCallEvents(args: {
  dlg: Dialog;
  mentionList: string[];
  tellaskContent: string;
  callId: string;
}): Promise<void> {
  await args.dlg.callingStart({
    callId: args.callId,
    mentionList: args.mentionList,
    tellaskContent: args.tellaskContent,
  });
}

type ExecutableValidTellaskCall = Readonly<{
  kind: TellaskSpecialCall['kind'];
  mentionList: string[];
  tellaskContent: string;
  callId: string;
  targetAgentId?: string;
  sessionSlug?: string;
  q4hRemainingCallIds?: string[];
}>;

function toExecutableValidTellaskCall(call: TellaskSpecialCall): ExecutableValidTellaskCall {
  switch (call.kind) {
    case 'tellaskBack':
      return {
        kind: call.kind,
        mentionList: [...call.mentionList],
        tellaskContent: call.tellaskContent,
        callId: call.callId,
      };
    case 'tellask':
      return {
        kind: call.kind,
        mentionList: [...call.mentionList],
        tellaskContent: call.tellaskContent,
        targetAgentId: call.targetAgentId,
        sessionSlug: call.sessionSlug,
        callId: call.callId,
      };
    case 'tellaskSessionless':
      return {
        kind: call.kind,
        mentionList: [...call.mentionList],
        tellaskContent: call.tellaskContent,
        targetAgentId: call.targetAgentId,
        callId: call.callId,
      };
    case 'askHuman':
      return {
        kind: call.kind,
        mentionList: [...call.mentionList],
        tellaskContent: call.tellaskContent,
        callId: call.callId,
      };
  }
}

function normalizeQ4HCalls(
  calls: readonly ExecutableValidTellaskCall[],
  dlg: Dialog,
): ExecutableValidTellaskCall[] {
  const q4hCalls = calls.filter((call) => call.kind === 'askHuman');
  const nonQ4HCalls = calls
    .filter((call) => call.kind !== 'askHuman')
    .map((call) => ({ ...call, mentionList: [...call.mentionList] }));
  if (q4hCalls.length <= 1) {
    return q4hCalls.length === 1
      ? [...nonQ4HCalls, { ...q4hCalls[0]!, mentionList: [...q4hCalls[0]!.mentionList] }]
      : nonQ4HCalls;
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
    ...primary,
    mentionList: [...primary.mentionList],
    tellaskContent: mergedBody,
    q4hRemainingCallIds: remainingCallIds.length > 0 ? remainingCallIds : undefined,
  };
  log.info('Q4H multi-question normalized into a single prompt', undefined, {
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
    const runtimeMentionList =
      call.kind === 'tellaskBack' && args.dlg instanceof SubDialog
        ? [`@${args.dlg.supdialog.agentId}`]
        : call.mentionList;
    if (args.emitCallEvents) {
      await emitTellaskSpecialCallEvents({
        dlg: args.dlg,
        mentionList: runtimeMentionList,
        tellaskContent: call.tellaskContent,
        callId: call.callId,
      });
    }
    let firstMention: string;
    let forcedParseResult: TeammateTellaskParseResult | null | undefined;
    switch (call.kind) {
      case 'tellaskBack': {
        firstMention =
          args.dlg instanceof SubDialog ? args.dlg.supdialog.agentId : args.dlg.agentId;
        forcedParseResult =
          args.dlg instanceof SubDialog ? { type: 'A', agentId: args.dlg.supdialog.agentId } : null;
        break;
      }
      case 'tellask': {
        const targetAgentId = call.targetAgentId ?? '';
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
        firstMention = targetAgentId;
        const resolvedAgentId = targetAgentId === 'self' ? args.dlg.agentId : targetAgentId;
        forcedParseResult = { type: 'B', agentId: resolvedAgentId, sessionSlug: call.sessionSlug };
        break;
      }
      case 'tellaskSessionless': {
        const targetAgentId = call.targetAgentId ?? '';
        if (targetAgentId.trim() === '') {
          throw new Error(
            `tellaskSessionless invariant violation: missing targetAgentId for callId=${call.callId}`,
          );
        }
        firstMention = targetAgentId;
        const resolvedAgentId = targetAgentId === 'self' ? args.dlg.agentId : targetAgentId;
        forcedParseResult = { type: 'C', agentId: resolvedAgentId };
        break;
      }
      case 'askHuman': {
        firstMention = args.dlg.agentId;
        forcedParseResult = undefined;
        break;
      }
    }
    const tellaskHeadForExecution = runtimeMentionList.join(' ');
    const result = await executeTellaskCall(
      args.dlg,
      args.agent,
      firstMention,
      tellaskHeadForExecution,
      call.tellaskContent,
      call.callId,
      args.callbacks,
      {
        callKind: call.kind,
        mentionListOverride: runtimeMentionList,
        forcedParseResult,
        q4hRemainingCallIds: call.q4hRemainingCallIds,
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
