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
  formatDomindsNoteMalformedTellaskCall,
  formatDomindsNoteMultipleTellaskSessionDirectives,
  formatDomindsNoteQ4HRegisterFailed,
  formatDomindsNoteTellaskerNoTellaskSession,
  formatDomindsNoteTellaskerOnlyInSidelineDialog,
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
import type { CollectedTellaskCall } from '../../tellask';
import { syncPendingTellaskReminderState } from '../../tools/pending-tellask-reminder';
import type { ChatMessage } from '../client';
import { withSubdialogTxnLock } from './subdialog-txn';
import type { DriverV2DriveInvoker, DriverV2DriveScheduler, DriverV2HumanPrompt } from './types';

type PendingSubdialogRecordType = {
  subdialogId: string;
  createdAt: string;
  tellaskHead: string;
  targetAgentId: string;
  callType: 'A' | 'B' | 'C';
  tellaskSession?: string;
};

type TeammateTellaskParseResult =
  | {
      type: 'A';
      agentId: string;
    }
  | {
      type: 'B';
      agentId: string;
      tellaskSession: string;
    }
  | {
      type: 'C';
      agentId: string;
    };

type ExecuteCallbacks = {
  scheduleDrive: DriverV2DriveScheduler;
  driveDialog: DriverV2DriveInvoker;
};

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

function isValidTellaskSession(tellaskSession: string): boolean {
  const segments = tellaskSession.split('.');
  if (segments.length === 0) return false;
  return segments.every((segment) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(segment));
}

type TellaskSessionDirectiveParse =
  | { kind: 'none' }
  | { kind: 'one'; tellaskSession: string }
  | { kind: 'invalid' }
  | { kind: 'multiple' };

function parseTellaskSessionDirectiveFromHeadline(
  tellaskHead: string,
): TellaskSessionDirectiveParse {
  const re = /(^|\s)!tellaskSession\s+([^\s]+)/g;
  const ids: string[] = [];
  for (const match of tellaskHead.matchAll(re)) {
    const raw = match[2] ?? '';
    const candidate = raw.trim();
    const m = candidate.match(/^([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*)/);
    const tellaskSession = (m?.[1] ?? '').trim();
    if (!isValidTellaskSession(tellaskSession)) {
      return { kind: 'invalid' };
    }
    ids.push(tellaskSession);
  }

  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return { kind: 'none' };
  if (unique.length === 1) return { kind: 'one', tellaskSession: unique[0] ?? '' };
  return { kind: 'multiple' };
}

function extractSingleTellaskSessionFromHeadline(tellaskHead: string): string | null {
  const parsed = parseTellaskSessionDirectiveFromHeadline(tellaskHead);
  if (parsed.kind === 'one') return parsed.tellaskSession;
  return null;
}

function parseTeammateTellask(
  firstMention: string,
  tellaskHead: string,
  currentDialog?: Dialog,
): TeammateTellaskParseResult {
  if (firstMention === 'self') {
    const agentId = currentDialog?.agentId ?? 'self';
    const tellaskSession = extractSingleTellaskSessionFromHeadline(tellaskHead);
    if (tellaskSession) {
      return {
        type: 'B',
        agentId,
        tellaskSession,
      };
    }
    return {
      type: 'C',
      agentId,
    };
  }

  const tellaskSession = extractSingleTellaskSessionFromHeadline(tellaskHead);
  if (tellaskSession) {
    return {
      type: 'B',
      agentId: firstMention,
      tellaskSession,
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
  tellaskSession?: string;
  collectiveTargets?: string[];
};

async function createSubDialogWithInheritedPriming(
  callerDialog: Dialog,
  targetAgentId: string,
  tellaskHead: string,
  tellaskBody: string,
  options: SubdialogCreateOptions,
): Promise<SubDialog> {
  const subdialog = await callerDialog.createSubDialog(
    targetAgentId,
    tellaskHead,
    tellaskBody,
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
  tellaskSession: string,
): Promise<SubDialog | undefined> {
  const existing = rootDialog.lookupSubdialog(agentId, tellaskSession);
  if (!existing) {
    return undefined;
  }
  const existingSession = existing.tellaskSession;
  if (!existingSession) {
    throw new Error(
      `Type B registry invariant violation: lookupSubdialog returned entry without tellaskSession (root=${rootDialog.id.valueOf()} sub=${existing.id.valueOf()})`,
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
    tellaskSession: existingSession,
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

async function emitMalformedTellaskResponses(
  dlg: Dialog,
  collectedCalls: CollectedTellaskCall[],
): Promise<ChatMessage[]> {
  const toolOutputs: ChatMessage[] = [];
  const language = getWorkLanguage();
  for (const call of collectedCalls) {
    if (call.validation.kind !== 'malformed') continue;
    const firstLineAfterPrefix = (call.tellaskHead.split('\n')[0] ?? '').trim();
    const msg = formatDomindsNoteMalformedTellaskCall(language, call.validation.reason, {
      firstLineAfterPrefix,
    });

    toolOutputs.push({
      type: 'environment_msg',
      role: 'user',
      content: msg,
    });
    toolOutputs.push({
      type: 'tellask_result_msg',
      role: 'tool',
      responderId: 'dominds',
      tellaskHead: call.tellaskHead,
      status: 'failed',
      content: msg,
    });

    await dlg.receiveTeammateCallResult('dominds', call.tellaskHead, msg, 'failed', call.callId);
    dlg.clearCurrentCallId();
  }
  return toolOutputs;
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
  },
): Promise<{
  toolOutputs: ChatMessage[];
  suspend: boolean;
  subdialogsCreated: TDialogID[];
}> {
  const toolOutputs: ChatMessage[] = [];
  let suspend = false;
  const subdialogsCreated: TDialogID[] = [];

  const team = await Team.load();
  const isSelfAlias = firstMention === 'self';
  const isTellaskerAlias = firstMention === 'tellasker';
  const member = isSelfAlias
    ? team.getMember(dlg.agentId)
    : isTellaskerAlias
      ? null
      : team.getMember(firstMention);

  const allowMultiTeammateTargets = options?.allowMultiTeammateTargets ?? true;
  if (allowMultiTeammateTargets && member && !isSelfAlias && !isTellaskerAlias) {
    const mentioned = extractMentionIdsFromHeadline(tellaskHead);
    const uniqueMentioned = Array.from(new Set(mentioned));
    const knownTargets = uniqueMentioned.filter((id) => team.getMember(id) !== null);
    if (!knownTargets.includes(firstMention)) {
      knownTargets.unshift(firstMention);
    }

    if (knownTargets.length >= 2) {
      const unknown = uniqueMentioned.filter(
        (id) =>
          team.getMember(id) === null &&
          id !== 'self' &&
          id !== 'tellasker' &&
          id !== 'human' &&
          id !== 'dominds',
      );
      if (unknown.length > 0) {
        const msg = formatDomindsNoteInvalidMultiTeammateTargets(getWorkLanguage(), { unknown });
        toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
        toolOutputs.push({
          type: 'tellask_result_msg',
          role: 'tool',
          responderId: 'dominds',
          tellaskHead,
          status: 'failed',
          content: msg,
        });
        await dlg.receiveTeammateCallResult('dominds', tellaskHead, msg, 'failed', callId);
        dlg.clearCurrentCallId();
        return { toolOutputs, suspend: false, subdialogsCreated: [] };
      }

      if (options?.skipTellaskSessionDirectiveValidation !== true) {
        const tellaskSessionDirective = parseTellaskSessionDirectiveFromHeadline(tellaskHead);
        if (tellaskSessionDirective.kind === 'multiple') {
          const msg = formatDomindsNoteMultipleTellaskSessionDirectives(getWorkLanguage());
          toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
          toolOutputs.push({
            type: 'tellask_result_msg',
            role: 'tool',
            responderId: 'dominds',
            tellaskHead,
            status: 'failed',
            content: msg,
          });
          await dlg.receiveTeammateCallResult('dominds', tellaskHead, msg, 'failed', callId);
          dlg.clearCurrentCallId();
          return { toolOutputs, suspend: false, subdialogsCreated: [] };
        }
        if (tellaskSessionDirective.kind === 'invalid') {
          const msg = formatDomindsNoteInvalidTellaskSessionDirective(getWorkLanguage());
          toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
          toolOutputs.push({
            type: 'tellask_result_msg',
            role: 'tool',
            responderId: 'dominds',
            tellaskHead,
            status: 'failed',
            content: msg,
          });
          await dlg.receiveTeammateCallResult('dominds', tellaskHead, msg, 'failed', callId);
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

  const isQ4H = firstMention === 'human';
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
        tellaskHead: tellaskHead.trim(),
        bodyContent: body.trim(),
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
          tellaskHead: question.tellaskHead,
          bodyContent: question.bodyContent,
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
        tellaskHead: tellaskHead.substring(0, 100),
      });

      const msg = formatDomindsNoteQ4HRegisterFailed(getWorkLanguage(), { error: errMsg });
      toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
      toolOutputs.push({
        type: 'tellask_result_msg',
        role: 'tool',
        responderId: 'dominds',
        tellaskHead,
        status: 'failed',
        content: msg,
      });
      await dlg.receiveTeammateCallResult('dominds', tellaskHead, msg, 'failed', callId);
      dlg.clearCurrentCallId();
      return { toolOutputs, suspend: false, subdialogsCreated: [] };
    }
  }

  if (member || isSelfAlias || isTellaskerAlias) {
    if (isTellaskerAlias && !(dlg instanceof SubDialog)) {
      const response = formatDomindsNoteTellaskerOnlyInSidelineDialog(getWorkLanguage());
      try {
        await dlg.receiveTeammateResponse('dominds', tellaskHead, 'failed', dlg.id, {
          response,
          agentId: 'dominds',
          callId,
          originMemberId: dlg.agentId,
        });
      } catch (err) {
        log.warn('Failed to emit @tellasker misuse response', err, {
          dialogId: dlg.id.selfId,
          agentId: dlg.agentId,
        });
      }
      return { toolOutputs, suspend: false, subdialogsCreated: [] };
    }

    if (options?.skipTellaskSessionDirectiveValidation !== true) {
      const tellaskSessionDirective = parseTellaskSessionDirectiveFromHeadline(tellaskHead);

      if (isTellaskerAlias && tellaskSessionDirective.kind !== 'none') {
        const response = formatDomindsNoteTellaskerNoTellaskSession(getWorkLanguage());
        try {
          await dlg.receiveTeammateResponse('dominds', tellaskHead, 'failed', dlg.id, {
            response,
            agentId: 'dominds',
            callId,
            originMemberId: dlg.agentId,
          });
        } catch (err) {
          log.warn('Failed to emit @tellasker !tellaskSession syntax error response', err, {
            dialogId: dlg.id.selfId,
            agentId: dlg.agentId,
          });
        }
        return { toolOutputs, suspend: false, subdialogsCreated: [] };
      }

      if (tellaskSessionDirective.kind === 'multiple') {
        const msg = formatDomindsNoteMultipleTellaskSessionDirectives(getWorkLanguage());
        toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
        toolOutputs.push({
          type: 'tellask_result_msg',
          role: 'tool',
          responderId: 'dominds',
          tellaskHead,
          status: 'failed',
          content: msg,
        });
        await dlg.receiveTeammateCallResult('dominds', tellaskHead, msg, 'failed', callId);
        dlg.clearCurrentCallId();
        return { toolOutputs, suspend: false, subdialogsCreated: [] };
      }
      if (tellaskSessionDirective.kind === 'invalid') {
        const msg = formatDomindsNoteInvalidTellaskSessionDirective(getWorkLanguage());
        toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
        toolOutputs.push({
          type: 'tellask_result_msg',
          role: 'tool',
          responderId: 'dominds',
          tellaskHead,
          status: 'failed',
          content: msg,
        });
        await dlg.receiveTeammateCallResult('dominds', tellaskHead, msg, 'failed', callId);
        dlg.clearCurrentCallId();
        return { toolOutputs, suspend: false, subdialogsCreated: [] };
      }
    }

    const parseResult: TeammateTellaskParseResult = isTellaskerAlias
      ? { type: 'A', agentId: (dlg as SubDialog).supdialog.agentId }
      : parseTeammateTellask(firstMention, tellaskHead, dlg);

    if (isSelfAlias) {
      const fbrEffort = resolveFbrEffort(member);
      if (fbrEffort < 1) {
        const msg = formatDomindsNoteFbrDisabled(getWorkLanguage());
        toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
        toolOutputs.push({
          type: 'tellask_result_msg',
          role: 'tool',
          responderId: 'dominds',
          tellaskHead,
          status: 'failed',
          content: msg,
        });
        await dlg.receiveTeammateCallResult('dominds', tellaskHead, msg, 'failed', callId);
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
            tellaskHead,
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
            tellaskHead,
            targetAgentId: parseResult.agentId,
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
              tellaskHead,
              tellaskBody: body,
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
            tellaskHead,
            status: 'failed',
            content: msg,
          });
          await dlg.receiveTeammateCallResult('dominds', tellaskHead, msg, 'failed', callId);
          dlg.clearCurrentCallId();
          return { toolOutputs, suspend: false, subdialogsCreated: [] };
        }

        const pendingOwner = callerDialog;
        const baseSession = parseResult.tellaskSession;
        const derivedPrefix = `${baseSession}.fbr-`;

        const createdOrExisting = await withSubdialogTxnLock(rootDialog.id, async () => {
          const results: Array<{
            kind: 'existing' | 'created';
            subdialog: SubDialog;
            tellaskSession: string;
            indexedHeadLine: string;
          }> = [];

          const ensurePoolSessions = (desired: number): string[] => {
            if (desired <= 1) return [baseSession];
            const set = new Set<string>();
            for (const sub of rootDialog.getRegisteredSubdialogs()) {
              const tellaskSession = sub.tellaskSession;
              if (typeof tellaskSession !== 'string') continue;
              if (sub.agentId !== parseResult.agentId) continue;
              if (!tellaskSession.startsWith(derivedPrefix)) continue;
              set.add(tellaskSession);
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
              tellaskHead: indexedHeadLine,
              tellaskBody: body,
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
                tellaskSession: derivedSession,
                indexedHeadLine,
              });
              continue;
            }

            const created = await createSubDialogWithInheritedPriming(
              rootDialog,
              parseResult.agentId,
              indexedHeadLine,
              body,
              {
                originMemberId,
                callerDialogId: callerDialog.id.selfId,
                callId,
                tellaskSession: derivedSession,
                collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
              },
            );
            rootDialog.registerSubdialog(created);
            results.push({
              kind: 'created',
              subdialog: created,
              tellaskSession: derivedSession,
              indexedHeadLine,
            });
          }

          await rootDialog.saveSubdialogRegistry();
          return results;
        });

        const pendingRecords: PendingSubdialogRecordType[] = createdOrExisting.map((r) => ({
          subdialogId: r.subdialog.id.selfId,
          createdAt: formatUnifiedTimestamp(new Date()),
          tellaskHead: r.indexedHeadLine,
          targetAgentId: parseResult.agentId,
          callType: 'B',
          tellaskSession: r.tellaskSession,
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
              tellaskHead: r.indexedHeadLine,
              tellaskBody: body,
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
      !isSelfAlias && !isTellaskerAlias && parseResult.agentId === dlg.agentId;
    if (isDirectSelfCall) {
      const response = formatDomindsNoteDirectSelfCall(getWorkLanguage());
      try {
        await dlg.receiveTeammateResponse('dominds', tellaskHead, 'completed', dlg.id, {
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
          const tellaskHeadForSupdialog =
            isTellaskerAlias && tellaskHead.startsWith('@tellasker')
              ? `@${supdialog.agentId}${tellaskHead.slice('@tellasker'.length)}`
              : tellaskHead;
          const assignment = dlg.assignmentFromSup;
          const supPrompt: DriverV2HumanPrompt = {
            content: formatSupdialogCallPrompt({
              fromAgentId: dlg.agentId,
              toAgentId: supdialog.agentId,
              subdialogRequest: {
                tellaskHead: tellaskHeadForSupdialog,
                tellaskBody: body,
              },
              supdialogAssignment: {
                tellaskHead: assignment.tellaskHead,
                tellaskBody: assignment.tellaskBody,
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
            originalCallHeadLine: tellaskHead,
            responseBody: responseText,
            language: getWorkLanguage(),
          });

          dlg.setSuspensionState('resumed');

          toolOutputs.push({
            type: 'tellask_result_msg',
            role: 'tool',
            responderId: parseResult.agentId,
            tellaskHead,
            status: 'completed',
            content: responseContent,
          });
          await dlg.receiveTeammateResponse(
            parseResult.agentId,
            tellaskHead,
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
            tellaskHead,
            status: 'failed',
            content: errorText,
          });
          await dlg.receiveTeammateResponse(
            parseResult.agentId,
            tellaskHead,
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
            tellaskHead,
            body,
            {
              originMemberId: dlg.agentId,
              callerDialogId: callerDialog.id.selfId,
              callId,
              tellaskSession: parseResult.tellaskSession,
              collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
            },
          );

          const pendingRecord: PendingSubdialogRecordType = {
            subdialogId: sub.id.selfId,
            createdAt: formatUnifiedTimestamp(new Date()),
            tellaskHead,
            targetAgentId: parseResult.agentId,
            callType: 'C',
            tellaskSession: parseResult.tellaskSession,
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
              tellaskHead,
              tellaskBody: body,
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
          tellaskHead,
          tellaskBody: body,
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
            parseResult.tellaskSession,
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
            tellaskHead,
            body,
            {
              originMemberId,
              callerDialogId: callerDialog.id.selfId,
              callId,
              tellaskSession: parseResult.tellaskSession,
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
          tellaskHead,
          targetAgentId: parseResult.agentId,
          callType: 'B',
          tellaskSession: parseResult.tellaskSession,
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
              tellaskHead,
              tellaskBody: body,
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
              tellaskHead,
              tellaskBody: body,
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
          tellaskHead,
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
          tellaskHead,
          targetAgentId: parseResult.agentId,
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
            tellaskHead,
            tellaskBody: body,
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
      tellaskHead,
      status: 'failed',
      content: msg,
    });
    await dlg.receiveTeammateCallResult('dominds', tellaskHead, msg, 'failed', callId);
    dlg.clearCurrentCallId();
  }

  return { toolOutputs, suspend, subdialogsCreated };
}

export async function executeTellaskCalls(args: {
  dlg: Dialog;
  agent: Team.Member;
  collectedCalls: CollectedTellaskCall[];
  callbacks?: {
    scheduleDrive: DriverV2DriveScheduler;
    driveDialog: DriverV2DriveInvoker;
  };
}): Promise<{ suspend: boolean; toolOutputs: ChatMessage[]; subdialogsCreated: DialogID[] }> {
  const { dlg, agent, collectedCalls } = args;
  const callbacks = ensureCallbacks(args.callbacks);

  const malformedToolOutputs = await emitMalformedTellaskResponses(dlg, collectedCalls);

  const validCalls = collectedCalls.filter(
    (
      call,
    ): call is CollectedTellaskCall & { validation: { kind: 'valid'; firstMention: string } } =>
      call.validation.kind === 'valid',
  );

  type ExecutableValidCall = CollectedTellaskCall & {
    validation: { kind: 'valid'; firstMention: string };
    q4hRemainingCallIds?: string[];
  };
  const q4hCalls = validCalls.filter((call) => call.validation.firstMention === 'human');
  const nonQ4HCalls: ExecutableValidCall[] = validCalls
    .filter((call) => call.validation.firstMention !== 'human')
    .map((call) => ({ ...call }));
  let mergedQ4HCall: ExecutableValidCall | null = null;
  if (q4hCalls.length === 1) {
    mergedQ4HCall = { ...q4hCalls[0]! };
  } else if (q4hCalls.length > 1) {
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
        const body = call.body.trim();
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
    mergedQ4HCall = {
      ...primary,
      body: mergedBody,
      q4hRemainingCallIds: remainingCallIds.length > 0 ? remainingCallIds : undefined,
    };
    log.info('Q4H multi-question normalized into a single prompt', undefined, {
      rootId: dlg.id.rootId,
      selfId: dlg.id.selfId,
      mergedCount: q4hCalls.length,
      primaryCallId: primary.callId,
      remainingCallIds,
    });
  }
  const executionCalls: ExecutableValidCall[] = mergedQ4HCall
    ? [...nonQ4HCalls, mergedQ4HCall]
    : nonQ4HCalls;

  const results: Array<{
    toolOutputs: ChatMessage[];
    suspend: boolean;
    subdialogsCreated: TDialogID[];
  }> = [];
  for (const call of executionCalls) {
    const result = await executeTellaskCall(
      dlg,
      agent,
      call.validation.firstMention,
      call.tellaskHead,
      call.body,
      call.callId,
      callbacks,
      {
        q4hRemainingCallIds: call.q4hRemainingCallIds,
      },
    );
    results.push(result);
  }

  const suspend = results.some((result) => result.suspend);
  const toolOutputs = [...malformedToolOutputs, ...results.flatMap((result) => result.toolOutputs)];
  const subdialogsCreated = results.flatMap((result) => result.subdialogsCreated);

  return { suspend, toolOutputs, subdialogsCreated };
}
