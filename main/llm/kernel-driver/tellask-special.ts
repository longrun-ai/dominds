import { inspect } from 'util';

import type { NewQ4HAskedEvent } from '@longrun-ai/kernel/types/dialog';
import {
  toCallingCourseNumber,
  toCallingGenerationSeqNumber,
  toRootGenerationAnchor,
  type HumanQuestion,
  type PendingSideDialogStateRecord,
  type TellaskCallRecord,
  type TellaskReplyDirective,
} from '@longrun-ai/kernel/types/storage';
import { generateShortId } from '@longrun-ai/kernel/utils/id';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import type { AssignmentFromAsker } from '../../dialog';
import { Dialog, DialogID, MainDialog, SideDialog } from '../../dialog';
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
} from '../../runtime/driver-messages';
import {
  formatAskerDialogCallPrompt,
  formatAssignmentFromAskerDialog,
  formatTellaskResponseContent,
  formatUpdatedAssignmentFromAskerDialog,
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
import { supplySideDialogResponseToAssignedAskerIfPendingV2 } from './sideDialog';
import { withSideDialogTxnLock, withSideDialogTxnLocks } from './sideDialog-txn';
import type {
  KernelDriverDriveCallbacks,
  KernelDriverDriveCallOptions,
  KernelDriverRuntimeGuidePrompt,
  KernelDriverRuntimeReplyPrompt,
  KernelDriverRuntimeSideDialogPrompt,
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

export async function loadActiveTellaskReplyDirective(
  dialog: Dialog,
): Promise<TellaskReplyDirective | undefined> {
  const durableObligation = await DialogPersistence.loadActiveTellaskReplyObligation(
    dialog.id,
    dialog.status,
  );
  if (durableObligation) {
    return durableObligation;
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
  targetDialogId: string;
  targetCallId: string;
  tellaskContent: string;
}): TellaskReplyDirective {
  return {
    expectedReplyCallName: args.callName === 'tellask' ? 'replyTellask' : 'replyTellaskSessionless',
    targetDialogId: args.targetDialogId,
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
  // Type-A ask-back is the one place where the local tellasker/tellaskee intuition flips:
  // the dialog running `replyTellaskBack` is the ask-back tellaskee, while
  // directive.targetDialogId points to the ask-back asker that must receive the canonical
  // tellaskBack result. Keep those roles explicit, otherwise it is very easy to accidentally
  // write the same business result twice by confusing the tellaskee's local plaintext with the
  // canonical ask-back asker delivery that must come only from an explicit reply tool call.
  const mainDialog =
    args.replyingDialog instanceof MainDialog
      ? args.replyingDialog
      : args.replyingDialog instanceof SideDialog
        ? args.replyingDialog.mainDialog
        : undefined;
  if (!mainDialog) {
    throw new Error('replyTellaskBack invariant violation: missing main dialog');
  }
  const askBackAskerDialogId = new DialogID(args.directive.targetDialogId, mainDialog.id.rootId);
  const askBackAskerDialog =
    mainDialog.lookupDialog(askBackAskerDialogId.selfId) ??
    (await ensureDialogLoaded(mainDialog, askBackAskerDialogId, mainDialog.status));
  if (!askBackAskerDialog) {
    throw new Error(
      `replyTellaskBack invariant violation: target dialog ${askBackAskerDialogId.selfId} not found`,
    );
  }
  const response = formatTellaskResponseContent({
    callName: 'tellaskBack',
    callId: args.directive.targetCallId,
    responderId: args.replyingDialog.agentId,
    tellaskerId: askBackAskerDialog.agentId,
    tellaskContent: args.directive.tellaskContent,
    responseBody: args.replyContent,
    status: 'completed',
    deliveryMode: args.deliveryMode,
    language: getWorkLanguage(),
  });
  const targetCallOriginCourse = toCallingCourseNumber(askBackAskerDialog.currentCourse);
  const targetCallOriginGenseq = (() => {
    for (let i = askBackAskerDialog.msgs.length - 1; i >= 0; i -= 1) {
      const msg = askBackAskerDialog.msgs[i];
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
  const replyMirror = await askBackAskerDialog.receiveTellaskResponse(
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
      originMemberId: askBackAskerDialog.agentId,
      originCourse: targetCallOriginCourse,
      calling_genseq: targetCallOriginGenseq,
    },
  );
  await askBackAskerDialog.addChatMessages(replyMirror);
  // Do not mark the ask-back asker resumed until the canonical tellaskBack result has actually been
  // persisted and mirrored locally. Otherwise a write failure here would leave suspension state
  // claiming "resumed" while the business fact never landed.
  askBackAskerDialog.setSuspensionState('resumed');
  await reviveDialogIfUnblocked(askBackAskerDialog, args.callbacks, 'reply_tellask_back_delivered');
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
  callId?: string,
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
      ? [
          '[Dominds 诉请状态]',
          '',
          '`askHuman` 诉请已发出，当前仍在等待人类回复。',
          '',
          ...(callId ? [`- callId: ${callId}`] : []),
          `- 已等待: ${elapsed}`,
          '',
          '这不是回贴内容。若后续收到回复，运行时会在后续上下文中用同一 callId 补入对应回复事实。',
        ].join('\n')
      : [
          '[Dominds tellask status]',
          '',
          '`askHuman` has been issued and is still waiting for human reply.',
          '',
          ...(callId ? [`- callId: ${callId}`] : []),
          `- Elapsed: ${elapsed}`,
          '',
          'This is not reply content. If a reply arrives later, runtime will append the corresponding reply fact in later context with the same callId.',
        ].join('\n');
  }
  return language === 'zh'
    ? [
        '[Dominds 诉请状态]',
        '',
        `\`${name}\` 诉请已发出，当前仍在等待回贴。`,
        '',
        ...(callId ? [`- callId: ${callId}`] : []),
        `- 已等待: ${elapsed}`,
        '',
        '这不是回贴内容。若后续收到回贴，运行时会在后续上下文中用同一 callId 补入对应回贴事实。',
      ].join('\n')
    : [
        '[Dominds tellask status]',
        '',
        `\`${name}\` has been issued and is still waiting for a reply.`,
        '',
        ...(callId ? [`- callId: ${callId}`] : []),
        `- Elapsed: ${elapsed}`,
        '',
        'This is not reply content. If a reply arrives later, runtime will append the corresponding reply fact in later context with the same callId.',
      ].join('\n');
}

export function formatResolvedTellaskFuncResultContent(args: {
  name: TellaskCallFunctionName;
  callId: string;
  status: 'pending' | 'completed' | 'failed';
}): string {
  const language = getWorkLanguage();
  const callId = args.callId.trim();
  if (callId === '') {
    throw new Error(`tellask status formatter invariant violation: empty callId for ${args.name}`);
  }
  if (language === 'zh') {
    if (args.status === 'pending') {
      return [
        '[Dominds 诉请状态]',
        '',
        `\`${args.name}\` 诉请仍在等待回贴，当前没有回贴正文。`,
        '',
        `- callId: ${callId}`,
        '',
        '不要把本工具结果当作回贴正文；若后续收到回贴，运行时会用同一 callId 补入对应回贴事实。',
      ].join('\n');
    }
    const statusLabel = args.status === 'completed' ? '已收到回贴' : '已失败收口';
    return [
      '[Dominds 诉请状态]',
      '',
      `\`${args.name}\` 诉请${statusLabel}，对应回贴事实已作为独立上下文事实补入。`,
      '',
      `- callId: ${callId}`,
      '',
      '请以同一 callId 的独立回贴事实为准；不要把本工具结果当作回贴正文。',
    ].join('\n');
  }
  if (args.status === 'pending') {
    return [
      '[Dominds tellask status]',
      '',
      `\`${args.name}\` is still waiting for a reply; there is no reply body yet.`,
      '',
      `- callId: ${callId}`,
      '',
      'Do not treat this tool result as reply content. If a reply arrives later, runtime will append the corresponding reply fact with the same callId.',
    ].join('\n');
  }
  const statusLabel = args.status === 'completed' ? 'has received a reply' : 'has failed/closed';
  return [
    '[Dominds tellask status]',
    '',
    `\`${args.name}\` ${statusLabel}; the corresponding reply fact is present separately in context.`,
    '',
    `- callId: ${callId}`,
    '',
    'Use the separate reply fact with the same callId as authoritative; do not treat this tool result as reply content.',
  ].join('\n');
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
    content: formatPendingTellaskFuncResultContent(args.callName, null, args.callId),
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

type SideDialogCreateOptions = {
  callName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning';
  originMemberId: string;
  callerDialogId: string;
  callId: string;
  sessionSlug?: string;
  collectiveTargets?: string[];
  effectiveFbrEffort?: number;
};

async function createSideDialog(
  askerDialog: Dialog,
  targetAgentId: string,
  mentionList: string[] | undefined,
  tellaskContent: string,
  options: SideDialogCreateOptions,
): Promise<SideDialog> {
  return await askerDialog.createSideDialog(targetAgentId, mentionList, tellaskContent, options);
}

async function updateSideDialogAssignment(
  sideDialog: SideDialog,
  assignment: AssignmentFromAsker,
  options?: Readonly<{
    replacePendingCallId?: string;
    replacePendingAskerDialogId?: string;
  }>,
): Promise<void> {
  await DialogPersistence.updateSideDialogAssignment(
    sideDialog.id,
    assignment,
    sideDialog.status,
    options,
  );
  const nextAskerStackState = await DialogPersistence.loadSideDialogAskerStackState(
    sideDialog.id,
    sideDialog.status,
  );
  if (!nextAskerStackState) {
    throw new Error(`Missing asker stack after assignment update: ${sideDialog.id.valueOf()}`);
  }
  sideDialog.askerStack = nextAskerStackState;
}

async function lookupLiveRegisteredSideDialog(
  mainDialog: MainDialog,
  agentId: string,
  sessionSlug: string,
): Promise<SideDialog | undefined> {
  const existing = mainDialog.lookupSideDialog(agentId, sessionSlug);
  if (!existing) {
    return undefined;
  }
  const existingSession = existing.sessionSlug;
  if (!existingSession) {
    throw new Error(
      `Type B registry invariant violation: lookupSideDialog returned entry without sessionSlug (root=${mainDialog.id.valueOf()} sub=${existing.id.valueOf()})`,
    );
  }
  const latest = await DialogPersistence.loadDialogLatest(existing.id, mainDialog.status);
  const executionMarker = latest?.executionMarker;
  if (!executionMarker || executionMarker.kind !== 'dead') {
    return existing;
  }
  const removed = mainDialog.unregisterSideDialog(existing.agentId, existingSession);
  if (!removed) {
    throw new Error(
      `Failed to unregister dead registered sideDialog: root=${mainDialog.id.valueOf()} sub=${existing.id.valueOf()} session=${existingSession}`,
    );
  }
  await mainDialog.saveSideDialogRegistry();
  log.debug('Pruned dead registered sideDialog from Type B registry', undefined, {
    rootId: mainDialog.id.rootId,
    sideDialogId: existing.id.selfId,
    agentId: existing.agentId,
    sessionSlug: existingSession,
  });
  return undefined;
}

async function resolveDialogWithinRoot(
  mainDialog: MainDialog,
  callerDialogId: string,
): Promise<Dialog> {
  if (callerDialogId === mainDialog.id.selfId) {
    return mainDialog;
  }
  const live = mainDialog.lookupDialog(callerDialogId);
  if (live) {
    return live;
  }
  const restored = await ensureDialogLoaded(
    mainDialog,
    new DialogID(callerDialogId, mainDialog.id.rootId),
    mainDialog.status,
  );
  if (!restored) {
    throw new Error(
      `Type B asker restore invariant violation: root=${mainDialog.id.valueOf()} asker=${callerDialogId}`,
    );
  }
  return restored;
}

async function reviveDialogIfUnblocked(
  dialog: Dialog,
  callbacks: KernelDriverDriveCallbacks,
  reason: 'reply_tellask_back_delivered',
): Promise<void> {
  const suspension = await dialog.getSuspensionStatus({
    allowPendingSideDialogs: true,
  });
  if (!suspension.canDrive) {
    return;
  }
  if (dialog instanceof MainDialog) {
    await DialogPersistence.setNeedsDrive(dialog.id, true, dialog.status);
  }
  callbacks.scheduleDrive(dialog, {
    waitInQue: true,
    driveOptions: {
      source: 'kernel_driver_supply_response_parent_revive',
      reason,
      suppressDiligencePush: dialog.disableDiligencePush,
      noPromptSideDialogResumeEntitlement:
        dialog instanceof SideDialog
          ? {
              ownerDialogId: dialog.id.selfId,
              reason: 'reply_tellask_back_delivered',
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

function findDeliveredTellaskBackReplyOnAskBackAsker(args: {
  askerDialog: Dialog;
  targetCallId: string;
}): Extract<ChatMessage, { type: 'tellask_result_msg' }> | undefined {
  // `replyTellaskBack` persists the canonical tellaskBack business result onto the ask-back
  // asker immediately. Type-A orchestration must check that canonical delivery first
  // before it even considers any fallback extraction from tellaskee plaintext, or we risk a
  // second final result with the same target callId.
  for (let i = args.askerDialog.msgs.length - 1; i >= 0; i -= 1) {
    const msg = args.askerDialog.msgs[i];
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

async function extractAskBackTellaskeePlaintextFallback(args: {
  tellaskeeDialog: Dialog;
}): Promise<string> {
  try {
    return extractLastAssistantResponse(
      args.tellaskeeDialog.msgs,
      'AskerDialog completed without producing output.',
    );
  } catch (err) {
    log.warn('Failed to extract askerDialog response for Type A', err);
    return 'AskerDialog completed with errors.';
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
  if (!Number.isFinite(rawCallingCourse) || rawCallingCourse <= 0) {
    throw new Error(
      `tellask pending invariant violation: missing valid calling course ` +
        `(rootId=${dlg.id.rootId}, selfId=${dlg.id.selfId}, callId=${callId}, callName=${callName})`,
    );
  }
  const callingCourse = toCallingCourseNumber(rawCallingCourse);
  if (
    typeof dlg.activeGenSeqOrUndefined !== 'number' ||
    !Number.isInteger(dlg.activeGenSeqOrUndefined) ||
    dlg.activeGenSeqOrUndefined <= 0
  ) {
    throw new Error(
      `tellask pending invariant violation: missing active genseq ` +
        `(rootId=${dlg.id.rootId}, selfId=${dlg.id.selfId}, callId=${callId}, callName=${callName})`,
    );
  }
  const callingGenseq = toCallingGenerationSeqNumber(dlg.activeGenSeqOrUndefined);
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
    const sideDialogCallName: 'tellask' | 'tellaskSessionless' | 'freshBootsReasoning' =
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

      const askerDialog = dlg;
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

      const sub = await createSideDialog(dlg, parseResult.agentId, mentionList, body, {
        callName: sideDialogCallName,
        originMemberId,
        callerDialogId: askerDialog.id.selfId,
        callId,
        collectiveTargets,
        effectiveFbrEffort: fbrEffort,
      });
      sub.setFbrConclusionToolsEnabled(false);
      const pendingRecord: PendingSideDialogStateRecord = {
        sideDialogId: sub.id.selfId,
        createdAt: formatUnifiedTimestamp(new Date()),
        callName: sideDialogCallName,
        mentionList,
        tellaskContent: body,
        targetAgentId: parseResult.agentId,
        callId,
        callingCourse,
        callingGenseq,
        callType: 'C',
      };
      await withSideDialogTxnLock(dlg.id, async () => {
        await DialogPersistence.appendPendingSideDialog(
          dlg.id,
          pendingRecord,
          toRootGenerationAnchor({
            rootCourse:
              dlg instanceof SideDialog ? dlg.mainDialog.currentCourse : dlg.currentCourse,
            rootGenseq:
              dlg instanceof SideDialog
                ? (dlg.mainDialog.activeGenSeqOrUndefined ?? 0)
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
          source: 'kernel_driver_sideDialog_init',
          reason: 'fresh_boots_reasoning_sideDialog_init',
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
      if (dlg instanceof SideDialog) {
        // Identity map for Type-A ask-back:
        // - `askBackAskerDialog` is the Side Dialog that asked the tellasker for clarification.
        // - `askBackTellaskeeDialog` is the tellasker that must answer that ask-back.
        // The original tellask relationship is the opposite of the current ask-back relationship,
        // so variable names like "askerDialog" or "target" are too lossy here and invite bugs.
        const askBackAskerDialog = dlg;
        const askBackTellaskeeDialog = dlg.askerDialog;
        askBackAskerDialog.setSuspensionState('suspended');

        try {
          const assignment = askBackAskerDialog.assignmentFromAsker;
          const tellaskBackReplyDirective = buildTellaskBackReplyDirective({
            targetDialogId: askBackAskerDialog.id.selfId,
            targetCallId: callId,
            tellaskContent: body,
          });
          await DialogPersistence.pushTellaskReplyObligation(
            askBackTellaskeeDialog.id,
            tellaskBackReplyDirective,
            askBackTellaskeeDialog.status,
          );
          if (askBackTellaskeeDialog instanceof SideDialog) {
            const nextAskerStackState = await DialogPersistence.loadSideDialogAskerStackState(
              askBackTellaskeeDialog.id,
              askBackTellaskeeDialog.status,
            );
            if (!nextAskerStackState) {
              throw new Error(
                `Missing asker stack after tellaskBack push: ${askBackTellaskeeDialog.id.valueOf()}`,
              );
            }
            askBackTellaskeeDialog.askerStack = nextAskerStackState;
          }
          const askerPrompt: KernelDriverRuntimeReplyPrompt = {
            content: formatAskerDialogCallPrompt({
              fromAgentId: askBackAskerDialog.agentId,
              toAgentId: askBackTellaskeeDialog.agentId,
              sideDialogRequest: {
                callName,
                mentionList,
                tellaskContent: body,
              },
              askerDialogAssignment: {
                callName: assignment.callName,
                mentionList: assignment.mentionList,
                tellaskContent: assignment.tellaskContent,
              },
              language: getWorkLanguage(),
            }),
            msgId: generateShortId(),
            grammar: 'markdown',
            origin: 'runtime',
            tellaskReplyDirective: tellaskBackReplyDirective,
          };
          await callbacks.driveDialog(askBackTellaskeeDialog, {
            humanPrompt: askerPrompt,
            waitInQue: true,
            driveOptions: {
              source: 'kernel_driver_type_a_askerDialog_call',
              reason: 'type_a_askerDialog_roundtrip',
            },
          });

          const explicitReplyDelivery = findDeliveredTellaskBackReplyOnAskBackAsker({
            askerDialog: askBackAskerDialog,
            targetCallId: callId,
          });
          if (explicitReplyDelivery) {
            // Important invariant: once the tellaskee used `replyTellaskBack`, that write is the
            // single source of truth. Do not also synthesize another tellask result from the
            // tellaskee's generic assistant words, even if those words look "compatible".
            askBackAskerDialog.setSuspensionState('resumed');
            toolOutputs.push(explicitReplyDelivery);
            return toolOutputs;
          }

          const responseText = await extractAskBackTellaskeePlaintextFallback({
            tellaskeeDialog: askBackTellaskeeDialog,
          });
          const responseContent = formatTellaskResponseContent({
            callName,
            callId,
            responderId: parseResult.agentId,
            tellaskerId: askBackAskerDialog.agentId,
            mentionList,
            tellaskContent: body,
            responseBody: responseText,
            status: 'completed',
            deliveryMode: 'direct_fallback',
            language: getWorkLanguage(),
          });

          askBackAskerDialog.setSuspensionState('resumed');

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
              originMemberId: askBackAskerDialog.agentId,
              calleeDialogId: askBackTellaskeeDialog.id.selfId,
            }),
          );
          await askBackAskerDialog.receiveTellaskResponse(
            parseResult.agentId,
            callName,
            mentionList,
            body,
            'completed',
            askBackTellaskeeDialog.id,
            {
              response: responseContent,
              agentId: parseResult.agentId,
              callId,
              originMemberId: askBackAskerDialog.agentId,
              originCourse: callingCourse,
              calling_genseq: callingGenseq,
            },
          );
        } catch (err) {
          log.warn('Type A askerDialog processing error:', err);
          askBackAskerDialog.setSuspensionState('resumed');
          const errorText = `❌ **Error processing request to @${parseResult.agentId}:**\n\n${showErrorToAi(err)}`;
          const errorContent = formatTellaskResponseContent({
            callName,
            callId,
            responderId: parseResult.agentId,
            tellaskerId: askBackAskerDialog.agentId,
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
              originMemberId: askBackAskerDialog.agentId,
              calleeDialogId: askBackTellaskeeDialog.id.selfId,
            }),
          );
          await askBackAskerDialog.receiveTellaskResponse(
            parseResult.agentId,
            callName,
            mentionList,
            body,
            'failed',
            askBackTellaskeeDialog.id,
            {
              response: errorContent,
              agentId: parseResult.agentId,
              callId,
              originMemberId: askBackAskerDialog.agentId,
              originCourse: callingCourse,
              calling_genseq: callingGenseq,
            },
          );
        }
      } else {
        const err = new Error(
          `Type A tellaskBack invariant violation: dialog is not a sideDialog ` +
            `(rootId=${dlg.id.rootId}, selfId=${dlg.id.selfId}, callId=${callId})`,
        );
        log.error('Type A tellaskBack invariant violation: dialog is not a sideDialog', err, {
          rootId: dlg.id.rootId,
          selfId: dlg.id.selfId,
          course: callingCourse,
          genseq: callingGenseq,
          callId,
        });
        throw err;
      }
    } else if (parseResult.type === 'B') {
      const askerDialog = dlg;
      let mainDialog: MainDialog | undefined;
      if (dlg instanceof MainDialog) {
        mainDialog = dlg;
      } else if (dlg instanceof SideDialog) {
        mainDialog = dlg.mainDialog;
      }

      if (!mainDialog) {
        const err = new Error(
          `Type B tellask invariant violation: missing mainDialog ` +
            `(rootId=${dlg.id.rootId}, selfId=${dlg.id.selfId}, callId=${callId})`,
        );
        log.error('Type B tellask invariant violation: missing mainDialog', err, {
          rootId: dlg.id.rootId,
          selfId: dlg.id.selfId,
          course: callingCourse,
          genseq: callingGenseq,
          callId,
          sessionSlug: parseResult.sessionSlug,
        });
        throw err;
      } else {
        const originMemberId = dlg.agentId;
        const assignment: AssignmentFromAsker = {
          callName: sideDialogCallName,
          mentionList,
          tellaskContent: body,
          originMemberId,
          callerDialogId: askerDialog.id.selfId,
          callId,
          collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
        };
        const pendingOwner = askerDialog;
        const isSameRegisteredSessionPending = (record: PendingSideDialogStateRecord): boolean =>
          record.callType === 'B' &&
          record.callName === 'tellask' &&
          record.targetAgentId === parseResult.agentId &&
          record.sessionSlug === parseResult.sessionSlug;
        const result = await (async (): Promise<
          | {
              kind: 'created';
              sideDialog: SideDialog;
            }
          | {
              kind: 'existing';
              sideDialog: SideDialog;
              previousPendingOwnerId: string;
            }
        > => {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const seededExisting = mainDialog.lookupSideDialog(
              parseResult.agentId,
              parseResult.sessionSlug,
            );
            const seededPreviousAskerId = seededExisting?.assignmentFromAsker.callerDialogId;
            const lockIds: DialogID[] = [mainDialog.id, pendingOwner.id];
            if (
              seededPreviousAskerId !== undefined &&
              seededPreviousAskerId !== mainDialog.id.selfId &&
              seededPreviousAskerId !== pendingOwner.id.selfId
            ) {
              lockIds.push(new DialogID(seededPreviousAskerId, mainDialog.id.rootId));
            }

            const attemptResult = await withSideDialogTxnLocks(lockIds, async () => {
              const existing = await lookupLiveRegisteredSideDialog(
                mainDialog,
                parseResult.agentId,
                parseResult.sessionSlug,
              );
              if (existing) {
                if (existing.assignmentFromAsker.callerDialogId !== seededPreviousAskerId) {
                  return { kind: 'retry' as const };
                }
                const previousAssignment = existing.assignmentFromAsker;
                const pendingRecord: PendingSideDialogStateRecord = {
                  sideDialogId: existing.id.selfId,
                  createdAt: formatUnifiedTimestamp(new Date()),
                  callName: sideDialogCallName,
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
                  if (previousAssignment.callerDialogId !== pendingOwner.id.selfId) {
                    await DialogPersistence.mutatePendingSideDialogs(
                      new DialogID(previousAssignment.callerDialogId, mainDialog.id.rootId),
                      (previousPending) => ({
                        kind: 'replace',
                        records: previousPending.filter(
                          (record) => !isSameRegisteredSessionPending(record),
                        ),
                      }),
                      undefined,
                      pendingOwner.status,
                    );
                  }

                  await DialogPersistence.mutatePendingSideDialogs(
                    pendingOwner.id,
                    (previousPending) => ({
                      kind: 'replace',
                      records: [
                        ...previousPending.filter(
                          (record) => !isSameRegisteredSessionPending(record),
                        ),
                        pendingRecord,
                      ],
                    }),
                    undefined,
                    pendingOwner.status,
                  );

                  await updateSideDialogAssignment(existing, assignment, {
                    replacePendingCallId: previousAssignment.callId,
                    replacePendingAskerDialogId: previousAssignment.callerDialogId,
                  });
                  return {
                    kind: 'existing' as const,
                    sideDialog: existing,
                    previousPendingOwnerId: previousAssignment.callerDialogId,
                  };
                } catch (err) {
                  log.error('Failed to update registered sideDialog assignment', err, {
                    rootId: mainDialog.id.rootId,
                    sideDialogId: existing.id.selfId,
                    ownerDialogId: pendingOwner.id.selfId,
                    callId,
                    sessionSlug: parseResult.sessionSlug,
                  });
                  throw err;
                }
              }

              if (seededPreviousAskerId !== undefined) {
                return { kind: 'retry' as const };
              }

              const created = await createSideDialog(
                mainDialog,
                parseResult.agentId,
                mentionList,
                body,
                {
                  callName: sideDialogCallName,
                  originMemberId,
                  callerDialogId: askerDialog.id.selfId,
                  callId,
                  sessionSlug: parseResult.sessionSlug,
                  collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
                },
              );
              mainDialog.registerSideDialog(created);
              await mainDialog.saveSideDialogRegistry();
              const pendingRecord: PendingSideDialogStateRecord = {
                sideDialogId: created.id.selfId,
                createdAt: formatUnifiedTimestamp(new Date()),
                callName: sideDialogCallName,
                mentionList,
                tellaskContent: body,
                targetAgentId: parseResult.agentId,
                callId,
                callingCourse,
                callingGenseq,
                callType: 'B',
                sessionSlug: parseResult.sessionSlug,
              };
              await DialogPersistence.appendPendingSideDialog(
                pendingOwner.id,
                pendingRecord,
                undefined,
                pendingOwner.status,
              );
              return { kind: 'created' as const, sideDialog: created };
            });
            if (attemptResult.kind !== 'retry') {
              return attemptResult;
            }
          }
          throw new Error(
            `Type B registered sideDialog mutation failed to stabilize: root=${mainDialog.id.valueOf()} agent=${parseResult.agentId} session=${parseResult.sessionSlug}`,
          );
        })();

        await syncPendingTellaskReminderBestEffort(
          pendingOwner,
          'kernel-driver:executeTellaskCall:TypeB:pushPendingAssignment',
        );
        if (
          result.kind === 'existing' &&
          result.previousPendingOwnerId !== pendingOwner.id.selfId
        ) {
          const previousPendingOwner = mainDialog.lookupDialog(result.previousPendingOwnerId);
          if (previousPendingOwner) {
            await syncPendingTellaskReminderBestEffort(
              previousPendingOwner,
              'kernel-driver:executeTellaskCall:TypeB:replacePreviousPendingAssignment',
            );
          }
        }

        if (result.kind === 'existing') {
          const resumePrompt: KernelDriverRuntimeSideDialogPrompt = {
            content: formatUpdatedAssignmentFromAskerDialog({
              callName: sideDialogCallName,
              fromAgentId: dlg.agentId,
              toAgentId: result.sideDialog.agentId,
              mentionList,
              sessionSlug: parseResult.sessionSlug,
              tellaskContent: body,
              language: getWorkLanguage(),
              collectiveTargets: options?.collectiveTargets ?? [result.sideDialog.agentId],
            }),
            msgId: generateShortId(),
            grammar: 'markdown',
            origin: 'runtime',
            tellaskReplyDirective: buildAssignmentReplyDirective({
              callName: 'tellask',
              targetDialogId: pendingOwner.id.selfId,
              targetCallId: callId,
              tellaskContent: body,
            }),
            sideDialogReplyTarget: {
              ownerDialogId: pendingOwner.id.selfId,
              callType: 'B',
              callId,
            },
          };
          let queuedIntoActiveLoop = false;
          let queuedRuntimePrompt = false;
          try {
            result.sideDialog.queueRegisteredAssignmentUpdatePrompt({
              prompt: resumePrompt.content,
              msgId: resumePrompt.msgId,
              grammar: resumePrompt.grammar,
              userLanguageCode: resumePrompt.userLanguageCode,
              tellaskReplyDirective: resumePrompt.tellaskReplyDirective,
              skipTaskdoc: resumePrompt.skipTaskdoc,
              sideDialogReplyTarget: resumePrompt.sideDialogReplyTarget,
            });
            queuedRuntimePrompt = true;
            queuedIntoActiveLoop = result.sideDialog.isLocked();
          } catch (err) {
            log.warn('Failed to queue registered sideDialog update into active loop', err, {
              sideDialogId: result.sideDialog.id.valueOf(),
              sessionSlug: parseResult.sessionSlug,
              callId,
            });
          }
          if (queuedRuntimePrompt && !queuedIntoActiveLoop) {
            callbacks.scheduleDrive(result.sideDialog, {
              waitInQue: true,
              driveOptions: {
                source: 'kernel_driver_sideDialog_resume',
                reason: 'type_b_registered_sideDialog_resume',
              },
            });
          } else if (!queuedRuntimePrompt) {
            callbacks.scheduleDrive(result.sideDialog, {
              humanPrompt: resumePrompt,
              waitInQue: true,
              driveOptions: {
                source: 'kernel_driver_sideDialog_resume',
                reason: 'type_b_registered_sideDialog_resume',
              },
            });
          }
        } else {
          const initPrompt: KernelDriverRuntimeSideDialogPrompt = {
            content: formatAssignmentFromAskerDialog({
              callName: sideDialogCallName,
              fromAgentId: mainDialog.agentId,
              toAgentId: result.sideDialog.agentId,
              mentionList,
              sessionSlug: parseResult.sessionSlug,
              tellaskContent: body,
              language: getWorkLanguage(),
              collectiveTargets: options?.collectiveTargets ?? [result.sideDialog.agentId],
            }),
            msgId: generateShortId(),
            grammar: 'markdown',
            origin: 'runtime',
            tellaskReplyDirective: buildAssignmentReplyDirective({
              callName: 'tellask',
              targetDialogId: pendingOwner.id.selfId,
              targetCallId: callId,
              tellaskContent: body,
            }),
            sideDialogReplyTarget: {
              ownerDialogId: pendingOwner.id.selfId,
              callType: 'B',
              callId,
            },
          };
          callbacks.scheduleDrive(result.sideDialog, {
            humanPrompt: initPrompt,
            waitInQue: true,
            driveOptions: {
              source: 'kernel_driver_sideDialog_init',
              reason: 'type_b_registered_sideDialog_init',
            },
          });
        }
      }
    }

    if (parseResult.type === 'C') {
      try {
        const sub = await createSideDialog(dlg, parseResult.agentId, mentionList, body, {
          callName: sideDialogCallName,
          originMemberId: dlg.agentId,
          callerDialogId: dlg.id.selfId,
          callId,
          collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
        });
        const pendingRecord: PendingSideDialogStateRecord = {
          sideDialogId: sub.id.selfId,
          createdAt: formatUnifiedTimestamp(new Date()),
          callName: sideDialogCallName,
          mentionList,
          tellaskContent: body,
          targetAgentId: parseResult.agentId,
          callId,
          callingCourse,
          callingGenseq,
          callType: 'C',
        };
        await withSideDialogTxnLock(dlg.id, async () => {
          await DialogPersistence.appendPendingSideDialog(
            dlg.id,
            pendingRecord,
            toRootGenerationAnchor({
              rootCourse:
                dlg instanceof SideDialog ? dlg.mainDialog.currentCourse : dlg.currentCourse,
              rootGenseq:
                dlg instanceof SideDialog
                  ? (dlg.mainDialog.activeGenSeqOrUndefined ?? 0)
                  : (dlg.activeGenSeqOrUndefined ?? 0),
            }),
          );
        });
        await syncPendingTellaskReminderBestEffort(
          dlg,
          'kernel-driver:executeTellaskCall:TypeC:appendPending',
        );

        const initPrompt: KernelDriverRuntimeSideDialogPrompt = {
          content: formatAssignmentFromAskerDialog({
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
            targetDialogId: dlg.id.selfId,
            targetCallId: callId,
            tellaskContent: body,
          }),
          sideDialogReplyTarget: {
            ownerDialogId: dlg.id.selfId,
            callType: 'C',
            callId,
          },
        };
        callbacks.scheduleDrive(sub, {
          humanPrompt: initPrompt,
          waitInQue: true,
          driveOptions: {
            source: 'kernel_driver_sideDialog_init',
            reason: 'type_c_sideDialog_init',
          },
        });
      } catch (err) {
        log.error('SideDialog creation error', err, {
          rootId: dlg.id.rootId,
          selfId: dlg.id.selfId,
          callId,
          callName,
          targetAgentId: parseResult.agentId,
        });
        throw err;
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
    args.activePromptReplyDirective ?? (await loadActiveTellaskReplyDirective(args.dlg));
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
      if (!(args.dlg instanceof SideDialog)) {
        throw new Error(
          `${args.call.callName} invariant violation: only sideDialogs may reply to the tellasker`,
        );
      }
      const assignmentCallName = args.dlg.assignmentFromAsker.callName;
      const assignmentMatchesReplyCall =
        args.call.callName === 'replyTellask'
          ? assignmentCallName === 'tellask'
          : assignmentCallName === 'tellaskSessionless' ||
            assignmentCallName === 'freshBootsReasoning';
      if (!assignmentMatchesReplyCall) {
        throw new Error(
          `${args.call.callName} invariant violation: assignment callName=${assignmentCallName}`,
        );
      }
      const supplied = await supplySideDialogResponseToAssignedAskerIfPendingV2({
        sideDialog: args.dlg,
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
      const nextAskerStackState = await DialogPersistence.loadSideDialogAskerStackState(
        args.dlg.id,
        args.dlg.status,
      );
      if (!nextAskerStackState) {
        throw new Error(`Missing asker stack after reply delivery: ${args.dlg.id.valueOf()}`);
      }
      args.dlg.askerStack = nextAskerStackState;
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
  const deferredScheduleCalls: Array<
    Readonly<{ dialog: Dialog; options: KernelDriverDriveCallOptions }>
  > = [];
  const registrationPhaseCallbacks: KernelDriverDriveCallbacks = {
    driveDialog: args.callbacks.driveDialog,
    scheduleDrive: (dialog, options) => {
      deferredScheduleCalls.push({ dialog, options });
    },
  };
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
        targetForError = args.dlg instanceof SideDialog ? args.dlg.askerDialog.agentId : undefined;
        parseResult =
          args.dlg instanceof SideDialog
            ? { type: 'A', agentId: args.dlg.askerDialog.agentId }
            : null;
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
      registrationPhaseCallbacks,
      {
        callName: call.callName,
        parseResult,
        targetForError,
        fbrEffortOverride: call.callName === 'freshBootsReasoning' ? call.effort : undefined,
      },
    );
    results.push(toolOutputs);
  }

  for (const scheduled of deferredScheduleCalls) {
    args.callbacks.scheduleDrive(scheduled.dialog, scheduled.options);
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
    | Readonly<{
        kind: 'invalid';
        callName: TellaskCallFunctionName;
        issue: InvalidTellaskFunctionCall;
      }>;
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
        callName: originalCall.name,
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
      orderedSpecialDispositions.push({ kind: 'invalid', callName: originalCall.name, issue });
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
      name: disposition.callName,
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
