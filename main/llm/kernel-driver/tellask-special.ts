import { inspect } from 'util';

import type { NewQ4HAskedEvent } from '@longrun-ai/kernel/types/dialog';
import {
  toCallingCourseNumber,
  toCallingGenerationSeqNumber,
  toRootGenerationAnchor,
  type HumanQuestion,
  type PendingSubdialogStateRecord,
  type TellaskCallRecord,
  type TellaskReplyDirective,
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
import type {
  ChatMessage,
  FuncCallMsg,
  FuncResultMsg,
  TellaskCarryoverMsg,
  TellaskResultMsg,
} from '../client';
import { buildFbrPromptForState, createInitialFbrState } from './fbr';
import { supplySubdialogResponseToAssignedCallerIfPendingV2 } from './subdialog';
import { withSubdialogTxnLock, withSubdialogTxnLocks } from './subdialog-txn';
import type {
  KernelDriverDriveCallbacks,
  KernelDriverRuntimeGuidePrompt,
  KernelDriverRuntimeReplyPrompt,
  KernelDriverRuntimeSubdialogPrompt,
} from './types';

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
  'replyTellask',
  'replyTellaskSessionless',
  'replyTellaskBack',
  'askHuman',
  'freshBootsReasoning',
] as const;

export type TellaskCallFunctionName = (typeof TELLASK_SPECIAL_FUNCTION_NAMES)[number];

export type TellaskCall =
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
      callName: 'replyTellask';
      replyContent: string;
    }>
  | Readonly<{
      callId: string;
      callName: 'replyTellaskSessionless';
      replyContent: string;
    }>
  | Readonly<{
      callId: string;
      callName: 'replyTellaskBack';
      replyContent: string;
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

export type ResolvedTellaskFunctionCall = Readonly<{
  originalCall: FuncCallMsg;
  call: TellaskCall;
}>;

export type InvalidTellaskFunctionCall = Readonly<{
  originalCall: FuncCallMsg;
  error: string;
  rawArgumentsText: string;
  contextArguments: string;
}>;

type ReplyTellaskCallName = 'replyTellask' | 'replyTellaskSessionless' | 'replyTellaskBack';
type NonReplyTellaskCallName = Exclude<TellaskCall['callName'], ReplyTellaskCallName>;
const MULTIPLE_ASKHUMAN_CALLS_ERROR =
  '不允许一轮多次调用 askHuman，必须单次调用问所有问题。 Do not call askHuman multiple times in one round; ask all questions in a single askHuman call.';

export function isTellaskCallFunctionName(name: string): name is TellaskCallFunctionName {
  return (TELLASK_SPECIAL_FUNCTION_NAMES as readonly string[]).includes(name);
}

function isReplyTellaskCallName(name: string): name is ReplyTellaskCallName {
  return (
    name === 'replyTellask' || name === 'replyTellaskSessionless' || name === 'replyTellaskBack'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function loadLatestActiveTellaskReplyDirective(
  dialog: Dialog,
): Promise<TellaskReplyDirective | undefined> {
  const latest = await DialogPersistence.loadDialogLatest(dialog.id, dialog.status);
  if (!latest) {
    return undefined;
  }
  const maxCourse = Math.floor(latest.currentCourse);
  const resolvedTargetCallIds = new Set<string>();
  for (let course = maxCourse; course >= 1; course -= 1) {
    const events = await DialogPersistence.loadCourseEvents(dialog.id, course, dialog.status);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type === 'tellask_reply_resolution_record') {
        const targetCallId = event.targetCallId.trim();
        if (targetCallId !== '') {
          resolvedTargetCallIds.add(targetCallId);
        }
        continue;
      }
      if (event.type !== 'human_text_record') {
        continue;
      }
      const directive = event.tellaskReplyDirective;
      if (!directive) {
        continue;
      }
      const targetCallId = directive.targetCallId.trim();
      if (targetCallId === '' || resolvedTargetCallIds.has(targetCallId)) {
        continue;
      }
      return directive;
    }
  }
  return undefined;
}

function formatReplyFuncResult(args: {
  replyCallName: ReplyTellaskCallName;
  replyContent: string;
}): string {
  const language = getWorkLanguage();
  return language === 'zh'
    ? `已通过 \`${args.replyCallName}\` 送达回复。`
    : `Reply delivered via \`${args.replyCallName}\`.`;
}

function formatReplyFuncErrorResult(args: {
  attemptedCallName: ReplyTellaskCallName;
  expectedCallName?: ReplyTellaskCallName;
  reason: 'wrong_tool' | 'no_active' | 'no_pending';
}): string {
  const language = getWorkLanguage();
  if (language === 'zh') {
    switch (args.reason) {
      case 'wrong_tool':
        if (!args.expectedCallName) {
          throw new Error(
            'replyTellask error formatting invariant violation: missing expectedCallName',
          );
        }
        return (
          `错误：当前精确应调用 \`${args.expectedCallName}\`，而不是 \`${args.attemptedCallName}\`。\n\n` +
          `请改用 \`${args.expectedCallName}({ replyContent })\`。`
        );
      case 'no_active':
        return (
          `错误：当前没有待完成的跨对话回复义务。\n\n` +
          `不要调用 \`${args.attemptedCallName}\`；请直接继续当前本地对话。`
        );
      case 'no_pending':
        return (
          `错误：当前已没有待本对话送达的跨对话回复义务（可能已回复或已失效）。\n\n` +
          `不要再次调用 \`${args.attemptedCallName}\`；请直接继续当前本地对话。`
        );
    }
  }
  switch (args.reason) {
    case 'wrong_tool':
      if (!args.expectedCallName) {
        throw new Error(
          'replyTellask error formatting invariant violation: missing expectedCallName',
        );
      }
      return (
        `Error: the exact reply tool for the current state is \`${args.expectedCallName}\`, not \`${args.attemptedCallName}\`.\n\n` +
        `Call \`${args.expectedCallName}({ replyContent })\` instead.`
      );
    case 'no_active':
      return (
        'Error: there is no active inter-dialog reply obligation right now.\n\n' +
        `Do not call \`${args.attemptedCallName}\`; continue the current local conversation instead.`
      );
    case 'no_pending':
      return (
        'Error: there is no longer a pending inter-dialog reply obligation for this dialog (it may already be resolved or no longer valid).\n\n' +
        `Do not call \`${args.attemptedCallName}\` again; continue the current local conversation instead.`
      );
  }
}

type ReplyTellaskExecutionResult = Readonly<{
  messages: ChatMessage[];
  delivered: boolean;
}>;

type ReplyTellaskCallRecord = TellaskCallRecord & { name: ReplyTellaskCallName };

function buildAssignmentReplyDirective(args: {
  callName: 'tellask' | 'tellaskSessionless';
  targetCallId: string;
  tellaskContent: string;
}): TellaskReplyDirective {
  return {
    expectedReplyCallName: args.callName === 'tellask' ? 'replyTellask' : 'replyTellaskSessionless',
    targetCallId: args.targetCallId,
    tellaskContent: args.tellaskContent,
  };
}

function buildTellaskBackReplyDirective(args: {
  targetDialogId: string;
  targetCallId: string;
  tellaskContent: string;
}): TellaskReplyDirective {
  return {
    expectedReplyCallName: 'replyTellaskBack',
    targetDialogId: args.targetDialogId,
    targetCallId: args.targetCallId,
    tellaskContent: args.tellaskContent,
  };
}

export async function deliverTellaskBackReplyFromDirective(args: {
  replyingDialog: Dialog;
  directive: Extract<TellaskReplyDirective, { expectedReplyCallName: 'replyTellaskBack' }>;
  replyContent: string;
  callbacks: KernelDriverDriveCallbacks;
  deliveryMode?: 'reply_tool' | 'direct_fallback';
}): Promise<void> {
  // Type-A ask-back is the one place where the local "caller/callee" intuition flips:
  // the dialog running `replyTellaskBack` is the ask-back responder, while
  // directive.targetDialogId points to the ask-back requester that must receive the canonical
  // tellaskBack result. Keep those roles explicit, otherwise it is very easy to accidentally
  // write the same business result twice by confusing the responder's local plaintext with the
  // canonical upstream delivery that must come only from an explicit reply tool call.
  const rootDialog =
    args.replyingDialog instanceof RootDialog
      ? args.replyingDialog
      : args.replyingDialog instanceof SubDialog
        ? args.replyingDialog.rootDialog
        : undefined;
  if (!rootDialog) {
    throw new Error('replyTellaskBack invariant violation: missing root dialog');
  }
  const askBackRequesterDialogId = new DialogID(
    args.directive.targetDialogId,
    rootDialog.id.rootId,
  );
  const askBackRequesterDialog =
    rootDialog.lookupDialog(askBackRequesterDialogId.selfId) ??
    (await ensureDialogLoaded(rootDialog, askBackRequesterDialogId, rootDialog.status));
  if (!askBackRequesterDialog) {
    throw new Error(
      `replyTellaskBack invariant violation: target dialog ${askBackRequesterDialogId.selfId} not found`,
    );
  }
  const response = formatTellaskResponseContent({
    callName: 'tellaskBack',
    responderId: args.replyingDialog.agentId,
    requesterId: askBackRequesterDialog.agentId,
    tellaskContent: args.directive.tellaskContent,
    responseBody: args.replyContent,
    status: 'completed',
    deliveryMode: args.deliveryMode,
    language: getWorkLanguage(),
  });
  const targetCallOriginCourse = toCallingCourseNumber(askBackRequesterDialog.currentCourse);
  const targetCallOriginGenseq = (() => {
    for (let i = askBackRequesterDialog.msgs.length - 1; i >= 0; i -= 1) {
      const msg = askBackRequesterDialog.msgs[i];
      if (!msg || msg.type !== 'func_call_msg') {
        continue;
      }
      if (msg.id !== args.directive.targetCallId) {
        continue;
      }
      return toCallingGenerationSeqNumber(msg.genseq);
    }
    return undefined;
  })();
  const replyMirror = await askBackRequesterDialog.receiveTellaskResponse(
    args.replyingDialog.agentId,
    'tellaskBack',
    undefined,
    args.directive.tellaskContent,
    'completed',
    args.replyingDialog.id,
    {
      response,
      agentId: args.replyingDialog.agentId,
      callId: args.directive.targetCallId,
      originMemberId: askBackRequesterDialog.agentId,
      originCourse: targetCallOriginCourse,
      calling_genseq: targetCallOriginGenseq,
    },
  );
  await askBackRequesterDialog.addChatMessages(replyMirror);
  // Do not mark the requester resumed until the canonical tellaskBack result has actually been
  // persisted and mirrored locally. Otherwise a write failure here would leave suspension state
  // claiming "resumed" while the business fact never landed.
  askBackRequesterDialog.setSuspensionState('resumed');
  await reviveDialogIfUnblocked(
    askBackRequesterDialog,
    args.callbacks,
    'reply_tellask_back_delivered',
  );
}

function isReplyTellaskCallRecord(record: TellaskCallRecord): record is ReplyTellaskCallRecord {
  return isReplyTellaskCallName(record.name);
}

function parseReplyTellaskCallRecord(record: ReplyTellaskCallRecord): {
  callId: string;
  callName: ReplyTellaskCallName;
  replyContent: string;
} {
  const parsed = parseTellaskCall({
    type: 'func_call_msg',
    role: 'assistant',
    genseq: record.genseq,
    id: record.id,
    name: record.name,
    arguments: record.rawArgumentsText,
  });
  if (!parsed.ok) {
    throw new Error(
      `reply recovery invariant violation: invalid persisted raw arguments for ${record.name} (callId=${record.id})`,
    );
  }
  switch (parsed.value.callName) {
    case 'replyTellask':
    case 'replyTellaskSessionless':
    case 'replyTellaskBack':
      return parsed.value;
    default:
      throw new Error(
        `reply recovery invariant violation: unexpected persisted call type ${parsed.value.callName} (callId=${record.id})`,
      );
  }
}

function formatReplyRecoveryFailureResult(args: {
  callName: ReplyTellaskCallName;
  errorText: string;
}): string {
  return getWorkLanguage() === 'zh'
    ? `恢复重试 \`${args.callName}\` 失败：${args.errorText}`
    : `Recovery retry for \`${args.callName}\` failed: ${args.errorText}`;
}

export async function recoverPendingReplyTellaskCalls(args: {
  dlg: Dialog;
  callbacks: KernelDriverDriveCallbacks;
}): Promise<number> {
  if (args.dlg.status !== 'running') {
    return 0;
  }

  const events = await DialogPersistence.loadCourseEvents(
    args.dlg.id,
    args.dlg.currentCourse,
    args.dlg.status,
  );
  const funcResultIds = new Set<string>();
  const resolvedReplyCallIds = new Set<string>();
  const replyCalls: ReplyTellaskCallRecord[] = [];

  for (const event of events) {
    if (event.type === 'func_result_record' || event.type === 'tellask_result_record') {
      const callId = event.type === 'func_result_record' ? event.id.trim() : event.callId.trim();
      if (callId !== '') {
        funcResultIds.add(callId);
      }
      continue;
    }
    if (event.type === 'tellask_reply_resolution_record') {
      const callId = event.callId.trim();
      if (callId !== '') {
        resolvedReplyCallIds.add(callId);
      }
      continue;
    }
    if (event.type !== 'tellask_call_record') {
      continue;
    }
    if (!isReplyTellaskCallRecord(event)) {
      continue;
    }
    replyCalls.push(event);
  }

  let recoveredCount = 0;
  for (const call of replyCalls) {
    const callId = call.id.trim();
    if (callId === '' || funcResultIds.has(callId)) {
      continue;
    }
    const parsedCall = parseReplyTellaskCallRecord(call);

    if (resolvedReplyCallIds.has(callId)) {
      await args.dlg.receiveFuncResult({
        type: 'func_result_msg',
        role: 'tool',
        genseq: call.genseq,
        id: call.id,
        name: call.name,
        content: formatReplyFuncResult({
          replyCallName: call.name,
          replyContent: parsedCall.replyContent,
        }),
      });
      funcResultIds.add(callId);
      recoveredCount += 1;
      continue;
    }

    try {
      const execution = await executeReplyTellaskCall({
        dlg: args.dlg,
        call: parsedCall,
        callbacks: args.callbacks,
      });
      for (const message of execution.messages) {
        if (message.type !== 'func_result_msg') {
          throw new Error(
            `reply recovery invariant violation: unexpected message type ${message.type}`,
          );
        }
        await args.dlg.receiveFuncResult({
          type: 'func_result_msg',
          role: 'tool',
          genseq: call.genseq,
          id: message.id,
          name: message.name,
          content: message.content,
          contentItems: message.contentItems,
        });
      }
      funcResultIds.add(callId);
      recoveredCount += 1;
    } catch (err) {
      const errorText = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      log.error('Failed to recover pending replyTellask* call after restart', err, {
        rootId: args.dlg.id.rootId,
        selfId: args.dlg.id.selfId,
        course: args.dlg.currentCourse,
        genseq: call.genseq,
        callId: call.id,
        toolName: call.name,
      });
      await args.dlg.receiveFuncResult({
        type: 'func_result_msg',
        role: 'tool',
        genseq: call.genseq,
        id: call.id,
        name: call.name,
        content: formatReplyRecoveryFailureResult({
          callName: call.name,
          errorText,
        }),
      });
      funcResultIds.add(callId);
      recoveredCount += 1;
    }
  }

  return recoveredCount;
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

function parseTellaskCall(
  call: FuncCallMsg,
): { ok: true; value: TellaskCall } | { ok: false; error: string } {
  if (!isTellaskCallFunctionName(call.name)) {
    return { ok: false, error: `unsupported tellask special function '${call.name}'` };
  }

  const argsResult = parseFuncCallArgsObject(call);
  if (!argsResult.ok) {
    return argsResult;
  }
  const args = argsResult.value;

  switch (call.name) {
    case 'tellaskBack': {
      const tellaskContent = readRequiredStringField(args, 'tellaskContent');
      if (!tellaskContent.ok) {
        return tellaskContent;
      }
      return {
        ok: true,
        value: {
          callId: call.id,
          callName: 'tellaskBack',
          tellaskContent: tellaskContent.value,
        },
      };
    }
    case 'replyTellask':
    case 'replyTellaskSessionless':
    case 'replyTellaskBack': {
      const replyContent = readRequiredStringField(args, 'replyContent');
      if (!replyContent.ok) {
        return replyContent;
      }
      return {
        ok: true,
        value: {
          callId: call.id,
          callName: call.name,
          replyContent: replyContent.value,
        },
      };
    }
    case 'askHuman': {
      const tellaskContent = readRequiredStringField(args, 'tellaskContent');
      if (!tellaskContent.ok) {
        return tellaskContent;
      }
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
      const tellaskContent = readRequiredStringField(args, 'tellaskContent');
      if (!tellaskContent.ok) {
        return tellaskContent;
      }
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
      const tellaskContent = readRequiredStringField(args, 'tellaskContent');
      if (!tellaskContent.ok) {
        return tellaskContent;
      }
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
      const tellaskContent = readRequiredStringField(args, 'tellaskContent');
      if (!tellaskContent.ok) {
        return tellaskContent;
      }
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

function getRawArgumentsText(call: FuncCallMsg): string {
  return typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
}

export function resolveTellaskFunctionCalls(
  funcCalls: readonly FuncCallMsg[],
  options?: { allowedSpecials?: ReadonlySet<TellaskCallFunctionName> },
): {
  validCalls: ResolvedTellaskFunctionCall[];
  invalidCalls: InvalidTellaskFunctionCall[];
  normalCalls: FuncCallMsg[];
} {
  const validCalls: ResolvedTellaskFunctionCall[] = [];
  const invalidCalls: InvalidTellaskFunctionCall[] = [];
  const normalCalls: FuncCallMsg[] = [];
  const allowed = options?.allowedSpecials ?? null;

  for (const call of funcCalls) {
    if (!isTellaskCallFunctionName(call.name)) {
      normalCalls.push(call);
      continue;
    }
    if (allowed && !allowed.has(call.name)) {
      normalCalls.push(call);
      continue;
    }
    const rawArgumentsText = getRawArgumentsText(call);
    const parsed = parseTellaskCall(call);
    if (!parsed.ok) {
      invalidCalls.push({
        originalCall: call,
        error: parsed.error,
        rawArgumentsText,
        contextArguments: rawArgumentsText,
      });
      continue;
    }
    validCalls.push({
      originalCall: call,
      call: parsed.value,
    });
  }

  return { validCalls, invalidCalls, normalCalls };
}

export function formatTellaskInvalidCallResult(args: {
  call: FuncCallMsg;
  error: string;
}): FuncResultMsg {
  return {
    type: 'func_result_msg',
    id: args.call.id,
    name: args.call.name,
    content:
      args.call.name === 'askHuman' && args.error === MULTIPLE_ASKHUMAN_CALLS_ERROR
        ? args.error
        : `Invalid arguments for tellask special function '${args.call.name}': ${args.error}`,
    role: 'tool',
    genseq: args.call.genseq,
  };
}

export function formatPendingTellaskFuncResultContent(
  name: TellaskCallFunctionName,
  startedAtMs: number | null,
): string {
  const language = getWorkLanguage();
  const elapsed = (() => {
    if (startedAtMs === null) {
      return language === 'zh' ? '未知时长' : 'unknown elapsed time';
    }
    const elapsedMs = Math.max(0, Date.now() - startedAtMs);
    const elapsedSec = Math.floor(elapsedMs / 1000);
    return language === 'zh' ? `${elapsedSec} 秒` : `${elapsedSec}s`;
  })();
  if (name === 'askHuman') {
    return language === 'zh'
      ? `Q4H 仍在等待人类回复，已持续 ${elapsed}。`
      : `Q4H is still waiting for human reply (elapsed ${elapsed}).`;
  }
  return language === 'zh'
    ? `支线对话仍在进行中，已持续 ${elapsed}。`
    : `Sideline dialog is still running (elapsed ${elapsed}).`;
}

export function formatResolvedAskHumanResultContent(): string {
  return getWorkLanguage() === 'zh'
    ? 'Q4H 已结束等待状态，请参考 askHuman 结果气泡。'
    : 'Q4H wait is resolved; refer to the askHuman result bubble.';
}

function buildPendingTellaskFuncResult(args: {
  callId: string;
  callName: TellaskCallFunctionName;
  genseq: number;
}): FuncResultMsg {
  return {
    type: 'func_result_msg',
    role: 'tool',
    genseq: args.genseq,
    id: args.callId,
    name: args.callName,
    content: formatPendingTellaskFuncResultContent(args.callName, null),
  };
}

async function persistTellaskFuncResult(dlg: Dialog, result: FuncResultMsg): Promise<void> {
  if (!isTellaskCallFunctionName(result.name)) {
    throw new Error(
      `persistTellaskFuncResult invariant violation: ${result.name} is not tellask special`,
    );
  }
  await dlg.receiveFuncResult(result);
}

function buildTellaskResultToolOutput(args: {
  callId: string;
  callName: 'tellaskBack' | 'tellask' | 'tellaskSessionless' | 'askHuman' | 'freshBootsReasoning';
  content: string;
  status: 'pending' | 'completed' | 'failed';
  originCourse?: number;
  calling_genseq?: number;
  responderId: string;
  tellaskContent: string;
  mentionList?: string[];
  sessionSlug?: string;
  agentId?: string;
  originMemberId?: string;
  calleeDialogId?: string;
  calleeCourse?: number;
  calleeGenseq?: number;
}): TellaskResultMsg {
  return {
    type: 'tellask_result_msg',
    role: 'tool',
    callId: args.callId,
    callName: args.callName,
    status: args.status,
    content: args.content,
    ...(typeof args.originCourse === 'number' ? { originCourse: args.originCourse } : {}),
    ...(typeof args.calling_genseq === 'number' ? { calling_genseq: args.calling_genseq } : {}),
    call:
      args.callName === 'tellask'
        ? {
            tellaskContent: args.tellaskContent,
            mentionList: args.mentionList ?? [],
            ...(args.sessionSlug ? { sessionSlug: args.sessionSlug } : {}),
          }
        : args.callName === 'tellaskSessionless'
          ? {
              tellaskContent: args.tellaskContent,
              mentionList: args.mentionList ?? [],
            }
          : {
              tellaskContent: args.tellaskContent,
            },
    responder: {
      responderId: args.responderId,
      ...(args.agentId ? { agentId: args.agentId } : {}),
      ...(args.originMemberId ? { originMemberId: args.originMemberId } : {}),
    },
    ...(args.calleeDialogId !== undefined ||
    args.calleeCourse !== undefined ||
    args.calleeGenseq !== undefined
      ? {
          route: {
            ...(args.calleeDialogId ? { calleeDialogId: args.calleeDialogId } : {}),
            ...(typeof args.calleeCourse === 'number' ? { calleeCourse: args.calleeCourse } : {}),
            ...(typeof args.calleeGenseq === 'number' ? { calleeGenseq: args.calleeGenseq } : {}),
          },
        }
      : {}),
  };
}

function buildTellaskCarryoverToolOutput(args: {
  genseq: number;
  content: string;
  originCourse: number;
  carryoverCourse: number;
  responderId: string;
  callName: 'tellask' | 'tellaskSessionless' | 'askHuman' | 'freshBootsReasoning';
  tellaskContent: string;
  status: 'completed' | 'failed';
  response: string;
  agentId: string;
  callId: string;
  originMemberId: string;
  mentionList?: string[];
  sessionSlug?: string;
  calleeDialogId?: string;
  calleeCourse?: number;
  calleeGenseq?: number;
}): TellaskCarryoverMsg {
  return {
    type: 'tellask_carryover_msg',
    role: 'user',
    genseq: args.genseq,
    content: args.content,
    originCourse: args.originCourse,
    carryoverCourse: args.carryoverCourse,
    responderId: args.responderId,
    callName: args.callName,
    tellaskContent: args.tellaskContent,
    status: args.status,
    response: args.response,
    agentId: args.agentId,
    callId: args.callId,
    originMemberId: args.originMemberId,
    ...(args.callName === 'tellask'
      ? {
          mentionList: args.mentionList ?? [],
          sessionSlug: args.sessionSlug ?? '',
        }
      : args.callName === 'tellaskSessionless'
        ? {
            mentionList: args.mentionList ?? [],
          }
        : {}),
    ...(args.calleeDialogId ? { calleeDialogId: args.calleeDialogId } : {}),
    ...(typeof args.calleeCourse === 'number' ? { calleeCourse: args.calleeCourse } : {}),
    ...(typeof args.calleeGenseq === 'number' ? { calleeGenseq: args.calleeGenseq } : {}),
  };
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

type SubdialogCreateOptions = {
  callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  originMemberId: string;
  callerDialogId: string;
  callId: string;
  sessionSlug?: string;
  collectiveTargets?: string[];
  effectiveFbrEffort?: number;
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
      calling_genseq: pendingRecord.callingGenseq,
      carryoverContent,
      sessionSlug: pendingRecord.sessionSlug,
    },
  );

  const immediateMirror: ChatMessage =
    carryoverContent !== undefined
      ? buildTellaskCarryoverToolOutput({
          genseq: ownerDialog.activeGenSeqOrUndefined ?? 1,
          content: carryoverContent,
          originCourse: carryoverOriginCourse!,
          carryoverCourse: ownerDialog.currentCourse,
          responderId: subdialog.agentId,
          callName: pendingRecord.callName,
          tellaskContent: pendingRecord.tellaskContent,
          status: 'failed',
          response,
          agentId: subdialog.agentId,
          callId: pendingRecord.callId,
          originMemberId: requesterId,
          mentionList: pendingRecord.mentionList,
          sessionSlug: pendingRecord.sessionSlug,
          calleeDialogId: subdialog.id.selfId,
        })
      : buildTellaskResultToolOutput({
          callId: pendingRecord.callId,
          callName: pendingRecord.callName,
          content: response,
          status: 'failed',
          originCourse: carryoverOriginCourse,
          calling_genseq: pendingRecord.callingGenseq,
          responderId: subdialog.agentId,
          tellaskContent: pendingRecord.tellaskContent,
          mentionList: pendingRecord.mentionList,
          sessionSlug: pendingRecord.sessionSlug,
          agentId: subdialog.agentId,
          originMemberId: requesterId,
          calleeDialogId: subdialog.id.selfId,
        });
  await ownerDialog.addChatMessages(immediateMirror);
}

async function reviveDialogIfUnblocked(
  dialog: Dialog,
  callbacks: KernelDriverDriveCallbacks,
  reason: 'reply_tellask_back_delivered' | 'type_b_registered_subdialog_replaced_pending_round',
): Promise<void> {
  const suspension = await dialog.getSuspensionStatus({
    allowPendingSubdialogs: reason === 'reply_tellask_back_delivered',
  });
  if (!suspension.canDrive) {
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
      noPromptSubdialogResumeEntitlement:
        dialog instanceof SubDialog
          ? {
              ownerDialogId: dialog.id.selfId,
              reason:
                reason === 'reply_tellask_back_delivered'
                  ? 'reply_tellask_back_delivered'
                  : 'resolved_pending_subdialog_reply',
            }
          : undefined,
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

function findDeliveredTellaskBackReplyOnAskBackRequester(args: {
  requesterDialog: Dialog;
  targetCallId: string;
}): Extract<ChatMessage, { type: 'tellask_result_msg' }> | undefined {
  // `replyTellaskBack` persists the canonical tellaskBack business result onto the ask-back
  // requester dialog immediately. Type-A orchestration must check that canonical delivery first
  // before it even considers any fallback extraction from responder plaintext, or we risk a
  // second final result with the same target callId.
  for (let i = args.requesterDialog.msgs.length - 1; i >= 0; i -= 1) {
    const msg = args.requesterDialog.msgs[i];
    if (msg.type !== 'tellask_result_msg' || msg.callName !== 'tellaskBack') {
      continue;
    }
    if (msg.callId !== args.targetCallId) {
      continue;
    }
    return msg;
  }
  return undefined;
}

async function extractAskBackResponderPlaintextFallback(args: {
  responderDialog: Dialog;
}): Promise<string> {
  try {
    return extractLastAssistantResponse(
      args.responderDialog.msgs,
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
    callName: NonReplyTellaskCallName;
    parseResult: TellaskRoutingParseResult | null;
    targetForError?: string;
    collectiveTargets?: string[];
    fbrEffortOverride?: number;
  },
): Promise<ChatMessage[]> {
  const toolOutputs: ChatMessage[] = [];
  const callName = options.callName;
  const rawCallingCourse = dlg.activeGenCourseOrUndefined ?? dlg.currentCourse;
  const callingCourse =
    Number.isFinite(rawCallingCourse) && rawCallingCourse > 0
      ? toCallingCourseNumber(rawCallingCourse)
      : undefined;
  const callingGenseq =
    typeof dlg.activeGenSeqOrUndefined === 'number'
      ? toCallingGenerationSeqNumber(dlg.activeGenSeqOrUndefined)
      : undefined;
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
      const question: HumanQuestion = {
        id: questionId,
        tellaskContent: body.trim(),
        askedAt: formatUnifiedTimestamp(new Date()),
        callId: normalizedCallId,
        callSiteRef: {
          course: dlg.currentCourse,
          messageIndex: dlg.msgs.length,
          ...(callingGenseq !== undefined ? { callingGenseq } : {}),
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
      toolOutputs.push(
        buildTellaskResultToolOutput({
          callId,
          callName,
          content: msg,
          status: 'failed',
          originCourse: callingCourse,
          calling_genseq: callingGenseq,
          responderId: 'dominds',
          tellaskContent: body,
          mentionList: normalizedMentionList,
          agentId: 'dominds',
          originMemberId: dlg.agentId,
        }),
      );
      await dlg.receiveTellaskCallResult(
        'dominds',
        callName,
        mentionList,
        body,
        msg,
        'failed',
        callId,
        {
          originCourse: callingCourse,
          calling_genseq: callingGenseq,
        },
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
    const firstMentionForError = options.targetForError ?? parseResult.agentId;
    if (parseResult.type !== 'A' && member === null) {
      const msg = formatDomindsNoteTellaskForTeammatesOnly(getWorkLanguage(), {
        firstMention: firstMentionForError,
      });
      toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
      toolOutputs.push(
        buildTellaskResultToolOutput({
          callId,
          callName,
          content: msg,
          status: 'failed',
          originCourse: callingCourse,
          calling_genseq: callingGenseq,
          responderId: 'dominds',
          tellaskContent: body,
          mentionList: normalizedMentionList,
          agentId: 'dominds',
          originMemberId: dlg.agentId,
        }),
      );
      await dlg.receiveTellaskCallResult(
        'dominds',
        callName,
        mentionList,
        body,
        msg,
        'failed',
        callId,
        {
          originCourse: callingCourse,
          calling_genseq: callingGenseq,
        },
      );
      dlg.clearCurrentCallId();
      return toolOutputs;
    }

    if (isFreshBootsCall) {
      const memberFbrEffort = resolveFbrEffort(member);
      if (memberFbrEffort < 1) {
        const msg = formatDomindsNoteFbrDisabled(getWorkLanguage());
        toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
        toolOutputs.push(
          buildTellaskResultToolOutput({
            callId,
            callName,
            content: msg,
            status: 'failed',
            originCourse: callingCourse,
            calling_genseq: callingGenseq,
            responderId: 'dominds',
            tellaskContent: body,
            mentionList: normalizedMentionList,
            agentId: 'dominds',
            originMemberId: dlg.agentId,
          }),
        );
        await dlg.receiveTellaskCallResult(
          'dominds',
          callName,
          mentionList,
          body,
          msg,
          'failed',
          callId,
          {
            originCourse: callingCourse,
            calling_genseq: callingGenseq,
          },
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
        toolOutputs.push(
          buildTellaskResultToolOutput({
            callId,
            callName,
            content: msg,
            status: 'failed',
            originCourse: callingCourse,
            calling_genseq: callingGenseq,
            responderId: 'dominds',
            tellaskContent: body,
            mentionList: normalizedMentionList,
            agentId: 'dominds',
            originMemberId: dlg.agentId,
          }),
        );
        await dlg.receiveTellaskCallResult(
          'dominds',
          callName,
          mentionList,
          body,
          msg,
          'failed',
          callId,
          {
            originCourse: callingCourse,
            calling_genseq: callingGenseq,
          },
        );
        dlg.clearCurrentCallId();
        return toolOutputs;
      }

      const callerDialog = dlg;
      const originMemberId = dlg.agentId;
      const collectiveTargets = options?.collectiveTargets ?? [parseResult.agentId];

      if (parseResult.type !== 'C') {
        const msg = formatDomindsNoteFbrToollessViolation(getWorkLanguage(), {
          kind: 'internal_error',
        });
        toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
        toolOutputs.push(
          buildTellaskResultToolOutput({
            callId,
            callName,
            content: msg,
            status: 'failed',
            originCourse: callingCourse,
            calling_genseq: callingGenseq,
            responderId: 'dominds',
            tellaskContent: body,
            mentionList: normalizedMentionList,
            agentId: 'dominds',
            originMemberId: dlg.agentId,
          }),
        );
        await dlg.receiveTellaskCallResult(
          'dominds',
          callName,
          mentionList,
          body,
          msg,
          'failed',
          callId,
          {
            originCourse: callingCourse,
            calling_genseq: callingGenseq,
          },
        );
        dlg.clearCurrentCallId();
        return toolOutputs;
      }

      const sub = await createSubDialog(dlg, parseResult.agentId, mentionList, body, {
        callName: subdialogCallName,
        originMemberId,
        callerDialogId: callerDialog.id.selfId,
        callId,
        collectiveTargets,
        effectiveFbrEffort: fbrEffort,
      });
      sub.setFbrConclusionToolsEnabled(false);
      const pendingRecord: PendingSubdialogStateRecord = {
        subdialogId: sub.id.selfId,
        createdAt: formatUnifiedTimestamp(new Date()),
        callName: subdialogCallName,
        mentionList,
        tellaskContent: body,
        targetAgentId: parseResult.agentId,
        callId,
        callingCourse,
        callingGenseq,
        callType: 'C',
      };
      await withSubdialogTxnLock(dlg.id, async () => {
        await DialogPersistence.appendPendingSubdialog(
          dlg.id,
          pendingRecord,
          toRootGenerationAnchor({
            rootCourse: dlg instanceof SubDialog ? dlg.rootDialog.currentCourse : dlg.currentCourse,
            rootGenseq:
              dlg instanceof SubDialog
                ? (dlg.rootDialog.activeGenSeqOrUndefined ?? 0)
                : (dlg.activeGenSeqOrUndefined ?? 0),
          }),
        );
      });
      const initialFbrState = createInitialFbrState(fbrEffort);
      await DialogPersistence.mutateDialogLatest(sub.id, () => ({
        kind: 'patch',
        patch: {
          generating: true,
          displayState: { kind: 'proceeding' },
          executionMarker: undefined,
          fbrState: initialFbrState,
        },
      }));
      await syncPendingTellaskReminderBestEffort(
        dlg,
        'kernel-driver:executeTellaskCall:FBR:appendPending',
      );
      const initPrompt: KernelDriverRuntimeGuidePrompt = {
        content: buildFbrPromptForState({
          state: initialFbrState,
          tellaskContent: body,
          fromAgentId: originMemberId,
          toAgentId: sub.agentId,
          language: getWorkLanguage(),
          collectiveTargets,
        }),
        msgId: generateShortId(),
        grammar: 'markdown',
        origin: 'runtime',
      };
      callbacks.scheduleDrive(sub, {
        humanPrompt: initPrompt,
        waitInQue: true,
        driveOptions: {
          source: 'kernel_driver_subdialog_init',
          reason: 'fresh_boots_reasoning_subdialog_init',
        },
      });
      return toolOutputs;
    }

    const isDirectSelfCall = !isFreshBootsCall && parseResult.agentId === dlg.agentId;
    if (isDirectSelfCall) {
      const msg = formatDomindsNoteDirectSelfCall(getWorkLanguage());
      toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
      toolOutputs.push(
        buildTellaskResultToolOutput({
          callId,
          callName,
          content: msg,
          status: 'failed',
          originCourse: callingCourse,
          calling_genseq: callingGenseq,
          responderId: 'dominds',
          tellaskContent: body,
          mentionList: normalizedMentionList,
          agentId: 'dominds',
          originMemberId: dlg.agentId,
        }),
      );
      await dlg.receiveTellaskCallResult(
        'dominds',
        callName,
        mentionList,
        body,
        msg,
        'failed',
        callId,
        {
          originCourse: callingCourse,
          calling_genseq: callingGenseq,
        },
      );
      dlg.clearCurrentCallId();
      return toolOutputs;
    }

    if (parseResult.type === 'A') {
      if (dlg instanceof SubDialog) {
        // Identity map for Type-A ask-back:
        // - `askBackRequesterDialog` is the sideline dialog that asked upstream for clarification.
        // - `askBackResponderDialog` is the upstream dialog that must answer that ask-back.
        // The original tellask relationship is the opposite of the current ask-back relationship,
        // so variable names like "supdialog" or "target" are too lossy here and invite bugs.
        const askBackRequesterDialog = dlg;
        const askBackResponderDialog = dlg.supdialog;
        askBackRequesterDialog.setSuspensionState('suspended');

        try {
          const assignment = askBackRequesterDialog.assignmentFromSup;
          const supPrompt: KernelDriverRuntimeReplyPrompt = {
            content: formatSupdialogCallPrompt({
              fromAgentId: askBackRequesterDialog.agentId,
              toAgentId: askBackResponderDialog.agentId,
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
            tellaskReplyDirective: buildTellaskBackReplyDirective({
              targetDialogId: askBackRequesterDialog.id.selfId,
              targetCallId: callId,
              tellaskContent: body,
            }),
          };
          await callbacks.driveDialog(askBackResponderDialog, {
            humanPrompt: supPrompt,
            waitInQue: true,
            driveOptions: {
              source: 'kernel_driver_type_a_supdialog_call',
              reason: 'type_a_supdialog_roundtrip',
            },
          });

          const explicitReplyDelivery = findDeliveredTellaskBackReplyOnAskBackRequester({
            requesterDialog: askBackRequesterDialog,
            targetCallId: callId,
          });
          if (explicitReplyDelivery) {
            // Important invariant: once the responder used `replyTellaskBack`, that write is the
            // single source of truth. Do not also synthesize another tellask result from the
            // responder's generic assistant words, even if those words look "compatible".
            askBackRequesterDialog.setSuspensionState('resumed');
            toolOutputs.push(explicitReplyDelivery);
            return toolOutputs;
          }

          const responseText = await extractAskBackResponderPlaintextFallback({
            responderDialog: askBackResponderDialog,
          });
          const responseContent = formatTellaskResponseContent({
            callName,
            responderId: parseResult.agentId,
            requesterId: askBackRequesterDialog.agentId,
            mentionList,
            tellaskContent: body,
            responseBody: responseText,
            status: 'completed',
            deliveryMode: 'direct_fallback',
            language: getWorkLanguage(),
          });

          askBackRequesterDialog.setSuspensionState('resumed');

          toolOutputs.push(
            buildTellaskResultToolOutput({
              callId,
              callName,
              content: responseContent,
              status: 'completed',
              originCourse: callingCourse,
              calling_genseq: callingGenseq,
              responderId: parseResult.agentId,
              tellaskContent: body,
              mentionList,
              agentId: parseResult.agentId,
              originMemberId: askBackRequesterDialog.agentId,
              calleeDialogId: askBackResponderDialog.id.selfId,
            }),
          );
          await askBackRequesterDialog.receiveTellaskResponse(
            parseResult.agentId,
            callName,
            mentionList,
            body,
            'completed',
            askBackResponderDialog.id,
            {
              response: responseContent,
              agentId: parseResult.agentId,
              callId,
              originMemberId: askBackRequesterDialog.agentId,
              originCourse: callingCourse,
              calling_genseq: callingGenseq,
            },
          );
        } catch (err) {
          log.warn('Type A supdialog processing error:', err);
          askBackRequesterDialog.setSuspensionState('resumed');
          const errorText = `❌ **Error processing request to @${parseResult.agentId}:**\n\n${showErrorToAi(err)}`;
          const errorContent = formatTellaskResponseContent({
            callName,
            responderId: parseResult.agentId,
            requesterId: askBackRequesterDialog.agentId,
            mentionList,
            tellaskContent: body,
            responseBody: errorText,
            status: 'failed',
            language: getWorkLanguage(),
          });
          toolOutputs.push(
            buildTellaskResultToolOutput({
              callId,
              callName,
              content: errorContent,
              status: 'failed',
              originCourse: callingCourse,
              calling_genseq: callingGenseq,
              responderId: parseResult.agentId,
              tellaskContent: body,
              mentionList,
              agentId: parseResult.agentId,
              originMemberId: askBackRequesterDialog.agentId,
              calleeDialogId: askBackResponderDialog.id.selfId,
            }),
          );
          await askBackRequesterDialog.receiveTellaskResponse(
            parseResult.agentId,
            callName,
            mentionList,
            body,
            'failed',
            askBackResponderDialog.id,
            {
              response: errorContent,
              agentId: parseResult.agentId,
              callId,
              originMemberId: askBackRequesterDialog.agentId,
              originCourse: callingCourse,
              calling_genseq: callingGenseq,
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
            callingGenseq,
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

          const initPrompt: KernelDriverRuntimeSubdialogPrompt = {
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
            tellaskReplyDirective: buildAssignmentReplyDirective({
              callName: 'tellaskSessionless',
              targetCallId: callId,
              tellaskContent: body,
            }),
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
                  callingGenseq,
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
                callingGenseq,
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
          const resumePrompt: KernelDriverRuntimeSubdialogPrompt = {
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
            tellaskReplyDirective: buildAssignmentReplyDirective({
              callName: 'tellask',
              targetCallId: callId,
              tellaskContent: body,
            }),
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
              tellaskReplyDirective: resumePrompt.tellaskReplyDirective,
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
          const initPrompt: KernelDriverRuntimeSubdialogPrompt = {
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
            tellaskReplyDirective: buildAssignmentReplyDirective({
              callName: 'tellask',
              targetCallId: callId,
              tellaskContent: body,
            }),
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
          callingGenseq,
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

        const initPrompt: KernelDriverRuntimeSubdialogPrompt = {
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
          tellaskReplyDirective: buildAssignmentReplyDirective({
            callName: 'tellaskSessionless',
            targetCallId: callId,
            tellaskContent: body,
          }),
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
    toolOutputs.push(
      buildTellaskResultToolOutput({
        callId,
        callName,
        content: msg,
        status: 'failed',
        originCourse: callingCourse,
        calling_genseq: callingGenseq,
        responderId: 'dominds',
        tellaskContent: body,
        mentionList: normalizedMentionList,
        agentId: 'dominds',
        originMemberId: dlg.agentId,
      }),
    );
    await dlg.receiveTellaskCallResult(
      'dominds',
      callName,
      mentionList,
      body,
      msg,
      'failed',
      callId,
      {
        originCourse: callingCourse,
        calling_genseq: callingGenseq,
      },
    );
    dlg.clearCurrentCallId();
  }

  return toolOutputs;
}

async function emitTellaskCallEvents(args: {
  dlg: Dialog;
  callName: NonReplyTellaskCallName;
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

async function executeReplyTellaskCall(args: {
  dlg: Dialog;
  call:
    | Extract<ExecutableValidTellaskCall, { callName: 'replyTellask' }>
    | Extract<ExecutableValidTellaskCall, { callName: 'replyTellaskSessionless' }>
    | Extract<ExecutableValidTellaskCall, { callName: 'replyTellaskBack' }>;
  callbacks: KernelDriverDriveCallbacks;
  activePromptReplyDirective?: TellaskReplyDirective;
}): Promise<ReplyTellaskExecutionResult> {
  const genseq = args.dlg.activeGenSeqOrUndefined ?? 1;
  const activeDirective =
    args.activePromptReplyDirective ?? (await loadLatestActiveTellaskReplyDirective(args.dlg));
  const expectedCallName = activeDirective?.expectedReplyCallName;
  if (!expectedCallName) {
    return {
      delivered: false,
      messages: [
        {
          type: 'func_result_msg',
          role: 'tool',
          genseq,
          id: args.call.callId,
          name: args.call.callName,
          content: formatReplyFuncErrorResult({
            attemptedCallName: args.call.callName,
            reason: 'no_active',
          }),
        },
      ],
    };
  }
  if (expectedCallName !== args.call.callName) {
    return {
      delivered: false,
      messages: [
        {
          type: 'func_result_msg',
          role: 'tool',
          genseq,
          id: args.call.callId,
          name: args.call.callName,
          content: formatReplyFuncErrorResult({
            attemptedCallName: args.call.callName,
            expectedCallName,
            reason: 'wrong_tool',
          }),
        },
      ],
    };
  }

  switch (args.call.callName) {
    case 'replyTellask':
    case 'replyTellaskSessionless': {
      if (!(args.dlg instanceof SubDialog)) {
        throw new Error(
          `${args.call.callName} invariant violation: only subdialogs may reply upstream`,
        );
      }
      const expectedCallName =
        args.call.callName === 'replyTellask' ? 'tellask' : 'tellaskSessionless';
      if (args.dlg.assignmentFromSup.callName !== expectedCallName) {
        throw new Error(
          `${args.call.callName} invariant violation: assignment callName=${args.dlg.assignmentFromSup.callName}`,
        );
      }
      const supplied = await supplySubdialogResponseToAssignedCallerIfPendingV2({
        subdialog: args.dlg,
        responseText: args.call.replyContent,
        responseGenseq: genseq,
        replyResolution: {
          callId: args.call.callId,
          replyCallName: args.call.callName,
        },
        scheduleDrive: args.callbacks.scheduleDrive,
      });
      if (!supplied) {
        return {
          delivered: false,
          messages: [
            {
              type: 'func_result_msg',
              role: 'tool',
              genseq,
              id: args.call.callId,
              name: args.call.callName,
              content: formatReplyFuncErrorResult({
                attemptedCallName: args.call.callName,
                reason: 'no_pending',
              }),
            },
          ],
        };
      }
      return {
        delivered: true,
        messages: [
          {
            type: 'func_result_msg',
            role: 'tool',
            genseq,
            id: args.call.callId,
            name: args.call.callName,
            content: formatReplyFuncResult({
              replyCallName: args.call.callName,
              replyContent: args.call.replyContent,
            }),
          },
        ],
      };
    }
    case 'replyTellaskBack': {
      if (activeDirective.expectedReplyCallName !== 'replyTellaskBack') {
        throw new Error('replyTellaskBack invariant violation: unexpected active reply directive');
      }
      await deliverTellaskBackReplyFromDirective({
        replyingDialog: args.dlg,
        directive: activeDirective,
        replyContent: args.call.replyContent,
        callbacks: args.callbacks,
        deliveryMode: 'reply_tool',
      });
      await args.dlg.appendTellaskReplyResolution({
        callId: args.call.callId,
        replyCallName: 'replyTellaskBack',
        targetCallId: activeDirective.targetCallId,
      });
      return {
        delivered: true,
        messages: [
          {
            type: 'func_result_msg',
            role: 'tool',
            genseq,
            id: args.call.callId,
            name: args.call.callName,
            content: formatReplyFuncResult({
              replyCallName: args.call.callName,
              replyContent: args.call.replyContent,
            }),
          },
        ],
      };
    }
  }
}

type ExecutableValidTellaskCall =
  | Readonly<{
      callName: 'tellask';
      mentionList: string[];
      tellaskContent: string;
      callId: string;
      targetAgentId: string;
      sessionSlug: string;
    }>
  | Readonly<{
      callName: 'tellaskSessionless';
      mentionList: string[];
      tellaskContent: string;
      callId: string;
      targetAgentId: string;
    }>
  | Readonly<{
      callName: 'tellaskBack';
      tellaskContent: string;
      callId: string;
    }>
  | Readonly<{
      callName: 'replyTellask';
      replyContent: string;
      callId: string;
    }>
  | Readonly<{
      callName: 'replyTellaskSessionless';
      replyContent: string;
      callId: string;
    }>
  | Readonly<{
      callName: 'replyTellaskBack';
      replyContent: string;
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
      effort?: number;
    }>;

function toExecutableValidTellaskCall(call: TellaskCall): ExecutableValidTellaskCall {
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
    case 'replyTellask':
    case 'replyTellaskSessionless':
    case 'replyTellaskBack':
      return {
        callName: call.callName,
        replyContent: call.replyContent,
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

async function executeValidTellaskCalls(args: {
  dlg: Dialog;
  calls: readonly ExecutableValidTellaskCall[];
  callbacks: KernelDriverDriveCallbacks;
  activePromptReplyDirective?: TellaskReplyDirective;
}): Promise<{ toolOutputs: ChatMessage[]; successfulReplyCallIds: string[] }> {
  const results: ChatMessage[][] = [];
  const successfulReplyCallIds: string[] = [];
  for (const call of args.calls) {
    const runtimeMentionList = (() => {
      switch (call.callName) {
        case 'tellask':
        case 'tellaskSessionless':
          return call.mentionList;
        case 'tellaskBack':
        case 'replyTellask':
        case 'replyTellaskSessionless':
        case 'replyTellaskBack':
        case 'askHuman':
        case 'freshBootsReasoning':
          return undefined;
      }
    })();
    if (!isReplyTellaskCallName(call.callName)) {
      const nonReplyCall = call as Exclude<ExecutableValidTellaskCall, { replyContent: string }>;
      const sessionSlug =
        nonReplyCall.callName === 'tellask' ? nonReplyCall.sessionSlug : undefined;
      await emitTellaskCallEvents({
        dlg: args.dlg,
        callName: nonReplyCall.callName,
        mentionList: runtimeMentionList,
        sessionSlug,
        tellaskContent: nonReplyCall.tellaskContent,
        callId: nonReplyCall.callId,
      });
    }
    let targetForError: string | undefined;
    let parseResult: TellaskRoutingParseResult | null;
    switch (call.callName) {
      case 'tellaskBack': {
        targetForError = args.dlg instanceof SubDialog ? args.dlg.supdialog.agentId : undefined;
        parseResult =
          args.dlg instanceof SubDialog ? { type: 'A', agentId: args.dlg.supdialog.agentId } : null;
        break;
      }
      case 'replyTellask':
      case 'replyTellaskSessionless':
      case 'replyTellaskBack': {
        const replyResult = await executeReplyTellaskCall({
          dlg: args.dlg,
          call,
          callbacks: args.callbacks,
          activePromptReplyDirective: args.activePromptReplyDirective,
        });
        if (replyResult.delivered) {
          successfulReplyCallIds.push(call.callId);
        }
        results.push(replyResult.messages);
        continue;
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
    if (isReplyTellaskCallName(call.callName)) {
      throw new Error(
        `replyTellask* control-flow invariant violation: unexpected call ${call.callName}`,
      );
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
        fbrEffortOverride: call.callName === 'freshBootsReasoning' ? call.effort : undefined,
      },
    );
    results.push(toolOutputs);
  }

  return {
    toolOutputs: results.flatMap((result) => result),
    successfulReplyCallIds,
  };
}

export async function executeTellaskCalls(args: {
  dlg: Dialog;
  calls: readonly TellaskCall[];
  callbacks: KernelDriverDriveCallbacks;
  activePromptReplyDirective?: TellaskReplyDirective;
}): Promise<{ toolOutputs: ChatMessage[]; successfulReplyCallIds: string[] }> {
  if (args.calls.length === 0) {
    return { toolOutputs: [], successfulReplyCallIds: [] };
  }

  return await executeValidTellaskCalls({
    dlg: args.dlg,
    calls: args.calls.map((call) => toExecutableValidTellaskCall(call)),
    callbacks: args.callbacks,
    activePromptReplyDirective: args.activePromptReplyDirective,
  });
}

export type TellaskFunctionRoundResult = Readonly<{
  normalCalls: readonly FuncCallMsg[];
  tellaskCallMessages: readonly FuncCallMsg[];
  tellaskResults: readonly FuncResultMsg[];
  toolOutputs: readonly ChatMessage[];
  handledCallIds: readonly string[];
  shouldStopAfterReplyTool: boolean;
}>;

export async function processTellaskFunctionRound(args: {
  dlg: Dialog;
  funcCalls: readonly FuncCallMsg[];
  allowedSpecials: ReadonlySet<TellaskCallFunctionName>;
  callbacks: KernelDriverDriveCallbacks;
  activePromptReplyDirective?: TellaskReplyDirective;
}): Promise<TellaskFunctionRoundResult> {
  type OrderedTellaskDisposition =
    | Readonly<{ kind: 'valid'; handled: ResolvedTellaskFunctionCall }>
    | Readonly<{ kind: 'invalid'; issue: InvalidTellaskFunctionCall }>;
  const multiAskHumanCalls = args.funcCalls.filter(
    (call) => call.name === 'askHuman' && args.allowedSpecials.has('askHuman'),
  );
  const funcCallsForResolution =
    multiAskHumanCalls.length > 1
      ? args.funcCalls.filter((call) => call.name !== 'askHuman')
      : args.funcCalls;
  const resolvedTellask = resolveTellaskFunctionCalls(funcCallsForResolution, {
    allowedSpecials: args.allowedSpecials,
  });
  const validByCallId = new Map(
    resolvedTellask.validCalls.map((handled) => [handled.originalCall.id, handled] as const),
  );
  const invalidByCallId = new Map(
    resolvedTellask.invalidCalls.map((issue) => [issue.originalCall.id, issue] as const),
  );
  const orderedSpecialDispositions: OrderedTellaskDisposition[] = [];
  for (const originalCall of args.funcCalls) {
    if (
      !isTellaskCallFunctionName(originalCall.name) ||
      !args.allowedSpecials.has(originalCall.name)
    ) {
      continue;
    }
    if (multiAskHumanCalls.length > 1 && originalCall.name === 'askHuman') {
      orderedSpecialDispositions.push({
        kind: 'invalid',
        issue: {
          originalCall,
          error: MULTIPLE_ASKHUMAN_CALLS_ERROR,
          rawArgumentsText: getRawArgumentsText(originalCall),
          contextArguments: getRawArgumentsText(originalCall),
        },
      });
      continue;
    }
    const handled = validByCallId.get(originalCall.id);
    if (handled) {
      orderedSpecialDispositions.push({ kind: 'valid', handled });
      continue;
    }
    const issue = invalidByCallId.get(originalCall.id);
    if (issue) {
      orderedSpecialDispositions.push({ kind: 'invalid', issue });
      continue;
    }
    throw new Error(
      `kernel-driver tellask special call invariant violation: unresolved tellask disposition for '${originalCall.id}' (${originalCall.name})`,
    );
  }
  const orderedValidCalls = orderedSpecialDispositions.flatMap((entry) =>
    entry.kind === 'valid' ? [entry.handled] : [],
  );
  const orderedInvalidCalls = orderedSpecialDispositions.flatMap((entry) =>
    entry.kind === 'invalid' ? [entry.issue] : [],
  );
  const specialCallById = new Map(
    orderedValidCalls.map(({ call }) => [call.callId, call] as const),
  );
  const originalCallById = new Map(args.funcCalls.map((call) => [call.id, call] as const));
  const tellaskCallMessages: FuncCallMsg[] = [];
  const issueResults: FuncResultMsg[] = [];
  for (const disposition of orderedSpecialDispositions) {
    if (disposition.kind === 'valid') {
      const handled = disposition.handled;
      await args.dlg.persistTellaskCall(
        handled.originalCall.id,
        handled.call.callName,
        getRawArgumentsText(handled.originalCall),
        handled.originalCall.genseq,
        {
          deliveryMode: isReplyTellaskCallName(handled.call.callName)
            ? 'func_call_requested'
            : 'tellask_call_start',
        },
      );
      tellaskCallMessages.push({
        type: 'func_call_msg',
        role: 'assistant',
        genseq: handled.originalCall.genseq,
        id: handled.originalCall.id,
        name: handled.call.callName,
        arguments: getRawArgumentsText(handled.originalCall),
      });
      continue;
    }

    const issue = disposition.issue;
    await args.dlg.funcCallRequested(
      issue.originalCall.id,
      issue.originalCall.name,
      issue.contextArguments,
    );
    const result = formatTellaskInvalidCallResult({
      call: issue.originalCall,
      error: issue.error,
    });
    await args.dlg.persistTellaskCallResultPair({
      id: issue.originalCall.id,
      name: issue.originalCall.name as TellaskCallFunctionName,
      rawArgumentsText: issue.rawArgumentsText,
      genseq: issue.originalCall.genseq,
      result,
      deliveryMode: 'func_call_requested',
    });
    tellaskCallMessages.push({
      type: 'func_call_msg',
      role: 'assistant',
      genseq: issue.originalCall.genseq,
      id: issue.originalCall.id,
      name: issue.originalCall.name,
      arguments: issue.rawArgumentsText,
    });
    issueResults.push(result);
  }

  let tellaskExecution: Awaited<ReturnType<typeof executeTellaskCalls>>;
  try {
    tellaskExecution = await executeTellaskCalls({
      dlg: args.dlg,
      calls: orderedValidCalls.map((handled) => handled.call),
      callbacks: args.callbacks,
      activePromptReplyDirective: args.activePromptReplyDirective,
    });
  } catch (err) {
    const errText = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    for (const { call } of orderedValidCalls) {
      if (issueResults.some((result) => result.id === call.callId)) {
        continue;
      }
      const originalCall = originalCallById.get(call.callId);
      if (!originalCall) {
        throw new Error(
          `kernel-driver tellask special call invariant violation: missing original call for '${call.callId}'`,
        );
      }
      await persistTellaskFuncResult(args.dlg, {
        type: 'func_result_msg',
        id: call.callId,
        name: call.callName,
        content: `Special function '${call.callName}' execution failed: ${errText}`,
        role: 'tool',
        genseq: originalCall.genseq,
      });
    }
    throw err;
  }

  const tellaskFuncResults: FuncResultMsg[] = [];
  const tellaskFuncResultByCallId = new Map<string, FuncResultMsg>();
  const tellaskToolOutputs: ChatMessage[] = [];
  for (const output of tellaskExecution.toolOutputs) {
    if (output.type === 'func_result_msg') {
      const result: FuncResultMsg = output;
      tellaskFuncResultByCallId.set(result.id, result);
      tellaskFuncResults.push(result);
      continue;
    }
    if (output.type === 'tellask_result_msg') {
      const callId = typeof output.callId === 'string' ? output.callId : '';
      if (callId === '') {
        tellaskToolOutputs.push(output);
        continue;
      }
      const originatingCall = specialCallById.get(callId);
      if (originatingCall) {
        const originalCall = originalCallById.get(callId);
        const result: FuncResultMsg = {
          type: 'func_result_msg',
          role: 'tool',
          genseq: originalCall?.genseq ?? 1,
          id: callId,
          name: originatingCall.callName,
          content: output.content,
        };
        tellaskFuncResultByCallId.set(callId, result);
        tellaskFuncResults.push(result);
      }
      continue;
    }
    tellaskToolOutputs.push(output);
  }

  for (const { call } of orderedValidCalls) {
    if (tellaskFuncResultByCallId.has(call.callId)) {
      continue;
    }
    const originalCall = originalCallById.get(call.callId);
    if (!originalCall) {
      throw new Error(
        `kernel-driver tellask call invariant violation: missing original call for '${call.callId}'`,
      );
    }
    const pendingResult = buildPendingTellaskFuncResult({
      callId: call.callId,
      callName: call.callName,
      genseq: originalCall.genseq,
    });
    tellaskFuncResultByCallId.set(call.callId, pendingResult);
    tellaskFuncResults.push(pendingResult);
  }

  for (const result of tellaskFuncResults) {
    await persistTellaskFuncResult(args.dlg, result);
  }

  return {
    normalCalls: resolvedTellask.normalCalls,
    tellaskCallMessages,
    tellaskResults: [...issueResults, ...tellaskFuncResults],
    toolOutputs: tellaskToolOutputs,
    handledCallIds: orderedValidCalls.map(({ call }) => call.callId),
    shouldStopAfterReplyTool: tellaskExecution.successfulReplyCallIds.length > 0,
  };
}
