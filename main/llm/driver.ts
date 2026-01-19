/**
 * Module: llm/driver
 *
 * Drives dialog streaming end-to-end:
 * - Loads minds/tools, selects generator, streams outputs
 * - Parses texting/code blocks, executes tools, handles human prompts
 * - Supports autonomous teammate calls: when an agent mentions a teammate (e.g., @teammate), a subdialog is created and driven; the parent logs the initiating assistant bubble and system creation/result, while subdialog conversation stays in the subdialog
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AssignmentFromSup } from '../dialog';
import { Dialog, DialogID, RootDialog, SubDialog } from '../dialog';

import { inspect } from 'util';
import { globalDialogRegistry } from '../dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreRootDialog } from '../dialog-instance-registry';
import {
  broadcastRunStateMarker,
  clearActiveRun,
  computeIdleRunState,
  createActiveRun,
  getStopRequestedReason,
  setDialogRunState,
} from '../dialog-run-state';
import { postDialogEvent } from '../evt-registry';
import { extractErrorDetails, log } from '../log';
import { loadAgentMinds } from '../minds/load';
import { DialogPersistence } from '../persistence';
import { removeProblem, upsertProblem } from '../problems';
import { AsyncFifoMutex } from '../shared/async-fifo-mutex';
import {
  formatDomindsNoteDirectSelfCall,
  formatDomindsNoteSuperNoTopic,
  formatDomindsNoteSuperOnlyInSubdialog,
  formatReminderIntro,
  formatReminderItemGuide,
  formatUserFacingLanguageGuide,
} from '../shared/i18n/driver-messages';
import { getWorkLanguage } from '../shared/runtime-language';
import type { ContextHealthSnapshot, LlmUsageStats } from '../shared/types/context-health';
import type { NewQ4HAskedEvent } from '../shared/types/dialog';
import type { LanguageCode } from '../shared/types/language';
import type { DialogInterruptionReason, DialogRunState } from '../shared/types/run-state';
import type { HumanQuestion, UserTextGrammar } from '../shared/types/storage';
import { generateShortId } from '../shared/utils/id';
import {
  formatAssignmentFromSupdialog,
  formatSupdialogCallPrompt,
  formatTeammateResponseContent,
} from '../shared/utils/inter-dialog-format';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import { Team } from '../team';
import {
  CollectedTextingCall,
  TextingEventsReceiver,
  TextingStreamParser,
  extractMentions,
} from '../texting';
import type { ToolArguments } from '../tool';
import { FuncTool, TextingTool, Tool, validateArgs } from '../tool';
import { contextHealthReminderOwner } from '../tools/context-health';
import { getTool } from '../tools/registry';
import { generateDialogID } from '../utils/id';
import { formatTaskDocContent } from '../utils/task-doc';
import {
  ChatMessage,
  FuncCallMsg,
  FuncResultMsg,
  LlmConfig,
  type ModelInfo,
  type ProviderConfig,
  SayingMsg,
  TextingCallResultMsg,
  ThinkingMsg,
} from './client';
import { getLlmGenerator } from './gen/registry';
import { projectFuncToolsForProvider } from './tools-projection';

// === HUMAN PROMPT TYPE ===

export interface HumanPrompt {
  content: string;
  msgId: string; // Message ID for tracking and error recovery (required for all human text)
  grammar: UserTextGrammar;
  userLanguageCode?: LanguageCode;
}

type UpNextPrompt = { prompt: string; msgId: string; userLanguageCode?: LanguageCode };

// === SUSPENSION AND RESUMPTION INTERFACES ===

export interface DialogSuspension {
  rootDialogId: string;
  subdialogIds: string[];
  pendingQuestions: PendingQuestion[];
  suspensionPoint: string; // Where the dialog was suspended
  suspendedAt: string;
  parentDialogId?: string; // If this is a subdialog suspension
}

export interface PendingQuestion {
  id: string;
  rootDialogId: string;
  subdialogId?: string; // undefined for root dialog questions
  question: string;
  context: string;
  askedAt: string;
  priority: 'low' | 'medium' | 'high';
}

// === PENDING SUBDIALOG RECORD TYPE ===
type PendingSubdialogRecordType = {
  subdialogId: string;
  createdAt: string;
  headLine: string;
  targetAgentId: string;
  callType: 'A' | 'B' | 'C';
  topicId?: string;
};

export interface ResumptionContext {
  // Which dialog(s) to respond to
  targetType: 'root' | 'subdialog' | 'multiple' | 'hierarchy';
  rootDialogId?: string;
  subdialogIds?: string[];

  // What type of response
  responseType: 'answer' | 'followup' | 'retry' | 'new_message';

  // Response data
  humanResponse?: HumanPrompt;
  newMessage?: HumanPrompt;
  retryContext?: {
    toolName: string;
    previousArgs: ToolArguments;
    errorContext: string;
  };
}

export interface DialogTree {
  rootDialogId: string;
  subdialogs: Map<string, SubdialogInfo>;
  suspensionMap: Map<string, DialogSuspension>;
}

export interface SubdialogInfo {
  id: string;
  parentDialogId: string;
  agentId: string;
  headLine: string;
  status: 'active' | 'suspended' | 'completed' | 'failed';
  round: number;
  createdAt: string;
}

function showErrorToAi(err: unknown): string {
  try {
    if (err instanceof Error) {
      return `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`;
    }

    if (typeof err === 'string') {
      const s = err.trim();
      return s.length > 500 ? s.slice(0, 497) + '...' : s;
    }
    return inspect(err, { depth: 5, breakLength: 120, compact: false, sorted: true });
  } catch (fallbackErr) {
    return `Unknown error of type ${typeof err}`;
  }
}

class DialogInterruptedError extends Error {
  public readonly reason: DialogInterruptionReason;

  constructor(reason: DialogInterruptionReason) {
    super('Dialog interrupted');
    this.reason = reason;
  }
}

function throwIfAborted(abortSignal: AbortSignal | undefined, dlgId: DialogID): void {
  if (!abortSignal?.aborted) return;

  const stopRequested = getStopRequestedReason(dlgId);
  if (stopRequested === 'emergency_stop') {
    throw new DialogInterruptedError({ kind: 'emergency_stop' });
  }
  if (stopRequested === 'user_stop') {
    throw new DialogInterruptedError({ kind: 'user_stop' });
  }
  throw new DialogInterruptedError({ kind: 'system_stop', detail: 'Aborted.' });
}

/**
 * Validate streaming configuration for a team member.
 * Streaming supports function tools; no restrictions to enforce here.
 */
function validateStreamingConfiguration(_agent: Team.Member, _agentTools: Tool[]): void {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateFuncToolArguments(
  tool: FuncTool,
  rawArgs: unknown,
): { ok: true; args: ToolArguments } | { ok: false; error: string } {
  if (!isPlainObject(rawArgs)) {
    return { ok: false, error: 'Arguments must be an object' };
  }
  if (tool.argsValidation === 'passthrough') {
    return { ok: true, args: rawArgs as ToolArguments };
  }
  const validation = validateArgs(tool.parameters, rawArgs);
  return validation.ok
    ? { ok: true, args: rawArgs as ToolArguments }
    : { ok: false, error: validation.error };
}

type LlmFailureKind = 'retriable' | 'rejected' | 'fatal';

type ClassifiedLlmFailure = {
  kind: LlmFailureKind;
  message: string;
  status?: number;
  code?: string;
};

function classifyLlmFailure(err: unknown): ClassifiedLlmFailure {
  const fallbackMessage =
    err instanceof Error
      ? err.message || err.name
      : typeof err === 'string'
        ? err
        : JSON.stringify(err);

  if (err instanceof Error && err.message === 'AbortError') {
    return { kind: 'fatal', message: 'Aborted.' };
  }

  if (isPlainObject(err)) {
    const status =
      'status' in err && typeof err.status === 'number'
        ? err.status
        : 'statusCode' in err && typeof err.statusCode === 'number'
          ? err.statusCode
          : undefined;

    const code =
      'code' in err && typeof err.code === 'string'
        ? err.code
        : 'errno' in err && typeof err.errno === 'string'
          ? err.errno
          : undefined;

    const msg =
      'message' in err && typeof err.message === 'string' && err.message.length > 0
        ? err.message
        : fallbackMessage;

    if (typeof status === 'number') {
      if (status === 408 || status === 429 || status >= 500) {
        return { kind: 'retriable', status, message: msg };
      }
      if (status >= 400 && status < 500) {
        return { kind: 'rejected', status, message: msg };
      }
    }

    if (typeof code === 'string') {
      const retriableCodes = new Set<string>([
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'EAI_AGAIN',
        'ENOTFOUND',
        'ENETUNREACH',
        'EHOSTUNREACH',
      ]);
      if (retriableCodes.has(code)) {
        return { kind: 'retriable', code, message: msg };
      }
    }

    const lower = msg.toLowerCase();
    if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('rate limit')) {
      return { kind: 'retriable', message: msg };
    }
  }

  return { kind: 'fatal', message: fallbackMessage };
}

async function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted) {
    throw new Error('AbortError');
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
  if (abortSignal?.aborted) {
    throw new Error('AbortError');
  }
}

async function runLlmRequestWithRetry<T>(params: {
  dlg: Dialog;
  provider: string;
  abortSignal?: AbortSignal;
  maxRetries: number;
  canRetry: () => boolean;
  doRequest: () => Promise<T>;
}): Promise<T> {
  const providerProblemId = `llm/provider_rejected/${params.dlg.id.valueOf()}`;

  for (let attempt = 0; attempt <= params.maxRetries; attempt++) {
    try {
      const res = await params.doRequest();
      removeProblem(providerProblemId);
      return res;
    } catch (err) {
      if (params.abortSignal?.aborted) {
        throw err;
      }

      const failure = classifyLlmFailure(err);
      const detail = extractErrorDetails(err).message;

      if (failure.kind === 'rejected') {
        upsertProblem({
          kind: 'llm_provider_rejected_request',
          source: 'llm',
          id: providerProblemId,
          severity: 'error',
          timestamp: formatUnifiedTimestamp(new Date()),
          message: `LLM provider rejected the request`,
          detail: {
            dialogId: params.dlg.id.valueOf(),
            provider: params.provider,
            errorText: detail,
          },
        });
        try {
          await params.dlg.streamError(detail);
        } catch (_emitErr) {
          // best-effort
        }
        throw new DialogInterruptedError({
          kind: 'system_stop',
          detail: `Provider '${params.provider}' rejected the request: ${failure.message}`,
        });
      }

      const canRetry = failure.kind === 'retriable' && params.canRetry();
      const isLastAttempt = attempt >= params.maxRetries;
      if (!canRetry || isLastAttempt) {
        try {
          await params.dlg.streamError(detail);
        } catch (_emitErr) {
          // best-effort
        }
        throw new DialogInterruptedError({
          kind: 'system_stop',
          detail: canRetry
            ? `LLM failed after retries: ${failure.message}`
            : `LLM failed: ${failure.message}`,
        });
      }

      // Exponential backoff with cap. (No jitter for determinism.)
      const backoffMs = Math.min(5000, 500 * 2 ** attempt);
      log.warn(`Retrying LLM request after retriable error`, {
        provider: params.provider,
        attempt: attempt + 1,
        backoffMs,
        failure,
      });
      await sleepWithAbort(backoffMs, params.abortSignal);
      continue;
    }
  }

  throw new DialogInterruptedError({ kind: 'system_stop', detail: 'LLM failed.' });
}

function resolveModelContextLimitTokens(modelInfo: ModelInfo | undefined): number | null {
  if (
    modelInfo &&
    typeof modelInfo.context_length === 'number' &&
    Number.isFinite(modelInfo.context_length)
  ) {
    const n = Math.floor(modelInfo.context_length);
    return n > 0 ? n : null;
  }
  if (
    modelInfo &&
    typeof modelInfo.input_length === 'number' &&
    Number.isFinite(modelInfo.input_length)
  ) {
    const n = Math.floor(modelInfo.input_length);
    return n > 0 ? n : null;
  }
  return null;
}

function resolveEffectiveOptimalMaxTokens(args: {
  modelInfo: ModelInfo | undefined;
  modelContextLimitTokens: number;
}): { effectiveOptimalMaxTokens: number; optimalMaxTokensConfigured?: number } {
  const configured =
    args.modelInfo &&
    typeof args.modelInfo.optimal_max_tokens === 'number' &&
    Number.isFinite(args.modelInfo.optimal_max_tokens)
      ? Math.floor(args.modelInfo.optimal_max_tokens)
      : undefined;
  const configuredClamped = configured !== undefined && configured > 0 ? configured : undefined;
  const defaultOptimal = Math.max(1, Math.floor(args.modelContextLimitTokens * 0.5));
  const effectiveOptimalMaxTokens =
    configuredClamped !== undefined ? configuredClamped : defaultOptimal;
  return {
    effectiveOptimalMaxTokens,
    optimalMaxTokensConfigured: configuredClamped,
  };
}

function computeContextHealthSnapshot(args: {
  providerCfg: ProviderConfig;
  model: string;
  usage: LlmUsageStats;
}): ContextHealthSnapshot {
  const modelInfo: ModelInfo | undefined = args.providerCfg.models[args.model];
  const modelContextLimitTokens = resolveModelContextLimitTokens(modelInfo);
  if (modelContextLimitTokens === null) {
    return { kind: 'unavailable', reason: 'model_limit_unavailable' };
  }

  const { effectiveOptimalMaxTokens, optimalMaxTokensConfigured } =
    resolveEffectiveOptimalMaxTokens({
      modelInfo,
      modelContextLimitTokens,
    });

  if (args.usage.kind !== 'available') {
    return {
      kind: 'unavailable',
      reason: 'usage_unavailable',
      modelContextLimitTokens,
      effectiveOptimalMaxTokens,
      optimalMaxTokensConfigured,
    };
  }

  const hardUtil = args.usage.promptTokens / modelContextLimitTokens;
  const optimalUtil = args.usage.promptTokens / effectiveOptimalMaxTokens;
  const level = hardUtil <= 0.5 ? 'healthy' : hardUtil <= 0.75 ? 'caution' : 'critical';

  return {
    kind: 'available',
    promptTokens: args.usage.promptTokens,
    completionTokens: args.usage.completionTokens,
    totalTokens: args.usage.totalTokens,
    modelContextLimitTokens,
    effectiveOptimalMaxTokens,
    optimalMaxTokensConfigured,
    hardUtil,
    optimalUtil,
    level,
  };
}

async function applyContextHealthMonitor(
  dlg: Dialog,
  snapshot: ContextHealthSnapshot,
): Promise<void> {
  let hasContextHealthReminder = false;
  for (const reminder of dlg.reminders) {
    if (reminder.owner && reminder.owner.name === contextHealthReminderOwner.name) {
      hasContextHealthReminder = true;
      break;
    }
  }

  if (snapshot.kind !== 'available') {
    if (hasContextHealthReminder) {
      await dlg.processReminderUpdates();
    }
    return;
  }

  const shouldRemind =
    snapshot.hardUtil > 0.5 || snapshot.promptTokens > snapshot.effectiveOptimalMaxTokens;

  if (shouldRemind && !hasContextHealthReminder) {
    dlg.addReminder('Context health reminder', contextHealthReminderOwner);
    hasContextHealthReminder = true;
  }

  if (hasContextHealthReminder) {
    await dlg.processReminderUpdates();
  }
}

// === UNIFIED STREAMING HANDLERS ===

/**
 * Create a TextingEventsReceiver for unified saying event emission.
 * Handles @mentions, codeblocks, and markdown using TextingStreamParser.
 * Used by both streaming and non-streaming modes.
 */
export function createSayingEventsReceiver(dlg: Dialog): TextingEventsReceiver {
  return {
    markdownStart: async () => {
      await dlg.markdownStart();
    },
    markdownChunk: async (chunk: string) => {
      await dlg.markdownChunk(chunk);
    },
    markdownFinish: async () => {
      await dlg.markdownFinish();
    },
    callStart: async (first: string) => {
      await dlg.callingStart(first);
    },
    callHeadLineChunk: async (chunk: string) => {
      await dlg.callingHeadlineChunk(chunk);
    },
    callHeadLineFinish: async () => {
      await dlg.callingHeadlineFinish();
    },
    callBodyStart: async (infoLine?: string) => {
      await dlg.callingBodyStart(infoLine);
    },
    callBodyChunk: async (chunk: string) => {
      await dlg.callingBodyChunk(chunk);
    },
    callBodyFinish: async (endQuote?: string) => {
      await dlg.callingBodyFinish(endQuote);
    },
    callFinish: async (callId: string) => {
      await dlg.callingFinish(callId);
    },
    codeBlockStart: async (infoLine: string) => {
      await dlg.codeBlockStart(infoLine);
    },
    codeBlockChunk: async (chunk: string) => {
      await dlg.codeBlockChunk(chunk);
    },
    codeBlockFinish: async (endQuote: string) => {
      await dlg.codeBlockFinish(endQuote);
    },
  };
}

/**
 * Emit thinking events for a thinking message (non-streaming mode).
 * Emits thinkingStart, thinkingChunk with full content, and thinkingFinish.
 * Returns the extracted signature for caller to use.
 */
export async function emitThinkingEvents(
  dlg: Dialog,
  content: string,
): Promise<string | undefined> {
  if (!content.trim()) return undefined;

  await dlg.thinkingStart();
  await dlg.thinkingChunk(content);
  await dlg.thinkingFinish();

  // Extract and return signature for caller to use
  const signatureMatch = content.match(/<thinking[^>]*>(.*?)<\/thinking>/s);
  return signatureMatch?.[1]?.trim();
}

/**
 * Emit saying events using TextingStreamParser for @mentions/codeblocks (non-streaming mode).
 * Processes the entire content at once, handling all markdown/call/code events.
 */
export async function emitSayingEvents(
  dlg: Dialog,
  content: string,
): Promise<CollectedTextingCall[]> {
  if (!content.trim()) return [];

  const receiver = createSayingEventsReceiver(dlg);
  const parser = new TextingStreamParser(receiver);
  await parser.takeUpstreamChunk(content);
  await parser.finalize();

  return parser.getCollectedCalls();
}

async function emitUserMarkdown(dlg: Dialog, content: string): Promise<void> {
  if (!content.trim()) {
    return;
  }
  await dlg.markdownStart();
  await dlg.markdownChunk(content);
  await dlg.markdownFinish();
}

function resolveUpNextPrompt(dlg: Dialog, humanPrompt?: HumanPrompt): HumanPrompt | undefined {
  if (humanPrompt) {
    return humanPrompt;
  }
  const upNext = dlg.takeUpNext();
  if (!upNext) {
    return undefined;
  }
  return {
    content: upNext.prompt,
    msgId: upNext.msgId,
    grammar: 'markdown',
    userLanguageCode: upNext.userLanguageCode,
  };
}

function scheduleUpNextDrive(dlg: Dialog, upNext: UpNextPrompt): void {
  const prompt: HumanPrompt = {
    content: upNext.prompt,
    msgId: upNext.msgId,
    grammar: 'markdown',
    userLanguageCode: upNext.userLanguageCode,
  };
  void driveDialogStream(dlg, prompt, true);
}

const suspensionStateMutexes: Map<string, AsyncFifoMutex> = new Map();

async function withSuspensionStateLock<T>(dialogId: DialogID, fn: () => Promise<T>): Promise<T> {
  const key = dialogId.key();
  let mutex = suspensionStateMutexes.get(key);
  if (!mutex) {
    mutex = new AsyncFifoMutex();
    suspensionStateMutexes.set(key, mutex);
  }
  const release = await mutex.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

// TODO: certain scenarios should pass `waitInQue=true`:
//        - supdialog call for clarification
/**
 * Drive a dialog stream with the following phases:
 *
 * Phase 1 - Lock Acquisition:
 *   - Attempt to acquire exclusive lock for the dialog using mutex
 *   - If dialog is already being driven, either wait in queue or throw error
 *
 * Phase 2 - Human Prompt Processing (first iteration only):
 *   - If humanPrompt is provided, add it as a prompting_msg
 *   - Persist user message to storage
 *
 * Phase 3 - User Texting Calls Collection & Execution:
 *   - Parse user text for @mentions and code blocks using TextingStreamParser
 *   - Execute texting tools (agent-to-agent calls, intrinsic tools)
 *   - Handle subdialog creation for @teammate mentions
 *
 * Phase 4 - Context Building:
 *   - Load agent minds (team, agent, system prompt, memories, tools)
 *   - Build context messages: memories, task doc, assignment from supdialog, dialog msgs
 *   - Process and render reminders
 *
 * Phase 5 - LLM Generation:
 *   - For streaming=false: Generate all messages at once
 *   - For streaming=true: Stream responses with thinking/saying events
 *
 * Phase 6 - Function/Texting Call Execution:
 *   - Execute function calls (non-streaming mode)
 *   - Execute texting calls (streaming mode)
 *   - Collect and persist results
 *
 * Phase 7 - Loop or Complete:
 *   - Check if more generation iterations are needed
 *   - Continue loop if new function calls or tool outputs exist
 *   - Break and release lock when complete
 */
export async function driveDialogStream(
  dlg: Dialog,
  humanPrompt?: HumanPrompt,
  waitInQue: boolean = false,
): Promise<void> {
  if (!waitInQue && dlg.isLocked()) {
    throw new Error(`Dialog busy driven, see how it proceeded and try again.`);
  }
  const release = await dlg.acquire();
  let followUp: UpNextPrompt | undefined;
  let generatedAssistantResponse: string | null = null;
  try {
    const effectivePrompt = resolveUpNextPrompt(dlg, humanPrompt);
    if (effectivePrompt && effectivePrompt.userLanguageCode) {
      dlg.setLastUserLanguageCode(effectivePrompt.userLanguageCode);
    }
    generatedAssistantResponse = await _driveDialogStream(dlg, effectivePrompt);
    followUp = dlg.takeUpNext();
  } finally {
    release();
  }
  if (followUp) {
    scheduleUpNextDrive(dlg, followUp);
  } else if (dlg instanceof SubDialog && generatedAssistantResponse !== null) {
    await supplySubdialogResponseToCallerIfPending(dlg, generatedAssistantResponse);
  }
}

/**
 * Backend coroutine that continuously drives dialogs.
 * Uses dynamic canDrive() checks instead of stored suspend state.
 */
export async function runBackendDriver(): Promise<void> {
  while (true) {
    try {
      const dialogsToDrive = globalDialogRegistry.getDialogsNeedingDrive();

      for (const rootDialog of dialogsToDrive) {
        try {
          if (!(await rootDialog.canDrive())) {
            globalDialogRegistry.markNotNeedingDrive(rootDialog.id.rootId);
            await DialogPersistence.setNeedsDrive(rootDialog.id, false, rootDialog.status);
            continue;
          }

          const release = await rootDialog.acquire();
          try {
            await driveDialogToSuspension(rootDialog);
          } finally {
            release();
          }

          if (rootDialog.hasUpNext()) {
            globalDialogRegistry.markNeedsDrive(rootDialog.id.rootId);
            await DialogPersistence.setNeedsDrive(rootDialog.id, true, rootDialog.status);
          } else {
            globalDialogRegistry.markNotNeedingDrive(rootDialog.id.rootId);
            await DialogPersistence.setNeedsDrive(rootDialog.id, false, rootDialog.status);
          }

          const status = await rootDialog.getSuspensionStatus();
          if (status.subdialogs) {
            log.info(`Dialog ${rootDialog.id.rootId} suspended, waiting for subdialogs`);
          }
          if (status.q4h) {
            log.info(`Dialog ${rootDialog.id.rootId} awaiting Q4H answer`);
          }
        } catch (err) {
          log.error(`Error driving dialog ${rootDialog.id.rootId}:`, err, undefined, {
            dialogId: rootDialog.id.rootId,
          });
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (loopErr) {
      log.error('Error in backend driver loop:', loopErr);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/**
 * Drive a dialog until it suspends or completes.
 * Called with mutex already acquired.
 */
async function driveDialogToSuspension(dlg: Dialog): Promise<void> {
  try {
    const effectivePrompt = resolveUpNextPrompt(dlg);
    if (effectivePrompt && effectivePrompt.userLanguageCode) {
      dlg.setLastUserLanguageCode(effectivePrompt.userLanguageCode);
    }
    await _driveDialogStream(dlg, effectivePrompt);
  } catch (err) {
    log.warn(`Error in driveDialogToSuspension for ${dlg.id.selfId}:`, err);
    throw err;
  }
}

/**
 * Frontend-triggered revive check (crash-recovery).
 */
export async function checkAndReviveSuspendedDialogs(): Promise<void> {
  const allDialogs = globalDialogRegistry.getAll();

  for (const rootDialog of allDialogs) {
    const pending = await DialogPersistence.loadPendingSubdialogs(rootDialog.id);
    if (pending.length > 0) {
      const allSatisfied = await areAllSubdialogsSatisfied(rootDialog.id);

      if (allSatisfied) {
        await withSuspensionStateLock(rootDialog.id, async () => {
          await DialogPersistence.savePendingSubdialogs(rootDialog.id, []);
          await DialogPersistence.setNeedsDrive(rootDialog.id, true, rootDialog.status);
        });
        globalDialogRegistry.markNeedsDrive(rootDialog.id.rootId);
        log.info(`All subdialogs complete for ${rootDialog.id.rootId}, auto-reviving`);
      }
    }

    const subdialogs = rootDialog.getAllDialogs().filter((d) => d !== rootDialog);
    for (const subdialog of subdialogs) {
      const hasAnswer = await checkQ4HAnswered(subdialog.id);
      if (hasAnswer && !(await subdialog.hasPendingQ4H())) {
        void driveDialogStream(subdialog, undefined, true);
        log.info(`Q4H answered for dialog ${subdialog.id.selfId}, auto-reviving`);
      }
    }
  }
}

async function checkQ4HAnswered(dialogId: DialogID): Promise<boolean> {
  try {
    const questions = await DialogPersistence.loadQuestions4HumanState(dialogId);
    return questions.length === 0;
  } catch (err) {
    log.warn(`Error checking Q4H state ${dialogId.key()}:`, err);
    return false;
  }
}

async function _driveDialogStream(dlg: Dialog, humanPrompt?: HumanPrompt): Promise<string | null> {
  const abortSignal = createActiveRun(dlg.id);
  let finalRunState: DialogRunState | undefined;
  let shouldEmitResumedMarker = false;
  if (!humanPrompt) {
    try {
      const latest = await DialogPersistence.loadDialogLatest(dlg.id, 'running');
      shouldEmitResumedMarker =
        latest?.runState !== undefined && latest.runState.kind === 'interrupted';
    } catch (err) {
      log.warn('Failed to load latest.yaml for resumption marker', err, {
        dialogId: dlg.id.valueOf(),
      });
    }
  }

  if (shouldEmitResumedMarker) {
    broadcastRunStateMarker(dlg.id, { kind: 'resumed' });
  }

  await setDialogRunState(dlg.id, { kind: 'proceeding' });

  let pubRemindersVer = dlg.remindersVer;
  let lastAssistantSayingContent: string | null = null;
  let generationHadError = false;

  type TakenSubdialogResponse = Awaited<
    ReturnType<typeof DialogPersistence.takeSubdialogResponses>
  >[number];
  let tookSubdialogResponses = false;
  let takenSubdialogResponses: TakenSubdialogResponse[] = [];

  let genIterNo = 0;
  try {
    while (true) {
      genIterNo++;
      throwIfAborted(abortSignal, dlg.id);

      // reload the agent's minds from disk every round, in case the disk files changed by human or ai meanwhile
      const { team, agent, systemPrompt, memories, agentTools, textingTools } =
        await loadAgentMinds(dlg.agentId, dlg);

      // reload cfgs every round, in case it's been updated by human or ai meanwhile

      // Validate streaming configuration
      try {
        validateStreamingConfiguration(agent, agentTools);
      } catch (error) {
        log.warn(`Streaming configuration error for agent ${dlg.agentId}:`, error);
        throw error;
      }

      // Validate that required provider and model are configured

      // Validate that required provider and model are configured
      const provider = agent.provider ?? team.memberDefaults.provider;
      const model = agent.model ?? team.memberDefaults.model;

      if (!provider) {
        const error = new Error(
          `Configuration Error: No provider configured for agent '${dlg.agentId}'. Please specify a provider in the agent's configuration or in member_defaults section of .minds/team.yaml.`,
        );
        log.warn(`Provider not configured for agent ${dlg.agentId}`, error);
        throw error;
      }

      if (!model) {
        const error = new Error(
          `Configuration Error: No model configured for agent '${dlg.agentId}'. Please specify a model in the agent's configuration or in member_defaults section of .minds/team.yaml.`,
        );
        log.warn(`Model not configured for agent ${dlg.agentId}`, error);
        throw error;
      }

      const llmCfg = await LlmConfig.load();
      const providerCfg = llmCfg.getProvider(provider);
      if (!providerCfg) {
        const error = new Error(
          `Provider configuration error: Provider '${provider}' not found for agent '${dlg.agentId}'. Please check .minds/llm.yaml and .minds/team.yaml configuration.`,
        );
        log.warn(`Provider not found for agent ${dlg.agentId}`, error);
        throw error;
      }

      const llmGen = getLlmGenerator(providerCfg.apiType);
      if (!llmGen) {
        const error = new Error(
          `LLM generator not found: API type '${providerCfg.apiType}' for provider '${provider}' in agent '${dlg.agentId}'. Please check .minds/llm.yaml configuration.`,
        );
        log.warn(`LLM generator not found for agent ${dlg.agentId}`, error);
        throw error;
      }

      const canonicalFuncTools: FuncTool[] = agentTools.filter(
        (t): t is FuncTool => t.type === 'func',
      );
      const projected = projectFuncToolsForProvider(providerCfg.apiType, canonicalFuncTools);
      const funcTools = projected.tools;

      let suspendForHuman = false;
      let promptContent = '';
      let contextHealthForGen: ContextHealthSnapshot | undefined;

      try {
        throwIfAborted(abortSignal, dlg.id);
        await dlg.notifyGeneratingStart();

        if (humanPrompt && genIterNo === 1) {
          promptContent = humanPrompt.content;
          const msgId = humanPrompt.msgId;
          const promptGrammar = humanPrompt.grammar;
          const persistedUserLanguageCode =
            humanPrompt.userLanguageCode ?? dlg.getLastUserLanguageCode();

          await dlg.addChatMessages({
            type: 'prompting_msg',
            role: 'user',
            genseq: dlg.activeGenSeq,
            content: promptContent,
            msgId: msgId,
            grammar: promptGrammar,
          });
          // Persist user message to storage FIRST
          await dlg.persistUserMessage(
            promptContent,
            msgId,
            promptGrammar,
            persistedUserLanguageCode,
          );

          if (promptGrammar === 'texting') {
            // Collect and execute texting calls from user text using streaming parser
            // Combine agent texting tools with intrinsic reminder tools
            const allTextingTools = [...textingTools, ...dlg.getIntrinsicTools()];
            throwIfAborted(abortSignal, dlg.id);
            const collectedUserCalls = await emitSayingEvents(dlg, promptContent);
            throwIfAborted(abortSignal, dlg.id);
            const userResult = await executeTextingCalls(
              dlg,
              agent,
              allTextingTools,
              collectedUserCalls,
            );

            if (dlg.hasUpNext()) {
              return lastAssistantSayingContent;
            }

            if (userResult.toolOutputs.length > 0) {
              await dlg.addChatMessages(...userResult.toolOutputs);
            }
            if (userResult.suspend) {
              suspendForHuman = true;
            }

            // No teammate-call fallback here: rely exclusively on TextingStreamParser.

            // Pending subdialogs are tracked in persistence (pending-subdialogs.json) as the source of truth.
          } else {
            await emitUserMarkdown(dlg, promptContent);
          }

          try {
            postDialogEvent(dlg, {
              type: 'end_of_user_saying_evt',
              round: dlg.currentRound,
              genseq: dlg.activeGenSeq,
              msgId,
              content: promptContent,
              grammar: promptGrammar,
              userLanguageCode: persistedUserLanguageCode,
            });
          } catch (err) {
            log.warn('Failed to emit end_of_user_saying_evt', err);
          }
        }

        if (suspendForHuman) {
          break;
        }

        // Take any queued subdialog responses (once per drive) and inject them as fresh user context.
        // This is the core "revival" mechanism: the parent is driven again when all pending subdialogs
        // are resolved, and the queued responses become the next user-visible input to the model.
        if (genIterNo === 1 && !tookSubdialogResponses) {
          tookSubdialogResponses = true;
          try {
            takenSubdialogResponses = await withSuspensionStateLock(dlg.id, async () => {
              return await DialogPersistence.takeSubdialogResponses(dlg.id);
            });
          } catch (err) {
            log.warn('Failed to take subdialog responses for injection', {
              dialogId: dlg.id.selfId,
              error: err,
            });
            generationHadError = true;
            takenSubdialogResponses = [];
          }
        }

        // use fresh memory + updated msgs from dialog object
        // Build ctxMsgs messages in logical order, then inject reminders as late as possible:
        // 1) memories
        // 2) task doc (user)
        // 3) historical dialog msgs
        // Finally, render reminders and place them immediately before the last 'user' message
        // so they are salient for the next response without polluting earlier context.
        const taskDocMsg: ChatMessage | undefined = dlg.taskDocPath
          ? await formatTaskDocContent(dlg.taskDocPath)
          : undefined;

        const ctxMsgs: ChatMessage[] = [
          ...memories,
          ...(taskDocMsg ? [taskDocMsg] : []),
          ...dlg.msgs,
        ];

        if (genIterNo === 1 && takenSubdialogResponses.length > 0) {
          for (const response of takenSubdialogResponses) {
            ctxMsgs.push({
              type: 'environment_msg',
              role: 'user',
              content: formatTeammateResponseContent({
                responderId: response.responderId,
                requesterId: response.originMemberId,
                originalCallHeadLine: response.headLine,
                responseBody: response.response,
                language: getWorkLanguage(),
              }),
            });
          }
        }

        await dlg.processReminderUpdates();
        const renderedReminders: ChatMessage[] =
          dlg.reminders.length > 0
            ? await Promise.all(
                dlg.reminders.map(async (reminder, index): Promise<ChatMessage> => {
                  if (reminder.owner) {
                    return await reminder.owner.renderReminder(dlg, reminder, index);
                  }
                  return {
                    type: 'transient_guide_msg',
                    role: 'assistant',
                    content: formatReminderItemGuide(
                      getWorkLanguage(),
                      index + 1,
                      reminder.content,
                    ),
                  };
                }),
              )
            : [];

        const reminderIntro: ChatMessage = {
          type: 'transient_guide_msg',
          role: 'assistant',
          content: formatReminderIntro(getWorkLanguage(), dlg.reminders.length),
        };

        if (renderedReminders.length > 0 || dlg.reminders.length === 0) {
          let insertIndex = -1;
          for (let i = ctxMsgs.length - 1; i >= 0; i--) {
            const m = ctxMsgs[i];
            if (
              m &&
              (m.type === 'prompting_msg' || m.type === 'environment_msg') &&
              m.role === 'user'
            ) {
              insertIndex = i;
              break;
            }
          }
          if (insertIndex >= 0) {
            ctxMsgs.splice(insertIndex, 0, reminderIntro, ...renderedReminders);
          } else {
            ctxMsgs.push(reminderIntro, ...renderedReminders);
          }
        }

        {
          const uiLanguage = dlg.getLastUserLanguageCode();
          const workingLanguage = getWorkLanguage();
          const guideMsg: ChatMessage = {
            type: 'transient_guide_msg',
            role: 'assistant',
            content: formatUserFacingLanguageGuide(workingLanguage, uiLanguage),
          };
          let insertIndex = -1;
          for (let i = ctxMsgs.length - 1; i >= 0; i--) {
            const m = ctxMsgs[i];
            if (
              m &&
              (m.type === 'prompting_msg' || m.type === 'environment_msg') &&
              m.role === 'user'
            ) {
              insertIndex = i;
              break;
            }
          }
          if (insertIndex >= 0) {
            ctxMsgs.splice(insertIndex, 0, guideMsg);
          } else {
            ctxMsgs.push(guideMsg);
          }
        }

        if (agent.streaming === false) {
          let nonStreamResult: { messages: ChatMessage[]; usage: LlmUsageStats };
          try {
            throwIfAborted(abortSignal, dlg.id);
            nonStreamResult = await runLlmRequestWithRetry({
              dlg,
              provider,
              abortSignal,
              maxRetries: 3,
              canRetry: () => true,
              doRequest: async () => {
                return await llmGen.genMoreMessages(
                  providerCfg,
                  agent,
                  systemPrompt,
                  funcTools,
                  ctxMsgs,
                  dlg.activeGenSeq,
                  abortSignal,
                );
              },
            });
          } catch (err) {
            if (abortSignal.aborted) {
              throwIfAborted(abortSignal, dlg.id);
            }
            generationHadError = true;
            throw err;
          }

          if (!agent.model) {
            throw new Error(`Internal error: Model is undefined for agent '${agent.id}'`);
          }
          contextHealthForGen = computeContextHealthSnapshot({
            providerCfg,
            model: agent.model,
            usage: nonStreamResult.usage,
          });
          dlg.setLastContextHealth(contextHealthForGen);
          await applyContextHealthMonitor(dlg, contextHealthForGen);

          const nonStreamMsgs = nonStreamResult.messages;
          const assistantMsgs = nonStreamMsgs.filter(
            (m): m is SayingMsg | ThinkingMsg =>
              m.type === 'saying_msg' || m.type === 'thinking_msg',
          );
          const collectedAssistantCalls: CollectedTextingCall[] = [];

          if (assistantMsgs.length > 0) {
            await dlg.addChatMessages(...assistantMsgs);

            for (const msg of assistantMsgs) {
              if (
                msg.role === 'assistant' &&
                msg.genseq !== undefined &&
                (msg.type === 'thinking_msg' || msg.type === 'saying_msg')
              ) {
                // Only persist saying_msg - thinking_msg is persisted via thinkingFinish
                if (msg.type === 'saying_msg') {
                  lastAssistantSayingContent = msg.content;
                  await dlg.persistAgentMessage(msg.content, msg.genseq, 'saying_msg');
                }

                // Emit thinking events using shared handler (non-streaming mode)
                if (msg.type === 'thinking_msg') {
                  await emitThinkingEvents(dlg, msg.content);
                }

                // Emit saying events using shared TextingStreamParser integration
                if (msg.type === 'saying_msg') {
                  const calls = await emitSayingEvents(dlg, msg.content);
                  collectedAssistantCalls.push(...calls);
                }
              }
            }
          }

          let assistantToolOutputsCount = 0;
          if (collectedAssistantCalls.length > 0) {
            const allTextingTools = [...textingTools, ...dlg.getIntrinsicTools()];
            throwIfAborted(abortSignal, dlg.id);
            const assistantResult = await executeTextingCalls(
              dlg,
              agent,
              allTextingTools,
              collectedAssistantCalls,
            );
            if (dlg.hasUpNext()) {
              return lastAssistantSayingContent;
            }
            assistantToolOutputsCount = assistantResult.toolOutputs.length;
            if (assistantResult.toolOutputs.length > 0) {
              await dlg.addChatMessages(...assistantResult.toolOutputs);
            }
            if (assistantResult.suspend) {
              suspendForHuman = true;
            }
          }

          const funcCalls = nonStreamMsgs.filter(
            (m): m is FuncCallMsg => m.type === 'func_call_msg',
          );
          const funcResults: FuncResultMsg[] = [];

          const functionPromises = funcCalls.map(async (func) => {
            throwIfAborted(abortSignal, dlg.id);
            // Use the genseq from the func_call_msg to ensure tool results share the same generation sequence
            // This is critical for correct grouping in reconstructAnthropicContext()
            const callGenseq = func.genseq;
            // Use the LLM-allocated unique id for tracking
            // This id comes from func_call_msg and is the proper unique identifier
            const callId = func.id;

            // argsStr is still needed for UI event (funcCallRequested)
            const argsStr =
              typeof func.arguments === 'string'
                ? func.arguments
                : JSON.stringify(func.arguments ?? {});

            const tool = agentTools.find(
              (t): t is FuncTool => t.type === 'func' && t.name === func.name,
            );
            if (!tool) {
              const errorResult: FuncResultMsg = {
                type: 'func_result_msg',
                id: func.id,
                name: func.name,
                content: `Tool '${func.name}' not found`,
                role: 'tool',
                genseq: callGenseq,
              };
              await dlg.receiveFuncResult(errorResult);
              return;
            }

            let rawArgs: unknown = {};
            if (typeof func.arguments === 'string' && func.arguments.trim()) {
              try {
                rawArgs = JSON.parse(func.arguments);
              } catch (parseErr) {
                rawArgs = null;
                log.warn('Failed to parse function arguments as JSON', {
                  funcName: func.name,
                  arguments: func.arguments,
                  error: parseErr,
                });
              }
            }

            let result: FuncResultMsg;
            const argsValidation = validateFuncToolArguments(tool, rawArgs);
            if (argsValidation.ok) {
              const argsObj = argsValidation.args;

              // Emit func_call_requested event to build the func-call section UI
              try {
                await dlg.funcCallRequested(func.id, func.name, argsStr);
              } catch (err) {
                log.warn('Failed to emit func_call_requested event', err);
              }

              try {
                await dlg.persistFunctionCall(func.id, func.name, argsObj, callGenseq);
              } catch (err) {
                log.warn('Failed to persist function call', err);
              }

              try {
                throwIfAborted(abortSignal, dlg.id);
                const content = await tool.call(dlg, agent, argsObj);
                result = {
                  type: 'func_result_msg',
                  id: func.id,
                  name: func.name,
                  content: String(content),
                  role: 'tool',
                  genseq: callGenseq,
                };
              } catch (err) {
                result = {
                  type: 'func_result_msg',
                  id: func.id,
                  name: func.name,
                  content: `Function '${func.name}' execution failed: ${showErrorToAi(err)}`,
                  role: 'tool',
                  genseq: callGenseq,
                };
              }
            } else {
              result = {
                type: 'func_result_msg',
                id: func.id,
                name: func.name,
                content: `Invalid arguments: ${argsValidation.error}`,
                role: 'tool',
                genseq: callGenseq,
              };
            }

            await dlg.receiveFuncResult(result);
            funcResults.push(result);
          });

          const allFuncResults = await Promise.all(functionPromises);

          await Promise.resolve();

          // Add function calls AND results to dialog messages so LLM sees tool context in next iteration
          // Both are needed: func_call_msg for the tool definition, func_result_msg for the output
          if (funcCalls.length > 0) {
            await dlg.addChatMessages(...funcCalls);
          }
          if (funcResults.length > 0) {
            await dlg.addChatMessages(...funcResults);
          }

          if (suspendForHuman) {
            break;
          }

          // Check if we should continue to another generation iteration.
          // We continue if:
          // 1. There are function calls
          // 2. There are assistant tool outputs from texting calls
          const shouldContinue =
            funcCalls.length > 0 ||
            assistantToolOutputsCount > 0 ||
            (funcResults.length > 0 && funcCalls.length === 0);
          if (!shouldContinue) {
            break;
          }

          continue;
        } else {
          const newMsgs: ChatMessage[] = [];
          const streamedFuncCalls: FuncCallMsg[] = [];

          // Track thinking content for signature extraction during streaming
          let currentThinkingContent = '';
          let currentThinkingSignature = '';
          let currentSayingContent = '';
          let sawAnyStreamContent = false;

          // Create receiver using shared helper (unified TextingStreamParser integration)
          const receiver = createSayingEventsReceiver(dlg);

          // Direct streaming parser that forwards events without state tracking
          const parser = new TextingStreamParser(receiver);

          let streamResult: { usage: LlmUsageStats } | undefined;
          try {
            streamResult = await runLlmRequestWithRetry({
              dlg,
              provider,
              abortSignal,
              maxRetries: 2,
              canRetry: () => !sawAnyStreamContent,
              doRequest: async () => {
                return await llmGen.genToReceiver(
                  providerCfg,
                  agent,
                  systemPrompt,
                  funcTools,
                  ctxMsgs,
                  {
                    thinkingStart: async () => {
                      throwIfAborted(abortSignal, dlg.id);
                      sawAnyStreamContent = true;
                      currentThinkingContent = '';
                      currentThinkingSignature = '';
                      await dlg.thinkingStart();
                    },
                    thinkingChunk: async (chunk: string) => {
                      throwIfAborted(abortSignal, dlg.id);
                      sawAnyStreamContent = true;
                      currentThinkingContent += chunk;
                      // Extract Anthropic thinking signature from content
                      const signatureMatch = currentThinkingContent.match(
                        /<thinking[^>]*>(.*?)<\/thinking>/s,
                      );
                      if (signatureMatch && signatureMatch[1]) {
                        currentThinkingSignature = signatureMatch[1].trim();
                      }
                      await dlg.thinkingChunk(chunk);
                    },
                    thinkingFinish: async () => {
                      throwIfAborted(abortSignal, dlg.id);
                      // Create thinking message with genseq and signature
                      const genseq = dlg.activeGenSeq;
                      if (genseq) {
                        const thinkingMessage: ThinkingMsg = {
                          type: 'thinking_msg',
                          role: 'assistant',
                          genseq,
                          content: currentThinkingContent,
                          provider_data: currentThinkingSignature
                            ? { signature: currentThinkingSignature }
                            : undefined,
                        };
                        newMsgs.push(thinkingMessage);
                      }
                      await dlg.thinkingFinish();
                    },
                    sayingStart: async () => {
                      throwIfAborted(abortSignal, dlg.id);
                      sawAnyStreamContent = true;
                      currentSayingContent = '';
                      await dlg.sayingStart();
                    },
                    sayingChunk: async (chunk: string) => {
                      throwIfAborted(abortSignal, dlg.id);
                      sawAnyStreamContent = true;
                      currentSayingContent += chunk;
                      await parser.takeUpstreamChunk(chunk);
                      // Dialog store handles persistence - maintain ordering guarantee
                      await dlg.sayingChunk(chunk);
                    },
                    sayingFinish: async () => {
                      throwIfAborted(abortSignal, dlg.id);
                      await parser.finalize();

                      const sayingMessage: SayingMsg = {
                        type: 'saying_msg',
                        role: 'assistant',
                        genseq: dlg.activeGenSeq,
                        content: currentSayingContent,
                      };
                      newMsgs.push(sayingMessage);
                      lastAssistantSayingContent = currentSayingContent;

                      await dlg.sayingFinish();
                    },
                    funcCall: async (callId: string, name: string, args: string) => {
                      throwIfAborted(abortSignal, dlg.id);
                      sawAnyStreamContent = true;
                      const genseq = dlg.activeGenSeq;
                      if (genseq === undefined) {
                        return;
                      }
                      streamedFuncCalls.push({
                        type: 'func_call_msg',
                        role: 'assistant',
                        genseq,
                        id: callId,
                        name,
                        arguments: args,
                      });
                    },
                  },
                  dlg.activeGenSeq,
                  abortSignal,
                );
              },
            });
          } catch (err) {
            if (abortSignal.aborted) {
              throwIfAborted(abortSignal, dlg.id);
            }
            generationHadError = true;
            log.error(`LLM gen error:`, err);
            throw err;
          }

          if (!streamResult) {
            throw new Error('Internal error: missing stream result after successful generation');
          }
          if (!agent.model) {
            throw new Error(`Internal error: Model is undefined for agent '${agent.id}'`);
          }
          contextHealthForGen = computeContextHealthSnapshot({
            providerCfg,
            model: agent.model,
            usage: streamResult.usage,
          });
          dlg.setLastContextHealth(contextHealthForGen);
          await applyContextHealthMonitor(dlg, contextHealthForGen);

          // Execute collected calls concurrently after streaming completes
          const collectedCalls = parser.getCollectedCalls();

          if (collectedCalls.length > 0 && !collectedCalls[0].callId) {
            throw new Error(
              'Collected calls missing callId - parser should have allocated one per call',
            );
          }

          throwIfAborted(abortSignal, dlg.id);
          const results = await Promise.all(
            collectedCalls.map((call) =>
              executeTextingCall(
                dlg,
                agent,
                textingTools,
                call.firstMention,
                call.headLine,
                call.body,
                call.callId,
              ),
            ),
          );

          if (dlg.hasUpNext()) {
            return lastAssistantSayingContent;
          }

          // Combine results from all concurrent calls and track tool outputs for termination logic
          let toolOutputsCount = 0;
          for (const result of results) {
            if (result.toolOutputs.length > 0) {
              toolOutputsCount += result.toolOutputs.length;
              newMsgs.push(...result.toolOutputs);
            }
            if (result.suspend) {
              suspendForHuman = true;
            }
          }

          const funcResults: FuncResultMsg[] = [];
          if (streamedFuncCalls.length > 0) {
            const functionPromises = streamedFuncCalls.map(async (func) => {
              throwIfAborted(abortSignal, dlg.id);
              // Use the genseq from the func_call_msg to ensure tool results share the same generation sequence
              // This is critical for correct grouping in reconstructAnthropicContext()
              const callGenseq = func.genseq;
              // Use the LLM-allocated unique id for tracking
              // This id comes from func_call_msg and is the proper unique identifier
              const callId = func.id;

              // argsStr is still needed for UI event (funcCallRequested)
              const argsStr =
                typeof func.arguments === 'string'
                  ? func.arguments
                  : JSON.stringify(func.arguments ?? {});

              const tool = agentTools.find(
                (t): t is FuncTool => t.type === 'func' && t.name === func.name,
              );
              if (!tool) {
                const errorResult: FuncResultMsg = {
                  type: 'func_result_msg',
                  id: func.id,
                  name: func.name,
                  content: `Tool '${func.name}' not found`,
                  role: 'tool',
                  genseq: callGenseq,
                };
                await dlg.receiveFuncResult(errorResult);
                return;
              }

              let rawArgs: unknown = {};
              if (typeof func.arguments === 'string' && func.arguments.trim()) {
                try {
                  rawArgs = JSON.parse(func.arguments);
                } catch (parseErr) {
                  rawArgs = null;
                  log.warn('Failed to parse function arguments as JSON', {
                    funcName: func.name,
                    arguments: func.arguments,
                    error: parseErr,
                  });
                }
              }

              let result: FuncResultMsg;
              const argsValidation = validateFuncToolArguments(tool, rawArgs);
              if (argsValidation.ok) {
                const argsObj = argsValidation.args;

                // Emit func_call_requested event to build the func-call section UI
                try {
                  await dlg.funcCallRequested(func.id, func.name, argsStr);
                } catch (err) {
                  log.warn('Failed to emit func_call_requested event', err);
                }

                try {
                  await dlg.persistFunctionCall(func.id, func.name, argsObj, callGenseq);
                } catch (err) {
                  log.warn('Failed to persist function call', err);
                }

                try {
                  throwIfAborted(abortSignal, dlg.id);
                  const content = await tool.call(dlg, agent, argsObj);
                  result = {
                    type: 'func_result_msg',
                    id: func.id,
                    name: func.name,
                    content: String(content),
                    role: 'tool',
                    genseq: callGenseq,
                  };
                } catch (err) {
                  result = {
                    type: 'func_result_msg',
                    id: func.id,
                    name: func.name,
                    content: `Function '${func.name}' execution failed: ${showErrorToAi(err)}`,
                    role: 'tool',
                    genseq: callGenseq,
                  };
                }
              } else {
                result = {
                  type: 'func_result_msg',
                  id: func.id,
                  name: func.name,
                  content: `Invalid arguments: ${argsValidation.error}`,
                  role: 'tool',
                  genseq: callGenseq,
                };
              }

              await dlg.receiveFuncResult(result);
              funcResults.push(result);
            });

            await Promise.all(functionPromises);
          }

          if (streamedFuncCalls.length > 0) {
            newMsgs.push(...streamedFuncCalls);
          }
          if (funcResults.length > 0) {
            newMsgs.push(...funcResults);
          }

          await dlg.addChatMessages(...newMsgs);

          // After tool execution, check latest remindersVer with published info,
          // publish new version to propagate updated reminders to ui
          if (dlg.remindersVer > pubRemindersVer) {
            try {
              await dlg.processReminderUpdates();
              pubRemindersVer = dlg.remindersVer;
            } catch (err) {
              log.warn('Failed to propagate reminder text after tools', err);
            }
          }

          await Promise.resolve();

          if (suspendForHuman) {
            break;
          }

          const shouldContinue =
            toolOutputsCount > 0 || streamedFuncCalls.length > 0 || funcResults.length > 0;
          if (!shouldContinue) {
            break;
          }
        }
      } finally {
        await dlg.notifyGeneratingFinish(contextHealthForGen);
      }
    }

    finalRunState = await computeIdleRunState(dlg);
    return lastAssistantSayingContent;
  } catch (err) {
    const stopRequested = getStopRequestedReason(dlg.id);
    const interruptedReason: DialogInterruptionReason | undefined =
      err instanceof DialogInterruptedError
        ? err.reason
        : abortSignal.aborted
          ? stopRequested === 'emergency_stop'
            ? { kind: 'emergency_stop' }
            : stopRequested === 'user_stop'
              ? { kind: 'user_stop' }
              : { kind: 'system_stop', detail: 'Aborted.' }
          : undefined;

    if (interruptedReason) {
      finalRunState = { kind: 'interrupted', reason: interruptedReason };
      broadcastRunStateMarker(dlg.id, { kind: 'interrupted', reason: interruptedReason });
      return null;
    }

    generationHadError = true;
    const errText = extractErrorDetails(err).message;
    try {
      await dlg.streamError(errText);
    } catch (_emitErr) {
      // best-effort
    }
    finalRunState = { kind: 'interrupted', reason: { kind: 'system_stop', detail: errText } };
    broadcastRunStateMarker(dlg.id, {
      kind: 'interrupted',
      reason: { kind: 'system_stop', detail: errText },
    });
    return null;
  } finally {
    clearActiveRun(dlg.id);

    if (!finalRunState) {
      try {
        finalRunState = await computeIdleRunState(dlg);
      } catch (stateErr) {
        log.warn('Failed to compute final run state; falling back to idle', stateErr, {
          dialogId: dlg.id.valueOf(),
        });
        finalRunState = { kind: 'idle_waiting_user' };
      }
    }

    await setDialogRunState(dlg.id, finalRunState);

    if (tookSubdialogResponses) {
      try {
        await withSuspensionStateLock(dlg.id, async () => {
          if (generationHadError) {
            await DialogPersistence.rollbackTakenSubdialogResponses(dlg.id);
          } else {
            await DialogPersistence.commitTakenSubdialogResponses(dlg.id);
          }
        });
      } catch (err2) {
        log.warn('Failed to finalize subdialog response queue after drive', {
          dialogId: dlg.id.selfId,
          error: err2,
        });
      }
    }
  }
} // Close while loop

// Dialog stream has completed - no need to mark queue as complete since we're using receivers

// === SINGLE DIALOG HIERARCHY RESTORATION API ===

/**
 * Single API for restoring the complete dialog hierarchy (main dialog + all subdialogs)
 * This is the only public restoration API - all serialization is implicit
 */
export async function restoreDialogHierarchy(rootDialogId: string): Promise<{
  rootDialog: Dialog;
  subdialogs: Map<string, Dialog>;
  summary: {
    totalMessages: number;
    totalRounds: number;
    completionStatus: 'incomplete' | 'complete' | 'failed';
  };
}> {
  try {
    // Assert that the ID refers to a root dialog, not a subdialog selfId.
    const rootMeta = await DialogPersistence.loadRootDialogMetadata(
      new DialogID(rootDialogId),
      'running',
    );
    if (rootMeta?.supdialogId) {
      throw new Error(
        `Expected root dialog ${rootDialogId} but found subdialog metadata with supdialogId: ${rootMeta.supdialogId}`,
      );
    }

    const rootDialog = await getOrRestoreRootDialog(rootDialogId, 'running');
    if (!rootDialog) {
      throw new Error(`Failed to restore dialog hierarchy for ${rootDialogId}`);
    }
    globalDialogRegistry.register(rootDialog);

    // Restore all subdialogs under this root by reading the persisted subdialogs directory,
    // then ensuring each subdialog is loaded into the root dialog's local registry.
    const subdialogs = new Map<string, Dialog>();

    const rootPath = DialogPersistence.getRootDialogPath(new DialogID(rootDialogId), 'running');
    const subPath = path.join(
      rootPath,
      (DialogPersistence as unknown as { SUBDIALOGS_DIR: string }).SUBDIALOGS_DIR,
    );

    let allSubdialogIds: string[] = [];
    try {
      const entries = await fs.promises.readdir(subPath, { withFileTypes: true });
      allSubdialogIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err: unknown) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (code !== 'ENOENT') {
        log.warn(`Failed to read subdialogs directory: ${subPath}, returning empty array`, err);
      }
      allSubdialogIds = [];
    }

    for (const subdialogId of allSubdialogIds) {
      const restoredSubdialogId = new DialogID(subdialogId, rootDialog.id.rootId);
      const dialog = await ensureDialogLoaded(rootDialog, restoredSubdialogId, 'running');
      if (dialog && dialog.id.selfId !== dialog.id.rootId) {
        subdialogs.set(subdialogId, dialog);
      }
    }

    // Calculate summary statistics
    let totalMessages = rootDialog.msgs.length;
    let totalRounds = rootDialog.currentRound;
    for (const dlg of subdialogs.values()) {
      totalMessages += dlg.msgs.length;
      if (dlg.currentRound > totalRounds) totalRounds = dlg.currentRound;
    }

    const summary: {
      totalMessages: number;
      totalRounds: number;
      completionStatus: 'failed' | 'incomplete' | 'complete';
    } = {
      totalMessages,
      totalRounds,
      completionStatus: 'incomplete',
    };

    return {
      rootDialog,
      subdialogs,
      summary,
    };
  } catch (error) {
    log.error(`Failed to restore dialog hierarchy for ${rootDialogId}:`, error);
    throw error;
  }
}

// === TEAMMATE CALL TYPE SYSTEM (Phase 5) ===
// === PHASE 11 EXTENSION: Type A for subdialog calling its DIRECT parent (supdialog) ===

/**
 * Result of parsing a teammate call pattern.
 * Three types based on the call syntax:
 * - Type A: @<supdialogAgentId> - subdialog calling its direct parent (supdialog suspension)
 * - Type B: @<agentId> !topic <topicId> - creates/resumes registered subdialog
 * - Type C: @<agentId> - creates transient unregistered subdialog
 */
export type TeammateCallParseResult = TeammateCallTypeA | TeammateCallTypeB | TeammateCallTypeC;

/**
 * Type A: Supdialog suspension call.
 * Syntax: @<supdialogAgentId> (when subdialog calls its direct parent)
 * Suspends the subdialog, drives the supdialog for one round, returns response to subdialog.
 * Only triggered when the @agentId matches the current dialog's supdialog.agentId.
 */
export interface TeammateCallTypeA {
  type: 'A';
  agentId: string;
}

/**
 * Type B: Registered subdialog call with topic.
 * Syntax: @<agentId> !topic <topicId>
 * Creates or resumes a registered subdialog, tracked in registry.yaml.
 */
export interface TeammateCallTypeB {
  type: 'B';
  agentId: string;
  topicId: string;
}

/**
 * Type C: Transient subdialog call (unregistered).
 * Syntax: @<agentId> (without !topic)
 * Creates a one-off subdialog that moves to done/ on completion.
 */
export interface TeammateCallTypeC {
  type: 'C';
  agentId: string;
}

function isValidTopicId(topicId: string): boolean {
  const segments = topicId.split('.');
  if (segments.length === 0) return false;
  return segments.every((segment) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(segment));
}

function extractTopicIdFromHeadline(headLine: string, firstMention: string): string | null {
  const mentionToken = `@${firstMention}`;
  const mentionIndex = headLine.indexOf(mentionToken);
  if (mentionIndex < 0) return null;
  const afterMention = headLine.slice(mentionIndex + mentionToken.length);
  const trimmed = afterMention.trimStart();
  if (!trimmed.startsWith('!topic')) return null;
  const rest = trimmed.slice('!topic'.length).trimStart();
  if (!rest) return null;
  const match = rest.match(/^([a-zA-Z][a-zA-Z0-9_-]*(?:\\.[a-zA-Z0-9_-]+)*)/);
  if (!match) return null;
  const topicId = match[1] ?? '';
  return isValidTopicId(topicId) ? topicId : null;
}

/**
 * Parse a teammate call pattern and return the appropriate type result.
 *
 * Patterns:
 * - @<supdialogAgentId> (in subdialog context, matching supdialog.agentId) → Type A (supdialog suspension)
 * - @<agentId> !topic <topicId> → Type B (registered subdialog)
 * - @<agentId> → Type C (transient subdialog)
 *
 * @param firstMention The first teammate mention extracted by the streaming parser (e.g., "teammate")
 * @param headLine The full headline text from the streaming parser
 * @param currentDialog Optional current dialog context to detect Type A (subdialog calling parent)
 * @returns The parsed TeammateCallParseResult
 */
export function parseTeammateCall(
  firstMention: string,
  headLine: string,
  currentDialog?: Dialog,
): TeammateCallParseResult {
  // Fresh Boots Reasoning (FBR) syntax sugar:
  // `@self` always targets the current dialog's agentId (same persona/config).
  //
  // This avoids ambiguous `@teammate`-to-`@teammate` self-calls which can also be produced accidentally
  // by echoing/quoting an assignment headline. We keep parsing behavior the same for all other
  // mentions.
  if (firstMention === 'self') {
    const agentId = currentDialog?.agentId ?? 'self';
    const topicId = extractTopicIdFromHeadline(headLine, 'self');
    if (topicId) {
      return {
        type: 'B',
        agentId,
        topicId,
      };
    }
    return {
      type: 'C',
      agentId,
    };
  }

  const topicId = extractTopicIdFromHeadline(headLine, firstMention);
  if (topicId) {
    return {
      type: 'B',
      agentId: firstMention,
      topicId,
    };
  }

  // Phase 11: Check if this is a Type A call (subdialog calling its direct parent)
  // Type A only applies when:
  // 1. A current dialog context is provided
  // 2. The current dialog is a SubDialog (has a supdialog)
  // 3. The @agentId matches the supdialog's agentId
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

  // Type C: Any @agentId is a transient subdialog call
  return {
    type: 'C',
    agentId: firstMention,
  };
}

// === CONVENIENCE METHODS USING SINGLE RESTORATION API ===

/**
 * Continue dialog with human response (uses single restoration API)
 */
export async function continueDialogWithHumanResponse(
  rootDialogId: string,
  humanPrompt: HumanPrompt,
  options?: {
    targetSubdialogId?: string;
    continuationType?: 'answer' | 'followup' | 'retry' | 'new_message';
  },
): Promise<void> {
  try {
    // Restore the complete dialog hierarchy (pure restoration, no continuation)
    const result = await restoreDialogHierarchy(rootDialogId);

    // Then perform continuation separately
    if (options?.targetSubdialogId && result.subdialogs.has(options.targetSubdialogId)) {
      // Continue specific subdialog
      const targetSubdialog = result.subdialogs.get(options.targetSubdialogId)!;
      await driveDialogStream(targetSubdialog, humanPrompt);
    } else {
      // Continue root dialog
      await driveDialogStream(result.rootDialog, humanPrompt);
    }
  } catch (error) {
    log.error(`Failed to continue dialog with human response:`, error);
    throw error;
  }
}

/**
 * Continue root dialog with followup message (uses single restoration API)
 */
export async function continueRootDialog(
  rootDialogId: string,
  humanPrompt: HumanPrompt,
): Promise<void> {
  try {
    // Restore the complete dialog hierarchy (pure restoration, no continuation)
    const result = await restoreDialogHierarchy(rootDialogId);

    // Then perform continuation separately
    await driveDialogStream(result.rootDialog, humanPrompt);
  } catch (error) {
    log.error(`Failed to continue root dialog:`, error);
    throw error;
  }
}

/**
 * Unified function to extract the last assistant message from an array of messages.
 * Prefers saying_msg over thinking_msg, returns full content without truncation.
 *
 * @param messages Array of chat messages to search
 * @param defaultMessage Default message if no assistant message found
 * @returns The extracted message content or default
 */
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
      // Keep looking for a saying_msg which is more complete
    }
  }

  // If no assistant message found, use the default
  if (!responseText) {
    responseText = defaultMessage;
  }

  return responseText;
}

/**
 * Phase 11: Extract response from supdialog's current messages for Type A mechanism.
 * Used when a subdialog calls its parent (supdialog) and needs the parent's response.
 * Reads from the in-memory dialog object which contains the latest messages after driving.
 *
 * @param supdialog The supdialog that was just driven
 * @returns The response text from the supdialog's last assistant message
 */
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

async function updateSubdialogAssignment(
  subdialog: SubDialog,
  assignment: AssignmentFromSup,
): Promise<void> {
  subdialog.assignmentFromSup = assignment;
  await DialogPersistence.updateSubdialogAssignment(subdialog.id, assignment);
}

async function supplySubdialogResponseToCallerIfPending(
  subdialog: SubDialog,
  responseText: string,
): Promise<void> {
  const assignment = subdialog.assignmentFromSup;
  if (!assignment) {
    return;
  }

  const rootDialog = subdialog.rootDialog;
  const callerDialog = rootDialog.lookupDialog(assignment.callerDialogId);
  if (!callerDialog) {
    log.warn('Missing caller dialog for subdialog response supply', {
      rootId: rootDialog.id.rootId,
      subdialogId: subdialog.id.selfId,
      callerDialogId: assignment.callerDialogId,
    });
    return;
  }

  const pending = await DialogPersistence.loadPendingSubdialogs(callerDialog.id);
  const pendingRecord = pending.find((p) => p.subdialogId === subdialog.id.selfId);
  if (!pendingRecord) {
    // Caller is not waiting on this subdialog anymore; do not auto-revive.
    return;
  }

  await supplyResponseToSupdialog(
    callerDialog,
    subdialog.id,
    responseText,
    pendingRecord.callType,
    assignment.callId,
  );
}

// === PHASE 6: SUBDIALOG SUPPLY MECHANISM ===

/**
 * Create a Type A subdialog for supdialog suspension.
 * Creates subdialog, persists pending record, and returns suspended promise.
 *
 * Type A: Supdialog suspension call where subdialog calls parent and parent suspends.
 *
 * @param supdialog The supdialog making the call
 * @param targetAgentId The agent to handle the subdialog
 * @param headLine The headline for the subdialog
 * @param callBody The body content for the subdialog
 * @returns Promise resolving when subdialog is created and pending record saved
 */
export async function createSubdialogForSupdialog(
  supdialog: RootDialog,
  targetAgentId: string,
  headLine: string,
  callBody: string,
  callId: string,
): Promise<void> {
  try {
    // Create the subdialog
    const subdialog = await supdialog.createSubDialog(targetAgentId, headLine, callBody, {
      originMemberId: supdialog.agentId,
      callerDialogId: supdialog.id.selfId,
      callId,
    });

    // Persist pending subdialog record
    const pendingRecord: PendingSubdialogRecordType = {
      subdialogId: subdialog.id.selfId,
      createdAt: formatUnifiedTimestamp(new Date()),
      headLine,
      targetAgentId,
      callType: 'A',
    };

    // Load existing pending subdialogs and add new one
    await withSuspensionStateLock(supdialog.id, async () => {
      const existingPending = await DialogPersistence.loadPendingSubdialogs(supdialog.id);
      existingPending.push(pendingRecord);
      await DialogPersistence.savePendingSubdialogs(supdialog.id, existingPending);
    });

    // Drive the subdialog asynchronously
    void (async () => {
      try {
        const initPrompt: HumanPrompt = {
          content: formatAssignmentFromSupdialog({
            fromAgentId: supdialog.agentId,
            toAgentId: subdialog.agentId,
            headLine,
            callBody: callBody,
            language: getWorkLanguage(),
          }),
          msgId: generateShortId(),
          grammar: 'markdown',
        };
        await driveDialogStream(subdialog, initPrompt, true);
      } catch (err) {
        log.warn('Type A subdialog processing error:', err);
      }
    })();
  } catch (error) {
    log.error('Failed to create Type A subdialog for supdialog', {
      supdialogId: supdialog.id.selfId,
      targetAgentId,
      error,
    });
    throw error;
  }
}

/**
 * Create a Type B registered subdialog with registry lookup/register.
 * Creates or resumes a registered subdialog tracked in registry.yaml.
 *
 * Type B: @<agentId> !topic <topicId> - Creates/resumes registered subdialog.
 *
 * @param rootDialog The root dialog making the call
 * @param agentId The agent to handle the subdialog
 * @param topicId The topic identifier for registry lookup
 * @param headLine The headline for the subdialog
 * @param callBody The body content for the subdialog
 * @returns Promise resolving when subdialog is created/registered
 */
/**
 * Supply a response from a completed subdialog to the supdialog.
 * Writes the response to persistence for later incorporation.
 *
 * @param parentDialog The supdialog that created the subdialog
 * @param subdialogId The ID of the completed subdialog
 * @param responseText The full response text from the subdialog
 * @param callType The call type ('A', 'B', or 'C')
 * @param callId Optional callId for Type C subdialog tracking
 */
export async function supplyResponseToSupdialog(
  parentDialog: Dialog,
  subdialogId: DialogID,
  responseText: string,
  callType: 'A' | 'B' | 'C',
  callId?: string,
): Promise<void> {
  try {
    const result = await withSuspensionStateLock(parentDialog.id, async () => {
      const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(parentDialog.id);
      let pendingRecord: PendingSubdialogRecordType | undefined;
      const filteredPending: PendingSubdialogRecordType[] = [];
      for (const pending of pendingSubdialogs) {
        if (pending.subdialogId === subdialogId.selfId) {
          pendingRecord = pending;
        } else {
          filteredPending.push(pending);
        }
      }

      let responderId = subdialogId.rootId;
      let responderAgentId: string | undefined;
      let headLine = responseText;
      let originMemberId: string | undefined;

      try {
        let metadata = await DialogPersistence.loadDialogMetadata(subdialogId, 'running');
        if (!metadata) {
          metadata = await DialogPersistence.loadDialogMetadata(subdialogId, 'completed');
        }
        if (metadata && metadata.assignmentFromSup) {
          originMemberId = metadata.assignmentFromSup.originMemberId;
          if (!pendingRecord) {
            const assignmentHead = metadata.assignmentFromSup.headLine;
            if (typeof assignmentHead === 'string' && assignmentHead.trim() !== '') {
              headLine = assignmentHead;
            }
          }
        }
        if (!pendingRecord && metadata && typeof metadata.agentId === 'string') {
          if (metadata.agentId.trim() !== '') {
            responderId = metadata.agentId;
            responderAgentId = metadata.agentId;
          }
        }
      } catch (err) {
        log.warn('Failed to load subdialog metadata for response record', {
          parentId: parentDialog.id.selfId,
          subdialogId: subdialogId.selfId,
          error: err,
        });
      }

      if (!originMemberId) {
        originMemberId = parentDialog.agentId;
      }

      if (pendingRecord) {
        responderId = pendingRecord.targetAgentId;
        responderAgentId = pendingRecord.targetAgentId;
        headLine = pendingRecord.headLine;
      }

      if (headLine.trim() === '') {
        headLine = responseText.slice(0, 100) + (responseText.length > 100 ? '...' : '');
      }

      const responseContent = formatTeammateResponseContent({
        responderId,
        requesterId: originMemberId,
        originalCallHeadLine: headLine,
        responseBody: responseText,
        language: getWorkLanguage(),
      });

      const completedAt = formatUnifiedTimestamp(new Date());
      const responseId = generateShortId();
      await DialogPersistence.appendSubdialogResponse(parentDialog.id, {
        responseId,
        subdialogId: subdialogId.selfId,
        response: responseText,
        completedAt,
        callType,
        headLine,
        responderId,
        originMemberId,
        callId: callId ?? '',
      });

      await DialogPersistence.savePendingSubdialogs(parentDialog.id, filteredPending);

      const hasQ4H = await parentDialog.hasPendingQ4H();
      const shouldRevive = !hasQ4H && filteredPending.length === 0;
      if (shouldRevive && parentDialog instanceof RootDialog) {
        await DialogPersistence.setNeedsDrive(parentDialog.id, true, parentDialog.status);
      }

      return {
        responderId,
        responderAgentId,
        headLine,
        originMemberId,
        responseContent,
        filteredPendingCount: filteredPending.length,
        shouldRevive,
      };
    });

    const resolvedAgentId = result.responderAgentId ?? result.responderId;
    const resolvedOriginMemberId = result.originMemberId ?? parentDialog.agentId;
    const resolvedCallId = callId ?? '';

    await parentDialog.receiveTeammateResponse(
      result.responderId,
      result.headLine,
      result.responseContent,
      'completed',
      subdialogId,
      {
        response: responseText,
        agentId: resolvedAgentId,
        callId: resolvedCallId,
        originMemberId: resolvedOriginMemberId,
      },
    );

    if (result.shouldRevive) {
      log.info(
        `All Type ${callType} subdialogs complete, parent ${parentDialog.id.selfId} auto-reviving`,
      );
      if (parentDialog instanceof RootDialog) {
        globalDialogRegistry.markNeedsDrive(parentDialog.id.rootId);
      } else {
        void driveDialogStream(parentDialog, undefined, true);
      }
    }
  } catch (error) {
    log.error('Failed to supply subdialog response', {
      parentId: parentDialog.id.selfId,
      subdialogId: subdialogId.selfId,
      error,
    });
    throw error;
  }
}

/**
 * Check if all pending Type A subdialogs are satisfied (have responses).
 *
 * @param rootDialogId The root dialog ID to check
 * @returns Promise<boolean> True if all Type A subdialogs have responses
 */
export async function areAllSubdialogsSatisfied(rootDialogId: DialogID): Promise<boolean> {
  try {
    const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(rootDialogId);
    const responses = await DialogPersistence.loadSubdialogResponses(rootDialogId);

    // Check if any pending subdialogs have responses
    const pendingIds = new Set(pendingSubdialogs.map((p) => p.subdialogId));
    const respondedIds = new Set(responses.map((r) => r.subdialogId));

    // Check if all pending subdialogs have been responded to
    for (const pendingId of pendingIds) {
      if (!respondedIds.has(pendingId)) {
        return false;
      }
    }

    return true;
  } catch (error) {
    log.error('Failed to check subdialog satisfaction', {
      rootDialogId: rootDialogId.selfId,
      error,
    });
    return false;
  }
}

/**
 * Incorporate subdialog responses into the supdialog and resume.
 * Reads responses from persistence and clears them after incorporation.
 *
 * @param rootDialog The root dialog to resume
 * @returns Promise<Array<{ subdialogId: string; response: string; callType: 'A' | 'B' | 'C' }>>
 *   Array of incorporated responses (response holds full response text)
 */
export async function incorporateSubdialogResponses(rootDialog: RootDialog): Promise<
  Array<{
    subdialogId: string;
    response: string;
    callType: 'A' | 'B' | 'C';
  }>
> {
  try {
    const responses = await DialogPersistence.loadSubdialogResponses(rootDialog.id);

    // Incorporate each response
    for (const response of responses) {
      const subdialogId = new DialogID(response.subdialogId, rootDialog.id.rootId);

      // Emit subdialog response event (payload contains full response text)
      await rootDialog.postSubdialogResponse(subdialogId, response.response);
    }

    // Clear responses after incorporation
    await DialogPersistence.saveSubdialogResponses(rootDialog.id, []);

    // Clear pending subdialogs that have been responded to
    const pendingSubdialogs = await DialogPersistence.loadPendingSubdialogs(rootDialog.id);
    const respondedIds = new Set(responses.map((r) => r.subdialogId));
    const filteredPending = pendingSubdialogs.filter((p) => !respondedIds.has(p.subdialogId));
    await DialogPersistence.savePendingSubdialogs(rootDialog.id, filteredPending);

    return responses;
  } catch (error) {
    log.error('Failed to incorporate subdialog responses', {
      rootDialogId: rootDialog.id.selfId,
      error,
    });
    throw error;
  }
}

/**
 * Collect texting calls using the streaming parser, then execute them
 */
async function executeTextingCalls(
  dlg: Dialog,
  agent: Team.Member,
  textingTools: TextingTool[],
  collectedCalls: CollectedTextingCall[],
): Promise<{ suspend: boolean; toolOutputs: ChatMessage[]; subdialogsCreated: DialogID[] }> {
  // Execute collected calls concurrently
  const results = await Promise.all(
    collectedCalls.map((call) =>
      executeTextingCall(
        dlg,
        agent,
        textingTools,
        call.firstMention,
        call.headLine,
        call.body,
        call.callId,
      ),
    ),
  );

  // Combine results from all concurrent calls
  const suspend = results.some((result) => result.suspend);
  const toolOutputs = results.flatMap((result) => result.toolOutputs);
  const subdialogsCreated = results.flatMap((result) => result.subdialogsCreated);

  return { suspend, toolOutputs, subdialogsCreated };
}

/**
 * Execute a single texting call using Phase 5 3-Type Taxonomy.
 * Handles Type A (supdialog suspension), Type B (registered subdialog), and Type C (transient subdialog).
 */
async function executeTextingCall(
  dlg: Dialog,
  agent: Team.Member,
  textingTools: TextingTool[],
  firstMention: string,
  headLine: string,
  body: string,
  callId: string,
): Promise<{
  toolOutputs: ChatMessage[];
  suspend: boolean;
  subdialogsCreated: DialogID[];
}> {
  const toolOutputs: ChatMessage[] = [];
  let suspend = false;
  const subdialogsCreated: DialogID[] = [];

  const team = await Team.load();
  const intrinsicTools = dlg.getIntrinsicTools();
  const isSelfAlias = firstMention === 'self';
  const isSuperAlias = firstMention === 'super';
  const member = isSelfAlias ? team.getMember(dlg.agentId) : team.getMember(firstMention);

  // === Q4H: Handle @human teammate calls (Questions for Human) ===
  // Q4H works for both user-initiated and assistant-initiated @human calls
  const isQ4H = firstMention === 'human';
  if (isQ4H) {
    try {
      // Create HumanQuestion entry
      const questionId = `q4h-${generateDialogID()}`;
      const question: HumanQuestion = {
        id: questionId,
        headLine: headLine.trim(),
        bodyContent: body.trim(),
        askedAt: formatUnifiedTimestamp(new Date()),
        callSiteRef: {
          round: dlg.currentRound,
          messageIndex: dlg.msgs.length,
        },
      };

      // Load existing questions and add new one
      const existingQuestions = await DialogPersistence.loadQuestions4HumanState(dlg.id);
      const previousCount = existingQuestions.length;
      existingQuestions.push(question);

      // Save to q4h.yaml
      await DialogPersistence._saveQuestions4HumanState(dlg.id, existingQuestions);

      // Emit new_q4h_asked event
      const newQuestionEvent: NewQ4HAskedEvent = {
        type: 'new_q4h_asked',
        question: {
          id: question.id,
          dialogId: dlg.id.selfId,
          headLine: question.headLine,
          bodyContent: question.bodyContent,
          askedAt: question.askedAt,
          callSiteRef: question.callSiteRef,
        },
      };

      postDialogEvent(dlg, newQuestionEvent);

      // Return empty output and suspend for human answer
      return { toolOutputs, suspend: true, subdialogsCreated: [] };
    } catch (q4hErr: unknown) {
      const errMsg = q4hErr instanceof Error ? q4hErr.message : String(q4hErr);
      const errStack = q4hErr instanceof Error ? q4hErr.stack : '';
      log.error('Q4H: Failed to register question', q4hErr, {
        dialogId: dlg.id.selfId,
        headLine: headLine.substring(0, 100),
      });
      // Don't throw - allow fallback to "Unknown call" handler
    }
  }

  if (member || isSelfAlias || isSuperAlias) {
    // This is a teammate call - parse using Phase 5 taxonomy
    // Parse the call text to determine type A/B/C
    if (isSuperAlias && !(dlg instanceof SubDialog)) {
      const response = formatDomindsNoteSuperOnlyInSubdialog(getWorkLanguage());
      const result = formatTeammateResponseContent({
        responderId: 'dominds',
        requesterId: dlg.agentId,
        originalCallHeadLine: headLine,
        responseBody: response,
        language: getWorkLanguage(),
      });
      try {
        await dlg.receiveTeammateResponse('dominds', headLine, result, 'failed', dlg.id, {
          response,
          agentId: 'dominds',
          callId,
          originMemberId: dlg.agentId,
        });
      } catch (err) {
        log.warn('Failed to emit @super misuse response', err, {
          dialogId: dlg.id.selfId,
          agentId: dlg.agentId,
        });
      }
      return { toolOutputs, suspend: false, subdialogsCreated: [] };
    }

    if (isSuperAlias) {
      const topicId = extractTopicIdFromHeadline(headLine, 'super');
      if (topicId) {
        const response = formatDomindsNoteSuperNoTopic(getWorkLanguage());
        const result = formatTeammateResponseContent({
          responderId: 'dominds',
          requesterId: dlg.agentId,
          originalCallHeadLine: headLine,
          responseBody: response,
          language: getWorkLanguage(),
        });
        try {
          await dlg.receiveTeammateResponse('dominds', headLine, result, 'failed', dlg.id, {
            response,
            agentId: 'dominds',
            callId,
            originMemberId: dlg.agentId,
          });
        } catch (err) {
          log.warn('Failed to emit @super !topic syntax error response', err, {
            dialogId: dlg.id.selfId,
            agentId: dlg.agentId,
          });
        }
        return { toolOutputs, suspend: false, subdialogsCreated: [] };
      }
    }

    const parseResult: TeammateCallParseResult = isSuperAlias
      ? {
          type: 'A',
          agentId: (dlg as SubDialog).supdialog.agentId,
        }
      : parseTeammateCall(firstMention, headLine, dlg);

    // If the agent calls itself via `@<agentId>` (instead of `@self`), allow it to proceed
    // (self-calls are useful for FBR), but emit a correction bubble so the user can distinguish
    // intentional self-FBR from accidental echo/quote triggers.
    const isDirectSelfCall = !isSelfAlias && !isSuperAlias && parseResult.agentId === dlg.agentId;
    if (isDirectSelfCall) {
      const response = formatDomindsNoteDirectSelfCall(getWorkLanguage());
      const result = formatTeammateResponseContent({
        responderId: 'dominds',
        requesterId: dlg.agentId,
        originalCallHeadLine: headLine,
        responseBody: response,
        language: getWorkLanguage(),
      });
      try {
        await dlg.receiveTeammateResponse('dominds', headLine, result, 'completed', dlg.id, {
          response,
          agentId: 'dominds',
          callId,
          originMemberId: dlg.agentId,
        });
      } catch (err) {
        log.warn('Failed to emit self-call correction response', err, {
          dialogId: dlg.id.selfId,
          agentId: dlg.agentId,
        });
      }
    }

    // Phase 11: Type A handling - subdialog calling its direct parent (supdialog)
    // This suspends the subdialog, drives the supdialog for one round, then returns to subdialog
    if (parseResult.type === 'A') {
      // Type A is only valid from a subdialog (calling back to its supdialog).
      if (dlg instanceof SubDialog) {
        const supdialog = dlg.supdialog;

        // Suspend the subdialog
        dlg.setSuspensionState('suspended');

        try {
          const headLineForSupdialog =
            isSuperAlias && headLine.startsWith('@super')
              ? `@${supdialog.agentId}${headLine.slice('@super'.length)}`
              : headLine;
          const assignment = dlg.assignmentFromSup;
          const supPrompt: HumanPrompt = {
            content: formatSupdialogCallPrompt({
              fromAgentId: dlg.agentId,
              toAgentId: supdialog.agentId,
              subdialogRequest: {
                headLine: headLineForSupdialog,
                callBody: body,
              },
              supdialogAssignment: {
                headLine: assignment.headLine,
                callBody: assignment.callBody,
              },
              language: getWorkLanguage(),
            }),
            msgId: generateShortId(),
            grammar: 'markdown',
          };
          // Drive the supdialog for one round (queue if already driving)
          await driveDialogStream(supdialog, supPrompt, true);

          // Extract response from supdialog's last assistant message
          const responseText = await extractSupdialogResponseForTypeA(supdialog);
          const responseContent = formatTeammateResponseContent({
            responderId: parseResult.agentId,
            requesterId: dlg.agentId,
            originalCallHeadLine: headLine,
            responseBody: responseText,
            language: getWorkLanguage(),
          });

          // Resume the subdialog with the supdialog's response
          dlg.setSuspensionState('resumed');

          const resultMsg: TextingCallResultMsg = {
            type: 'call_result_msg',
            role: 'tool',
            responderId: parseResult.agentId,
            headLine,
            status: 'completed',
            content: responseContent,
          };
          toolOutputs.push(resultMsg);
          await dlg.receiveTeammateResponse(
            parseResult.agentId,
            headLine,
            responseContent,
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
          // Resume the subdialog even on error
          dlg.setSuspensionState('resumed');
          const errorText = `❌ **Error processing request to @${parseResult.agentId}:**\n\n${showErrorToAi(err)}`;
          const resultMsg: TextingCallResultMsg = {
            type: 'call_result_msg',
            role: 'tool',
            responderId: parseResult.agentId,
            headLine,
            status: 'failed',
            content: errorText,
          };
          toolOutputs.push(resultMsg);
          await dlg.receiveTeammateResponse(
            parseResult.agentId,
            headLine,
            errorText,
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
        // Fall through to Type C handling
      }
    } else if (parseResult.type === 'B') {
      // Type B: Registered subdialog with topic (root registry, caller can be root or subdialog)
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
          const sub = await dlg.createSubDialog(parseResult.agentId, headLine, body, {
            originMemberId: dlg.agentId,
            callerDialogId: callerDialog.id.selfId,
            callId,
            topicId: parseResult.topicId,
          });

          const pendingRecord: PendingSubdialogRecordType = {
            subdialogId: sub.id.selfId,
            createdAt: formatUnifiedTimestamp(new Date()),
            headLine,
            targetAgentId: parseResult.agentId,
            callType: 'C',
            topicId: parseResult.topicId,
          };
          await withSuspensionStateLock(dlg.id, async () => {
            const existingPending = await DialogPersistence.loadPendingSubdialogs(dlg.id);
            existingPending.push(pendingRecord);
            await DialogPersistence.savePendingSubdialogs(dlg.id, existingPending);
          });

          const task = (async () => {
            try {
              const initPrompt: HumanPrompt = {
                content: formatAssignmentFromSupdialog({
                  fromAgentId: dlg.agentId,
                  toAgentId: sub.agentId,
                  headLine,
                  callBody: body,
                  language: getWorkLanguage(),
                }),
                msgId: generateShortId(),
                grammar: 'markdown',
              };
              await driveDialogStream(sub, initPrompt, true);
            } catch (err) {
              log.warn('Type B fallback subdialog processing error:', err);
            }
          })();
          void task;
          subdialogsCreated.push(sub.id);
          suspend = true;
        } catch (err) {
          log.warn('Type B fallback subdialog creation error:', err);
        }
      } else {
        const originMemberId = dlg.agentId;
        const assignment: AssignmentFromSup = {
          headLine,
          callBody: body,
          originMemberId,
          callerDialogId: callerDialog.id.selfId,
          callId,
        };

        const existingSubdialog = rootDialog.lookupSubdialog(
          parseResult.agentId,
          parseResult.topicId,
        );

        const pendingOwner = callerDialog;

        if (existingSubdialog) {
          const resumePrompt: HumanPrompt = {
            content: formatAssignmentFromSupdialog({
              fromAgentId: dlg.agentId,
              toAgentId: existingSubdialog.agentId,
              headLine,
              callBody: body,
              language: getWorkLanguage(),
            }),
            msgId: generateShortId(),
            grammar: 'markdown',
          };
          try {
            await updateSubdialogAssignment(existingSubdialog, assignment);
          } catch (err) {
            log.warn('Failed to update registered subdialog assignment', err);
          }

          const pendingRecord: PendingSubdialogRecordType = {
            subdialogId: existingSubdialog.id.selfId,
            createdAt: formatUnifiedTimestamp(new Date()),
            headLine,
            targetAgentId: parseResult.agentId,
            callType: 'B',
            topicId: parseResult.topicId,
          };
          await withSuspensionStateLock(pendingOwner.id, async () => {
            const existingPending = await DialogPersistence.loadPendingSubdialogs(pendingOwner.id);
            existingPending.push(pendingRecord);
            await DialogPersistence.savePendingSubdialogs(pendingOwner.id, existingPending);
          });

          const task = (async () => {
            try {
              await driveDialogStream(existingSubdialog, resumePrompt, true);
            } catch (err) {
              log.warn('Type B registered subdialog resumption error:', err);
            }
          })();
          void task;
          subdialogsCreated.push(existingSubdialog.id);
          suspend = true;
        } else {
          const sub = await rootDialog.createSubDialog(parseResult.agentId, headLine, body, {
            originMemberId,
            callerDialogId: callerDialog.id.selfId,
            callId,
            topicId: parseResult.topicId,
          });
          rootDialog.registerSubdialog(sub);
          await rootDialog.saveSubdialogRegistry();

          const pendingRecord: PendingSubdialogRecordType = {
            subdialogId: sub.id.selfId,
            createdAt: formatUnifiedTimestamp(new Date()),
            headLine,
            targetAgentId: parseResult.agentId,
            callType: 'B',
            topicId: parseResult.topicId,
          };
          await withSuspensionStateLock(pendingOwner.id, async () => {
            const existingPending = await DialogPersistence.loadPendingSubdialogs(pendingOwner.id);
            existingPending.push(pendingRecord);
            await DialogPersistence.savePendingSubdialogs(pendingOwner.id, existingPending);
          });

          const task = (async () => {
            try {
              const initPrompt: HumanPrompt = {
                content: formatAssignmentFromSupdialog({
                  fromAgentId: rootDialog.agentId,
                  toAgentId: sub.agentId,
                  headLine,
                  callBody: body,
                  language: getWorkLanguage(),
                }),
                msgId: generateShortId(),
                grammar: 'markdown',
              };
              await driveDialogStream(sub, initPrompt, true);
            } catch (err) {
              log.warn('Type B subdialog processing error:', err);
            }
          })();
          void task;
          subdialogsCreated.push(sub.id);
          suspend = true;
        }
      }
    }

    // Type C: Transient subdialog (unregistered)
    if (parseResult.type === 'C') {
      const targets = isSelfAlias
        ? [parseResult.agentId]
        : Array.from(new Set(extractMentions(headLine))).filter((m) => !!team.getMember(m));

      for (const tgt of targets) {
        try {
          const sub = await dlg.createSubDialog(tgt, headLine, body, {
            originMemberId: dlg.agentId,
            callerDialogId: dlg.id.selfId,
            callId,
          });
          const pendingRecord: PendingSubdialogRecordType = {
            subdialogId: sub.id.selfId,
            createdAt: formatUnifiedTimestamp(new Date()),
            headLine,
            targetAgentId: tgt,
            callType: 'C',
          };
          await withSuspensionStateLock(dlg.id, async () => {
            const existingPending = await DialogPersistence.loadPendingSubdialogs(dlg.id);
            existingPending.push(pendingRecord);
            await DialogPersistence.savePendingSubdialogs(dlg.id, existingPending);
          });

          const task = (async () => {
            try {
              const initPrompt: HumanPrompt = {
                content: formatAssignmentFromSupdialog({
                  fromAgentId: dlg.agentId,
                  toAgentId: sub.agentId,
                  headLine,
                  callBody: body,
                  language: getWorkLanguage(),
                }),
                msgId: generateShortId(),
                grammar: 'markdown',
              };
              // Type C: Move to done/ on completion (handled by subdialog completion)
              await driveDialogStream(sub, initPrompt, true);
            } catch (err) {
              log.warn('Type C subdialog processing error:', err);
            }
          })();
          void task;
          subdialogsCreated.push(sub.id);
        } catch (err) {
          log.warn('Subdialog creation error:', err);
        }
      }

      if (subdialogsCreated.length > 0) {
        suspend = true;
      }
    }
  } else {
    // Not a team member - check for texting tools
    let tool =
      textingTools.find((t) => t.name === firstMention) ||
      intrinsicTools.find((t) => t.name === firstMention);
    if (!tool) {
      try {
        const globalTool = getTool(firstMention);
        switch (globalTool?.type) {
          case 'texter':
            tool = globalTool;
            break;
          case 'func':
            log.warn(`Function tool "${globalTool.name}" should not be called as texting tool!`);
            break;
        }
      } catch (toolErr) {
        // Fall through
      }
    }
    if (tool) {
      try {
        const raw = await tool.call(dlg, agent, headLine, body);

        // Always use what the tool returned
        if (raw.messages) {
          toolOutputs.push(...raw.messages);
        }

        // Emit tool response with callId (inline bubble) - callId is for UI correlation only
        const defaultOk = 'OK';
        await dlg.receiveToolResponse(
          firstMention,
          headLine,
          raw.status === 'completed' ? (raw.result ?? defaultOk) : raw.result,
          raw.status,
          callId,
        );

        // Clear callId after response
        dlg.clearCurrentCallId();

        if (tool.backfeeding && !raw.messages) {
          log.warn(
            `Texting tool @${firstMention} returned empty output while backfeeding=true`,
            undefined,
            { headLine },
          );
        }
      } catch (e) {
        const msg = `ERR_TOOL_EXECUTION\n${showErrorToAi(e)}`;
        toolOutputs.push({
          type: 'environment_msg',
          role: 'user',
          content: msg,
        });

        // Create error message (no callId - for LLM context only)
        const errorMsg: TextingCallResultMsg = {
          type: 'call_result_msg',
          role: 'tool',
          responderId: firstMention,
          headLine,
          status: 'failed',
          content: msg,
        };
        toolOutputs.push(errorMsg);

        // Emit tool response with callId for UI correlation
        await dlg.receiveToolResponse(firstMention, headLine, msg, 'failed', callId);

        // Clear callId after response
        dlg.clearCurrentCallId();
      }
    } else {
      const msg = 'ERR_UNKNOWN_CALL';
      toolOutputs.push({
        type: 'environment_msg',
        role: 'user',
        content: msg,
      });

      // Create error message for LLM context
      const errorMsg: TextingCallResultMsg = {
        type: 'call_result_msg',
        role: 'tool',
        responderId: firstMention,
        headLine,
        status: 'failed',
        content: msg,
      };
      toolOutputs.push(errorMsg);

      // Emit tool response with the parser-provided callId so the UI can attach inline.
      await dlg.receiveToolResponse(firstMention, headLine, msg, 'failed', callId);

      // Clear callId after response
      dlg.clearCurrentCallId();
      log.warn(`Unknown call @${firstMention} | Head: ${headLine}`);
    }
  }

  return { toolOutputs, suspend, subdialogsCreated };
}
