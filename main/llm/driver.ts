/**
 * Module: llm/driver
 *
 * Drives dialog streaming end-to-end:
 * - Loads minds/tools, selects generator, streams outputs
 * - Parses tellask blocks (teammate tellasks), handles human prompts
 * - Supports autonomous teammate tellasks: when an agent mentions a teammate (e.g., @teammate), a subdialog is created and driven; the parent logs the initiating assistant bubble and system creation/result, while subdialog conversation stays in the subdialog
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
import { DEFAULT_DILIGENCE_PUSH_MAX, DILIGENCE_FALLBACK_TEXT } from '../shared/diligence';
import {
  formatDomindsNoteDirectSelfCall,
  formatDomindsNoteInvalidMultiTeammateTargets,
  formatDomindsNoteInvalidTellaskSessionDirective,
  formatDomindsNoteMalformedTellaskCall,
  formatDomindsNoteMultipleTellaskSessionDirectives,
  formatDomindsNoteSuperNoTellaskSession,
  formatDomindsNoteSuperOnlyInSubdialog,
  formatDomindsNoteTellaskForTeammatesOnly,
  formatReminderItemGuide,
  formatUserFacingContextHealthV3RemediationGuide,
  formatUserFacingLanguageGuide,
} from '../shared/i18n/driver-messages';
import { getWorkLanguage } from '../shared/runtime-language';
import type {
  ContextHealthLevel,
  ContextHealthSnapshot,
  LlmUsageStats,
} from '../shared/types/context-health';
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
import { CollectedTellaskCall, TellaskEventsReceiver, TellaskStreamParser } from '../tellask';
import { FuncTool, Tool, validateArgs, type ToolArguments } from '../tool';
import { generateDialogID } from '../utils/id';
import { formatTaskDocContent } from '../utils/taskdoc';
import {
  ChatMessage,
  FuncCallMsg,
  FuncResultMsg,
  LlmConfig,
  SayingMsg,
  TellaskCallResultMsg,
  ThinkingMsg,
  type ModelInfo,
  type ProviderConfig,
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

const DEFAULT_KEEP_GOING_MAX_NUM_PROMPTS = DEFAULT_DILIGENCE_PUSH_MAX;

function isNodeErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function resolveMemberDiligencePushMax(team: Team, agentId: string): number {
  const member = team.getMember(agentId);
  if (member && member.diligence_push_max !== undefined) {
    return member.diligence_push_max;
  }
  return DEFAULT_KEEP_GOING_MAX_NUM_PROMPTS;
}

function stripMarkdownFrontmatter(raw: string): string {
  // We no longer honor frontmatter config in diligence files.
  // If frontmatter exists, strip it to preserve backward compatibility with old files.
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return match ? (match[1] ?? '') : raw;
}

type RtwsDiligenceResolution =
  | { kind: 'disabled'; reason: 'empty_file' | 'empty_body' }
  | { kind: 'enabled'; diligenceText: string };

async function resolveRtwsDiligenceConfig(
  workLanguage: LanguageCode,
): Promise<RtwsDiligenceResolution> {
  const langSpecificPath = path.resolve(process.cwd(), '.minds', `diligence.${workLanguage}.md`);
  const genericPath = path.resolve(process.cwd(), '.minds', 'diligence.md');

  async function resolveFromFile(filePath: string): Promise<RtwsDiligenceResolution | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf-8');
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error) && error.code === 'ENOENT') {
        return null;
      }
      log.warn('Failed to read rtws diligence file; falling back to built-in defaults', error, {
        filePath,
      });
      return {
        kind: 'enabled',
        diligenceText: DILIGENCE_FALLBACK_TEXT[workLanguage],
      };
    }

    const trimmed = raw.trim();
    // Existing empty file explicitly disables keep-going.
    if (trimmed === '') {
      return { kind: 'disabled', reason: 'empty_file' };
    }

    const bodyTrimmed = stripMarkdownFrontmatter(raw).trim();
    if (bodyTrimmed === '') {
      return { kind: 'disabled', reason: 'empty_body' };
    }

    return { kind: 'enabled', diligenceText: bodyTrimmed };
  }

  const langSpecific = await resolveFromFile(langSpecificPath);
  if (langSpecific) {
    return langSpecific;
  }

  const generic = await resolveFromFile(genericPath);
  if (generic) {
    return generic;
  }

  // No diligence file found: use built-in prompt + default max.
  return {
    kind: 'enabled',
    diligenceText: DILIGENCE_FALLBACK_TEXT[workLanguage],
  };
}

async function maybePrepareDiligenceAutoContinuePrompt(options: {
  dlg: Dialog;
  isRootDialog: boolean;
  alreadyInjectedCount: number;
  diligencePushMax: number;
}): Promise<
  | { kind: 'disabled'; nextInjectedCount: number }
  | { kind: 'budget_exhausted'; maxInjectCount: number; nextInjectedCount: number }
  | { kind: 'prompt'; prompt: HumanPrompt; maxInjectCount: number; nextInjectedCount: number }
> {
  if (!options.isRootDialog) {
    return { kind: 'disabled', nextInjectedCount: options.alreadyInjectedCount };
  }

  if (options.dlg.disableDiligencePush) {
    return { kind: 'disabled', nextInjectedCount: options.alreadyInjectedCount };
  }

  if (options.diligencePushMax < 1) {
    return { kind: 'disabled', nextInjectedCount: options.alreadyInjectedCount };
  }

  const resolved = await resolveRtwsDiligenceConfig(getWorkLanguage());
  if (resolved.kind === 'disabled') {
    return { kind: 'disabled', nextInjectedCount: options.alreadyInjectedCount };
  }

  const maxInjectCount = options.diligencePushMax;
  if (maxInjectCount < 1) {
    return { kind: 'disabled', nextInjectedCount: options.alreadyInjectedCount };
  }
  if (options.alreadyInjectedCount >= maxInjectCount) {
    return {
      kind: 'budget_exhausted',
      maxInjectCount,
      nextInjectedCount: options.alreadyInjectedCount,
    };
  }

  const prompt: HumanPrompt = {
    content: resolved.diligenceText,
    msgId: generateShortId(),
    grammar: 'markdown',
  };
  return {
    kind: 'prompt',
    prompt,
    maxInjectCount,
    nextInjectedCount: options.alreadyInjectedCount + 1,
  };
}

async function suspendForKeepGoingBudgetExhausted(options: {
  dlg: Dialog;
  maxInjectCount: number;
}): Promise<void> {
  const { dlg, maxInjectCount } = options;
  const questionId = `q4h-${generateDialogID()}`;
  const question: HumanQuestion = {
    id: questionId,
    kind: 'keep_going_budget_exhausted',
    headLine: '@human',
    bodyContent:
      `Keep-going budget exhausted (max ${maxInjectCount}).\n\n` +
      'Please confirm what to do next:\n' +
      '- Reply with “continue” to allow the agent to keep going, or\n' +
      '- Reply with “stop” if you want to stop this dialog here.\n',
    askedAt: formatUnifiedTimestamp(new Date()),
    callSiteRef: {
      round: dlg.currentRound,
      messageIndex: dlg.msgs.length,
    },
  };

  const existingQuestions = await DialogPersistence.loadQuestions4HumanState(dlg.id);
  existingQuestions.push(question);
  await DialogPersistence._saveQuestions4HumanState(dlg.id, existingQuestions);

  const newQuestionEvent: NewQ4HAskedEvent = {
    type: 'new_q4h_asked',
    question: {
      id: question.id,
      kind: question.kind,
      selfId: dlg.id.selfId,
      headLine: question.headLine,
      bodyContent: question.bodyContent,
      askedAt: question.askedAt,
      callSiteRef: question.callSiteRef,
      rootId: dlg.id.rootId,
      agentId: dlg.agentId,
      taskDocPath: dlg.taskDocPath,
    },
  };
  postDialogEvent(dlg, newQuestionEvent);
}

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
  tellaskSession?: string;
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

  {
    const msg =
      err instanceof Error
        ? err.message && err.message.length > 0
          ? err.message
          : err.name
        : typeof err === 'string'
          ? err
          : undefined;
    if (typeof msg === 'string' && msg.length > 0) {
      const lower = msg.toLowerCase();
      if (lower.includes('fetch failed') || lower.includes('socket hang up')) {
        return { kind: 'retriable', message: msg };
      }
      if (lower.includes('terminated')) {
        return { kind: 'retriable', message: msg };
      }
      if (
        lower.includes('timeout') ||
        lower.includes('timed out') ||
        lower.includes('rate limit')
      ) {
        return { kind: 'retriable', message: msg };
      }
    }
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
        // undici / Node.js fetch
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
        'UND_ERR_SOCKET',
      ]);
      if (retriableCodes.has(code)) {
        return { kind: 'retriable', code, message: msg };
      }
    }

    const lower = msg.toLowerCase();
    if (lower.includes('fetch failed') || lower.includes('socket hang up')) {
      return { kind: 'retriable', message: msg };
    }
    if (lower.includes('terminated')) {
      return { kind: 'retriable', message: msg };
    }
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
      // We intentionally use a larger cap because transient provider termination errors often
      // recover only after a few seconds.
      const backoffMs = Math.min(30_000, 1000 * 2 ** attempt);
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
}): {
  effectiveOptimalMaxTokens: number;
  optimalMaxTokensConfigured?: number;
  effectiveCriticalMaxTokens: number;
  criticalMaxTokensConfigured?: number;
} {
  const configuredOptimal =
    args.modelInfo &&
    typeof args.modelInfo.optimal_max_tokens === 'number' &&
    Number.isFinite(args.modelInfo.optimal_max_tokens)
      ? Math.floor(args.modelInfo.optimal_max_tokens)
      : undefined;

  const optimalMaxTokensConfigured =
    configuredOptimal !== undefined && configuredOptimal > 0 ? configuredOptimal : undefined;

  const configuredCritical =
    args.modelInfo &&
    typeof args.modelInfo.critical_max_tokens === 'number' &&
    Number.isFinite(args.modelInfo.critical_max_tokens)
      ? Math.floor(args.modelInfo.critical_max_tokens)
      : undefined;

  const criticalMaxTokensConfigured =
    configuredCritical !== undefined && configuredCritical > 0 ? configuredCritical : undefined;

  // Default threshold (when not configured): 100K.
  const defaultOptimal = 100_000;
  const effectiveOptimalMaxTokens =
    optimalMaxTokensConfigured !== undefined ? optimalMaxTokensConfigured : defaultOptimal;

  // Default threshold (when not configured): 90% of hard max.
  const defaultCritical = Math.max(1, Math.floor(args.modelContextLimitTokens * 0.9));
  const effectiveCriticalMaxTokens =
    criticalMaxTokensConfigured !== undefined ? criticalMaxTokensConfigured : defaultCritical;

  return {
    effectiveOptimalMaxTokens,
    optimalMaxTokensConfigured,
    effectiveCriticalMaxTokens,
    criticalMaxTokensConfigured,
  };
}

function computeContextHealthSnapshot(args: {
  providerCfg: ProviderConfig;
  model: string;
  usage: LlmUsageStats;
}): ContextHealthSnapshot {
  const modelInfo: ModelInfo | undefined = args.providerCfg.models[args.model];
  const modelContextWindowText =
    modelInfo && typeof modelInfo.context_window === 'string'
      ? modelInfo.context_window
      : undefined;
  const modelContextLimitTokens = resolveModelContextLimitTokens(modelInfo);
  if (modelContextLimitTokens === null) {
    return { kind: 'unavailable', reason: 'model_limit_unavailable', modelContextWindowText };
  }

  const {
    effectiveOptimalMaxTokens,
    optimalMaxTokensConfigured,
    effectiveCriticalMaxTokens,
    criticalMaxTokensConfigured,
  } = resolveEffectiveOptimalMaxTokens({
    modelInfo,
    modelContextLimitTokens,
  });

  if (args.usage.kind !== 'available') {
    return {
      kind: 'unavailable',
      reason: 'usage_unavailable',
      modelContextWindowText,
      modelContextLimitTokens,
      effectiveOptimalMaxTokens,
      optimalMaxTokensConfigured,
      effectiveCriticalMaxTokens,
      criticalMaxTokensConfigured,
    };
  }

  const hardUtil = args.usage.promptTokens / modelContextLimitTokens;
  const optimalUtil = args.usage.promptTokens / effectiveOptimalMaxTokens;

  const level: ContextHealthLevel =
    args.usage.promptTokens > effectiveCriticalMaxTokens
      ? 'critical'
      : args.usage.promptTokens > effectiveOptimalMaxTokens
        ? 'caution'
        : 'healthy';

  return {
    kind: 'available',
    promptTokens: args.usage.promptTokens,
    completionTokens: args.usage.completionTokens,
    totalTokens: args.usage.totalTokens,
    modelContextWindowText,
    modelContextLimitTokens,
    effectiveOptimalMaxTokens,
    optimalMaxTokensConfigured,
    effectiveCriticalMaxTokens,
    criticalMaxTokensConfigured,
    hardUtil,
    optimalUtil,
    level,
  };
}

type ContextHealthV3RuntimeState = {
  lastCautionGuideInjectedAtGenSeq?: number;
  lastSeenLevel?: ContextHealthLevel;
  criticalCountdownRemaining?: number;
};

const contextHealthV3StateByDialogKey: Map<string, ContextHealthV3RuntimeState> = new Map();

function getContextHealthV3State(dlg: Dialog): ContextHealthV3RuntimeState {
  const key = dlg.id.key();
  const existing = contextHealthV3StateByDialogKey.get(key);
  if (existing) return existing;
  const created: ContextHealthV3RuntimeState = {};
  contextHealthV3StateByDialogKey.set(key, created);
  return created;
}

function resetContextHealthV3State(dlg: Dialog): void {
  contextHealthV3StateByDialogKey.delete(dlg.id.key());
}

const defaultCautionHardCadenceGenerations = 10;
const defaultCriticalCountdownGenerations = 5;

function shouldInjectCautionRemediationGuide(args: {
  dlg: Dialog;
  providerCfg: ProviderConfig;
  model: string;
}): boolean {
  const { dlg } = args;
  const state = getContextHealthV3State(dlg);
  const modelInfo: ModelInfo | undefined = args.providerCfg.models[args.model];
  const cadence =
    modelInfo &&
    typeof modelInfo.caution_remediation_cadence_generations === 'number' &&
    Number.isFinite(modelInfo.caution_remediation_cadence_generations)
      ? Math.floor(modelInfo.caution_remediation_cadence_generations)
      : undefined;
  const effectiveCadence =
    typeof cadence === 'number' && Number.isFinite(cadence) && cadence > 0
      ? Math.floor(cadence)
      : defaultCautionHardCadenceGenerations;
  const genSeq = dlg.activeGenSeq;
  if (genSeq === undefined) return true;
  const lastInjected = state.lastCautionGuideInjectedAtGenSeq;
  if (lastInjected === undefined) return true;
  return genSeq - lastInjected >= effectiveCadence;
}

type ContextHealthV3RemediationOutcome =
  | { kind: 'proceed'; ctxMsgs: ChatMessage[] }
  | {
      kind: 'continue';
      nextPrompt: HumanPrompt | undefined;
      contextHealthForGen?: ContextHealthSnapshot;
    }
  | { kind: 'suspend'; contextHealthForGen?: ContextHealthSnapshot };

async function suspendForContextHealthCritical(dlg: Dialog): Promise<void> {
  const language = getWorkLanguage();
  const questionId = `q4h-${generateDialogID()}`;
  const question: HumanQuestion = {
    id: questionId,
    kind: 'context_health_critical',
    headLine: '@human',
    bodyContent:
      language === 'zh'
        ? [
            '上下文健康已进入 🔴 告急（critical），且 critical remediation 无法自动完成。',
            '',
            '为避免继续污染对话状态，系统已暂停该对话（suspended）。',
            '',
            '请人工介入：',
            '- 检查当前对话/系统提示是否存在冲突或工具不可用导致 agent 无法调用 clear_mind；',
            '- 修复后，再通过 UI 恢复/继续该对话（或手动触发 clear_mind）。',
          ].join('\n')
        : [
            'Context health is 🔴 critical, and critical remediation could not complete automatically.',
            '',
            'To avoid further state pollution, the dialog is now suspended.',
            '',
            'Please intervene:',
            '- Check whether the system prompt/tooling is preventing clear_mind calls;',
            '- Fix the issue, then resume the dialog in the UI (or manually trigger clear_mind).',
          ].join('\n'),
    askedAt: formatUnifiedTimestamp(new Date()),
    callSiteRef: {
      round: dlg.currentRound,
      messageIndex: dlg.msgs.length,
    },
  };

  const existingQuestions = await DialogPersistence.loadQuestions4HumanState(dlg.id);
  existingQuestions.push(question);
  await DialogPersistence._saveQuestions4HumanState(dlg.id, existingQuestions);

  const newQuestionEvent: NewQ4HAskedEvent = {
    type: 'new_q4h_asked',
    question: {
      id: question.id,
      kind: question.kind,
      selfId: dlg.id.selfId,
      headLine: question.headLine,
      bodyContent: question.bodyContent,
      askedAt: question.askedAt,
      callSiteRef: question.callSiteRef,
      rootId: dlg.id.rootId,
      agentId: dlg.agentId,
      taskDocPath: dlg.taskDocPath,
    },
  };
  postDialogEvent(dlg, newQuestionEvent);
}

async function applyContextHealthV3Remediation(args: {
  dlg: Dialog;
  agent: Team.Member;
  agentTools: Tool[];
  providerCfg: ProviderConfig;
  provider: string;
  systemPrompt: string;
  funcTools: FuncTool[];
  ctxMsgs: ChatMessage[];
  llmGen: NonNullable<ReturnType<typeof getLlmGenerator>>;
  abortSignal: AbortSignal;
  model: string;
  hadUserPromptThisGen: boolean;
}): Promise<ContextHealthV3RemediationOutcome> {
  const { dlg } = args;
  const snapshot = dlg.getLastContextHealth();
  if (!snapshot || snapshot.kind !== 'available') {
    resetContextHealthV3State(dlg);
    return { kind: 'proceed', ctxMsgs: args.ctxMsgs };
  }

  if (snapshot.level === 'healthy') {
    resetContextHealthV3State(dlg);
    return { kind: 'proceed', ctxMsgs: args.ctxMsgs };
  }

  if (snapshot.level === 'caution') {
    const state = getContextHealthV3State(dlg);
    if (state.lastSeenLevel !== 'caution') {
      state.lastSeenLevel = 'caution';
      state.criticalCountdownRemaining = undefined;
    }

    if (
      !shouldInjectCautionRemediationGuide({
        dlg,
        providerCfg: args.providerCfg,
        model: args.model,
      })
    ) {
      return { kind: 'proceed', ctxMsgs: args.ctxMsgs };
    }

    // Caution remediation at cadence (including the entry injection): require reminder curation
    // (no forced clear_mind).
    const activeGenSeq = dlg.activeGenSeqOrUndefined;
    if (activeGenSeq === undefined) {
      return { kind: 'proceed', ctxMsgs: args.ctxMsgs };
    }

    const guideText = formatUserFacingContextHealthV3RemediationGuide(getWorkLanguage(), {
      kind: 'caution',
      mode: 'soft',
    });

    state.lastCautionGuideInjectedAtGenSeq = activeGenSeq;

    // Prefer a recorded user prompt (visible in UI) when there isn't already a user prompt
    // in this generation.
    if (!args.hadUserPromptThisGen) {
      const msgId = generateShortId();
      const userLanguageCode = getWorkLanguage();
      const promptMsg: ChatMessage = {
        type: 'prompting_msg',
        role: 'user',
        genseq: activeGenSeq,
        msgId,
        grammar: 'markdown',
        content: guideText,
      };

      await dlg.addChatMessages(promptMsg);
      await dlg.persistUserMessage(guideText, msgId, 'markdown', userLanguageCode);
      await emitUserMarkdown(dlg, guideText);
      try {
        postDialogEvent(dlg, {
          type: 'end_of_user_saying_evt',
          round: dlg.currentRound,
          genseq: activeGenSeq,
          msgId,
          content: guideText,
          grammar: 'markdown',
          userLanguageCode,
        });
      } catch (err) {
        log.warn('Failed to emit end_of_user_saying_evt for caution guide prompt', err);
      }

      return { kind: 'proceed', ctxMsgs: [...args.ctxMsgs, promptMsg] };
    }

    // Fallback: still guide the LLM even if we cannot safely emit a second user prompt for UI.
    const guide: ChatMessage = { type: 'environment_msg', role: 'user', content: guideText };
    return { kind: 'proceed', ctxMsgs: [...args.ctxMsgs, guide] };
  }

  if (snapshot.level === 'critical') {
    const state = getContextHealthV3State(dlg);
    if (state.lastSeenLevel !== 'critical') {
      state.lastSeenLevel = 'critical';
      state.criticalCountdownRemaining = defaultCriticalCountdownGenerations;
    }

    const promptsBeforeAutoClear =
      typeof state.criticalCountdownRemaining === 'number' &&
      Number.isFinite(state.criticalCountdownRemaining)
        ? Math.floor(state.criticalCountdownRemaining)
        : defaultCriticalCountdownGenerations;

    if (promptsBeforeAutoClear <= 0) {
      // Countdown exhausted: force clear_mind automatically (no Q4H) to keep long-running
      // autonomy stable.
      const clearTool = args.agentTools.find(
        (t): t is FuncTool => t.type === 'func' && t.name === 'clear_mind',
      );
      if (!clearTool) {
        log.warn('clear_mind tool not found in agent tools during critical remediation', {
          dialogId: dlg.id.valueOf(),
        });
        // Keep countdown running even if tooling is misconfigured.
        await suspendForContextHealthCritical(dlg);
        return { kind: 'suspend' };
      }

      const funcId = `auto-clear-${generateDialogID()}`;
      const callGenseq = dlg.activeGenSeq;
      const toolArgs: ToolArguments = {};
      const argsStr = JSON.stringify(toolArgs);
      const funcCall: FuncCallMsg = {
        type: 'func_call_msg',
        role: 'assistant',
        genseq: callGenseq,
        id: funcId,
        name: 'clear_mind',
        arguments: argsStr,
      };

      try {
        await dlg.funcCallRequested(funcId, 'clear_mind', argsStr);
      } catch (err) {
        log.warn('Failed to emit func_call_requested for critical auto-clear clear_mind', err);
      }
      try {
        await dlg.persistFunctionCall(funcId, 'clear_mind', toolArgs, callGenseq);
      } catch (err) {
        log.warn('Failed to persist clear_mind function call for critical auto-clear', err);
      }

      let funcResult: FuncResultMsg;
      try {
        const content = await clearTool.call(dlg, args.agent, toolArgs);
        funcResult = {
          type: 'func_result_msg',
          id: funcId,
          name: 'clear_mind',
          content: String(content),
          role: 'tool',
          genseq: callGenseq,
        };
      } catch (err) {
        funcResult = {
          type: 'func_result_msg',
          id: funcId,
          name: 'clear_mind',
          content: `Function 'clear_mind' execution failed: ${showErrorToAi(err)}`,
          role: 'tool',
          genseq: callGenseq,
        };
      }

      await dlg.receiveFuncResult(funcResult);
      await dlg.addChatMessages(funcCall, funcResult);

      resetContextHealthV3State(dlg);
      const nextPrompt = resolveUpNextPrompt(dlg);
      return { kind: 'continue', nextPrompt };
    }

    const guideText = formatUserFacingContextHealthV3RemediationGuide(getWorkLanguage(), {
      kind: 'critical',
      mode: 'countdown',
      promptsRemainingAfterThis: promptsBeforeAutoClear - 1,
      promptsTotal: defaultCriticalCountdownGenerations,
    });

    state.criticalCountdownRemaining = promptsBeforeAutoClear - 1;

    // Prefer a recorded prompt (visible in UI as user prompt) when there isn't already a
    // user prompt in this generation.
    if (!args.hadUserPromptThisGen) {
      const msgId = generateShortId();
      const userLanguageCode = getWorkLanguage();
      const promptMsg: ChatMessage = {
        type: 'prompting_msg',
        role: 'user',
        genseq: dlg.activeGenSeq,
        msgId,
        grammar: 'markdown',
        content: guideText,
      };

      await dlg.addChatMessages(promptMsg);
      await dlg.persistUserMessage(guideText, msgId, 'markdown', userLanguageCode);
      await emitUserMarkdown(dlg, guideText);
      try {
        postDialogEvent(dlg, {
          type: 'end_of_user_saying_evt',
          round: dlg.currentRound,
          genseq: dlg.activeGenSeq,
          msgId,
          content: guideText,
          grammar: 'markdown',
          userLanguageCode,
        });
      } catch (err) {
        log.warn('Failed to emit end_of_user_saying_evt for critical countdown prompt', err);
      }

      return { kind: 'proceed', ctxMsgs: [...args.ctxMsgs, promptMsg] };
    }

    // Fallback: still guide the LLM even if we cannot safely emit a second user prompt for UI.
    const guide: ChatMessage = {
      type: 'environment_msg',
      role: 'user',
      content: guideText,
    };
    return { kind: 'proceed', ctxMsgs: [...args.ctxMsgs, guide] };
  }

  const _exhaustive: never = snapshot.level;
  return _exhaustive;
}

// === UNIFIED STREAMING HANDLERS ===

/**
 * Create a TellaskEventsReceiver for unified saying event emission.
 * Handles tellask call blocks and markdown using TellaskStreamParser.
 * Used by both streaming and non-streaming modes.
 */
export function createSayingEventsReceiver(dlg: Dialog): TellaskEventsReceiver {
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
    callStart: async (validation) => {
      await dlg.callingStart(validation);
    },
    callHeadLineChunk: async (chunk: string) => {
      await dlg.callingHeadlineChunk(chunk);
    },
    callHeadLineFinish: async () => {
      await dlg.callingHeadlineFinish();
    },
    callBodyStart: async () => {
      await dlg.callingBodyStart();
    },
    callBodyChunk: async (chunk: string) => {
      await dlg.callingBodyChunk(chunk);
    },
    callBodyFinish: async () => {
      await dlg.callingBodyFinish();
    },
    callFinish: async (callId: string) => {
      await dlg.callingFinish(callId);
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
 * Emit saying events using TellaskStreamParser (non-streaming mode).
 * Processes the entire content at once, handling markdown + tellask calls.
 */
export async function emitSayingEvents(
  dlg: Dialog,
  content: string,
): Promise<CollectedTellaskCall[]> {
  if (!content.trim()) return [];

  const receiver = createSayingEventsReceiver(dlg);
  const parser = new TellaskStreamParser(receiver);
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
 * Phase 3 - User Tool Calls Collection & Execution:
 *   - Parse user text for tellask blocks using TellaskStreamParser
 *   - Execute tellasks (teammate tellasks / Q4H / supdialog)
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
 * Phase 6 - Function/Tellask Call Execution:
 *   - Execute function calls (non-streaming mode)
 *   - Execute tellask calls (streaming mode)
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
  let pendingPrompt: HumanPrompt | undefined = humanPrompt;
  try {
    while (true) {
      genIterNo++;
      throwIfAborted(abortSignal, dlg.id);

      // reload the agent's minds from disk every round, in case the disk files changed by human or ai meanwhile
      const { team, agent, systemPrompt, memories, agentTools } = await loadAgentMinds(
        dlg.agentId,
        dlg,
      );

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
      let llmGenModelForGen: string = model;

      try {
        throwIfAborted(abortSignal, dlg.id);
        await dlg.notifyGeneratingStart();

        const currentPrompt = pendingPrompt;
        pendingPrompt = undefined;
        if (currentPrompt) {
          promptContent = currentPrompt.content;
          const msgId = currentPrompt.msgId;
          const promptGrammar = currentPrompt.grammar;
          const persistedUserLanguageCode =
            currentPrompt.userLanguageCode ?? dlg.getLastUserLanguageCode();

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

          if (promptGrammar === 'tellask') {
            // Collect and execute tellask calls from user text using streaming parser
            throwIfAborted(abortSignal, dlg.id);
            const collectedUserCalls = await emitSayingEvents(dlg, promptContent);
            throwIfAborted(abortSignal, dlg.id);
            const userResult = await executeTellaskCalls(dlg, agent, collectedUserCalls);

            if (dlg.hasUpNext()) {
              return lastAssistantSayingContent;
            }

            if (userResult.toolOutputs.length > 0) {
              await dlg.addChatMessages(...userResult.toolOutputs);
            }
            if (userResult.suspend) {
              suspendForHuman = true;
            }

            // No teammate-call fallback here: rely exclusively on TellaskStreamParser.

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
          ? await formatTaskDocContent(dlg)
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
                    type: 'environment_msg',
                    role: 'user',
                    content: formatReminderItemGuide(
                      getWorkLanguage(),
                      index + 1,
                      reminder.content,
                    ),
                  };
                }),
              )
            : [];

        if (renderedReminders.length > 0) {
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
            ctxMsgs.splice(insertIndex, 0, ...renderedReminders);
          } else {
            ctxMsgs.push(...renderedReminders);
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

        const remediation = await applyContextHealthV3Remediation({
          dlg,
          agent,
          agentTools,
          providerCfg,
          provider,
          systemPrompt,
          funcTools,
          ctxMsgs,
          llmGen,
          abortSignal,
          model,
          hadUserPromptThisGen: currentPrompt !== undefined,
        });
        if (remediation.kind === 'continue') {
          if (remediation.contextHealthForGen) {
            contextHealthForGen = remediation.contextHealthForGen;
          }
          pendingPrompt = remediation.nextPrompt;
          continue;
        }
        if (remediation.kind === 'suspend') {
          if (remediation.contextHealthForGen) {
            contextHealthForGen = remediation.contextHealthForGen;
          }
          suspendForHuman = true;
          break;
        }
        const ctxMsgsForGen = remediation.ctxMsgs;

        if (agent.streaming === false) {
          let nonStreamResult: {
            messages: ChatMessage[];
            usage: LlmUsageStats;
            llmGenModel?: string;
          };
          try {
            throwIfAborted(abortSignal, dlg.id);
            nonStreamResult = await runLlmRequestWithRetry({
              dlg,
              provider,
              abortSignal,
              maxRetries: 5,
              canRetry: () => true,
              doRequest: async () => {
                return await llmGen.genMoreMessages(
                  providerCfg,
                  agent,
                  systemPrompt,
                  funcTools,
                  ctxMsgsForGen,
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

          if (
            typeof nonStreamResult.llmGenModel === 'string' &&
            nonStreamResult.llmGenModel.trim() !== ''
          ) {
            llmGenModelForGen = nonStreamResult.llmGenModel.trim();
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

          const nonStreamMsgs = nonStreamResult.messages;
          const assistantMsgs = nonStreamMsgs.filter(
            (m): m is SayingMsg | ThinkingMsg =>
              m.type === 'saying_msg' || m.type === 'thinking_msg',
          );
          const collectedAssistantCalls: CollectedTellaskCall[] = [];

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

                // Emit saying events using shared TellaskStreamParser integration
                if (msg.type === 'saying_msg') {
                  const calls = await emitSayingEvents(dlg, msg.content);
                  collectedAssistantCalls.push(...calls);
                }
              }
            }
          }

          let assistantToolOutputsCount = 0;
          if (collectedAssistantCalls.length > 0) {
            throwIfAborted(abortSignal, dlg.id);
            const assistantResult = await executeTellaskCalls(dlg, agent, collectedAssistantCalls);
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

          if (dlg.hasUpNext()) {
            pendingPrompt = resolveUpNextPrompt(dlg);
            continue;
          }

          if (suspendForHuman) {
            try {
              // Q4H suspension resets keep-going budget so post-Q4H continuation gets a fresh counter.
              if (await dlg.hasPendingQ4H()) {
                dlg.diligenceAutoContinueCount = 0;
              }
            } catch (err) {
              log.warn('Failed to check Q4H state for keep-going reset', err, {
                dialogId: dlg.id.valueOf(),
              });
            }
            break;
          }

          // Continue when there is any tool output / function output that requires another iteration.
          const shouldContinue =
            funcCalls.length > 0 ||
            assistantToolOutputsCount > 0 ||
            (funcResults.length > 0 && funcCalls.length === 0);
          if (!shouldContinue) {
            // Keep-going (root dialog only): prevent ALL stopping except legitimate suspension.
            // If disabled (empty diligence file) or budget exhausted, we suspend via Q4H.
            if (dlg instanceof RootDialog) {
              const suspension = await dlg.getSuspensionStatus();
              if (!suspension.canDrive) {
                if (suspension.q4h) {
                  dlg.diligenceAutoContinueCount = 0;
                }
                break;
              }

              const prepared = await maybePrepareDiligenceAutoContinuePrompt({
                dlg,
                isRootDialog: true,
                alreadyInjectedCount: dlg.diligenceAutoContinueCount,
                diligencePushMax: resolveMemberDiligencePushMax(team, dlg.agentId),
              });
              dlg.diligenceAutoContinueCount = prepared.nextInjectedCount;
              if (prepared.kind !== 'disabled') {
                postDialogEvent(dlg, {
                  type: 'diligence_budget_evt',
                  maxInjectCount: prepared.maxInjectCount,
                  injectedCount: prepared.nextInjectedCount,
                  remainingCount: Math.max(0, prepared.maxInjectCount - prepared.nextInjectedCount),
                  disableDiligencePush: dlg.disableDiligencePush,
                });
              }
              if (prepared.kind === 'budget_exhausted') {
                await suspendForKeepGoingBudgetExhausted({
                  dlg,
                  maxInjectCount: prepared.maxInjectCount,
                });
                dlg.diligenceAutoContinueCount = 0;
                break;
              }
              if (prepared.kind === 'prompt') {
                pendingPrompt = prepared.prompt;
                continue;
              }
            }
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

          // Create receiver using shared helper (unified TellaskStreamParser integration)
          const receiver = createSayingEventsReceiver(dlg);

          // Direct streaming parser that forwards events without state tracking
          const parser = new TellaskStreamParser(receiver);

          let streamResult: { usage: LlmUsageStats; llmGenModel?: string } | undefined;
          try {
            streamResult = await runLlmRequestWithRetry({
              dlg,
              provider,
              abortSignal,
              maxRetries: 5,
              canRetry: () => !sawAnyStreamContent,
              doRequest: async () => {
                return await llmGen.genToReceiver(
                  providerCfg,
                  agent,
                  systemPrompt,
                  funcTools,
                  ctxMsgsForGen,
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
          if (
            typeof streamResult.llmGenModel === 'string' &&
            streamResult.llmGenModel.trim() !== ''
          ) {
            llmGenModelForGen = streamResult.llmGenModel.trim();
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

          // Execute collected calls concurrently after streaming completes
          const collectedCalls = parser.getCollectedCalls();
          const malformedToolOutputs = await emitMalformedTellaskResponses(dlg, collectedCalls);

          if (collectedCalls.length > 0 && !collectedCalls[0].callId) {
            throw new Error(
              'Collected calls missing callId - parser should have allocated one per call',
            );
          }

          const validCalls = collectedCalls.filter(
            (
              call,
            ): call is CollectedTellaskCall & {
              validation: { kind: 'valid'; firstMention: string };
            } => call.validation.kind === 'valid',
          );

          throwIfAborted(abortSignal, dlg.id);
          const results = await Promise.all(
            validCalls.map((call) =>
              executeTellaskCall(
                dlg,
                agent,
                call.validation.firstMention,
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
          if (malformedToolOutputs.length > 0) {
            toolOutputsCount += malformedToolOutputs.length;
            newMsgs.push(...malformedToolOutputs);
          }
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

          if (dlg.hasUpNext()) {
            pendingPrompt = resolveUpNextPrompt(dlg);
            continue;
          }

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
            try {
              // Q4H suspension resets keep-going budget so post-Q4H continuation gets a fresh counter.
              if (await dlg.hasPendingQ4H()) {
                dlg.diligenceAutoContinueCount = 0;
              }
            } catch (err) {
              log.warn('Failed to check Q4H state for keep-going reset', err, {
                dialogId: dlg.id.valueOf(),
              });
            }
            break;
          }

          const shouldContinue =
            toolOutputsCount > 0 || streamedFuncCalls.length > 0 || funcResults.length > 0;
          if (!shouldContinue) {
            // Keep-going (root dialog only): prevent ALL stopping except legitimate suspension.
            if (dlg instanceof RootDialog) {
              const suspension = await dlg.getSuspensionStatus();
              if (!suspension.canDrive) {
                if (suspension.q4h) {
                  dlg.diligenceAutoContinueCount = 0;
                }
                break;
              }

              const prepared = await maybePrepareDiligenceAutoContinuePrompt({
                dlg,
                isRootDialog: true,
                alreadyInjectedCount: dlg.diligenceAutoContinueCount,
                diligencePushMax: resolveMemberDiligencePushMax(team, dlg.agentId),
              });
              dlg.diligenceAutoContinueCount = prepared.nextInjectedCount;
              if (prepared.kind === 'budget_exhausted') {
                await suspendForKeepGoingBudgetExhausted({
                  dlg,
                  maxInjectCount: prepared.maxInjectCount,
                });
                dlg.diligenceAutoContinueCount = 0;
                break;
              }
              if (prepared.kind === 'prompt') {
                pendingPrompt = prepared.prompt;
                continue;
              }
            }
            break;
          }
        }
      } finally {
        await dlg.notifyGeneratingFinish(contextHealthForGen, llmGenModelForGen);
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

// === TEAMMATE TELLASK TYPE SYSTEM (Phase 5) ===
// === PHASE 11 EXTENSION: Type A for subdialog calling its DIRECT parent (supdialog) ===

/**
 * Result of parsing a teammate tellask pattern.
 * Three types based on the tellask headline syntax:
 * - Type A: @<supdialogAgentId> - subdialog calling its direct parent (supdialog suspension)
 * - Type B: @<agentId> !tellaskSession <tellaskSession> - creates/resumes registered subdialog
 * - Type C: @<agentId> - creates transient unregistered subdialog
 */
export type TeammateTellaskParseResult =
  | TeammateTellaskTypeA
  | TeammateTellaskTypeB
  | TeammateTellaskTypeC;

/**
 * Type A: Supdialog suspension call.
 * Syntax: @<supdialogAgentId> (when subdialog calls its direct parent)
 * Suspends the subdialog, drives the supdialog for one round, returns response to subdialog.
 * Only triggered when the @agentId matches the current dialog's supdialog.agentId.
 */
export interface TeammateTellaskTypeA {
  type: 'A';
  agentId: string;
}

/**
 * Type B: Registered subdialog call with tellaskSession.
 * Syntax: @<agentId> !tellaskSession <tellaskSession>
 * Creates or resumes a registered subdialog, tracked in registry.yaml.
 */
export interface TeammateTellaskTypeB {
  type: 'B';
  agentId: string;
  tellaskSession: string;
}

/**
 * Type C: Transient subdialog call (unregistered).
 * Syntax: @<agentId> (without !tellaskSession)
 * Creates a one-off subdialog that moves to done/ on completion.
 */
export interface TeammateTellaskTypeC {
  type: 'C';
  agentId: string;
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

function parseTellaskSessionDirectiveFromHeadline(headLine: string): TellaskSessionDirectiveParse {
  const re = /(^|\s)!tellaskSession\s+([^\s]+)/g;
  const ids: string[] = [];
  for (const match of headLine.matchAll(re)) {
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

function extractSingleTellaskSessionFromHeadline(headLine: string): string | null {
  const parsed = parseTellaskSessionDirectiveFromHeadline(headLine);
  if (parsed.kind === 'one') return parsed.tellaskSession;
  return null;
}

/**
 * Parse a teammate tellask pattern and return the appropriate type result.
 *
 * Patterns:
 * - @<supdialogAgentId> (in subdialog context, matching supdialog.agentId) → Type A (supdialog suspension)
 * - @<agentId> !tellaskSession <tellaskSession> → Type B (registered subdialog)
 * - @<agentId> → Type C (transient subdialog)
 *
 * @param firstMention The first teammate mention extracted by the streaming parser (e.g., "teammate")
 * @param headLine The full headline text from the streaming parser
 * @param currentDialog Optional current dialog context to detect Type A (subdialog calling parent)
 * @returns The parsed TeammateTellaskParseResult
 */
export function parseTeammateTellask(
  firstMention: string,
  headLine: string,
  currentDialog?: Dialog,
): TeammateTellaskParseResult {
  // Fresh Boots Reasoning (FBR) syntax sugar:
  // `@self` always targets the current dialog's agentId (same persona/config).
  //
  // This avoids ambiguous `@teammate`-to-`@teammate` self-calls which can also be produced accidentally
  // by echoing/quoting an assignment headline. We keep parsing behavior the same for all other
  // mentions.
  if (firstMention === 'self') {
    const agentId = currentDialog?.agentId ?? 'self';
    const tellaskSession = extractSingleTellaskSessionFromHeadline(headLine);
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

  const tellaskSession = extractSingleTellaskSessionFromHeadline(headLine);
  if (tellaskSession) {
    return {
      type: 'B',
      agentId: firstMention,
      tellaskSession,
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
      collectiveTargets: [targetAgentId],
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
            collectiveTargets: [targetAgentId],
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
 * Type B: @<agentId> !tellaskSession <tellaskSession> - Creates/resumes registered subdialog.
 *
 * @param rootDialog The root dialog making the call
 * @param agentId The agent to handle the subdialog
 * @param tellaskSession The tellask session key for registry lookup
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
 * Collect tellask calls using the streaming parser, then execute them
 */
async function executeTellaskCalls(
  dlg: Dialog,
  agent: Team.Member,
  collectedCalls: CollectedTellaskCall[],
): Promise<{ suspend: boolean; toolOutputs: ChatMessage[]; subdialogsCreated: DialogID[] }> {
  const malformedToolOutputs = await emitMalformedTellaskResponses(dlg, collectedCalls);

  const validCalls = collectedCalls.filter(
    (
      call,
    ): call is CollectedTellaskCall & { validation: { kind: 'valid'; firstMention: string } } =>
      call.validation.kind === 'valid',
  );

  // Execute collected calls concurrently
  const results = await Promise.all(
    validCalls.map((call) =>
      executeTellaskCall(
        dlg,
        agent,
        call.validation.firstMention,
        call.headLine,
        call.body,
        call.callId,
      ),
    ),
  );

  // Combine results from all concurrent calls
  const suspend = results.some((result) => result.suspend);
  const toolOutputs = [...malformedToolOutputs, ...results.flatMap((result) => result.toolOutputs)];
  const subdialogsCreated = results.flatMap((result) => result.subdialogsCreated);

  return { suspend, toolOutputs, subdialogsCreated };
}

async function emitMalformedTellaskResponses(
  dlg: Dialog,
  collectedCalls: CollectedTellaskCall[],
): Promise<ChatMessage[]> {
  const toolOutputs: ChatMessage[] = [];
  const language = getWorkLanguage();
  for (const call of collectedCalls) {
    if (call.validation.kind !== 'malformed') continue;
    const firstLineAfterPrefix = (call.headLine.split('\n')[0] ?? '').trim();
    const msg = formatDomindsNoteMalformedTellaskCall(language, call.validation.reason, {
      firstLineAfterPrefix,
    });

    toolOutputs.push({
      type: 'environment_msg',
      role: 'user',
      content: msg,
    });
    toolOutputs.push({
      type: 'call_result_msg',
      role: 'tool',
      responderId: 'dominds',
      headLine: call.headLine,
      status: 'failed',
      content: msg,
    });

    await dlg.receiveToolResponse('dominds', call.headLine, msg, 'failed', call.callId);
    dlg.clearCurrentCallId();
  }
  return toolOutputs;
}

/**
 * Execute a single tellask call using Phase 5 3-Type Taxonomy.
 * Handles Type A (supdialog suspension), Type B (registered subdialog), and Type C (transient subdialog).
 */
async function executeTellaskCall(
  dlg: Dialog,
  agent: Team.Member,
  firstMention: string,
  headLine: string,
  body: string,
  callId: string,
  options?: {
    allowMultiTeammateTargets?: boolean;
    collectiveTargets?: string[];
    skipTellaskSessionDirectiveValidation?: boolean;
  },
): Promise<{
  toolOutputs: ChatMessage[];
  suspend: boolean;
  subdialogsCreated: DialogID[];
}> {
  const toolOutputs: ChatMessage[] = [];
  let suspend = false;
  const subdialogsCreated: DialogID[] = [];

  const team = await Team.load();
  const isSelfAlias = firstMention === 'self';
  const isSuperAlias = firstMention === 'super';
  const member = isSelfAlias ? team.getMember(dlg.agentId) : team.getMember(firstMention);

  // Multi-teammate fan-out (collective teammate tellask):
  // A single tellask block can target multiple teammates by including multiple teammate mentions
  // anywhere inside the (possibly multiline) headline. The full headline/body is passed verbatim
  // to each target so each subdialog can see this is a collective assignment.
  const allowMultiTeammateTargets = options?.allowMultiTeammateTargets ?? true;
  if (allowMultiTeammateTargets && member && !isSelfAlias && !isSuperAlias) {
    const mentioned = extractMentionIdsFromHeadline(headLine);
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
          id !== 'super' &&
          id !== 'human' &&
          id !== 'dominds',
      );
      if (unknown.length > 0) {
        const msg = formatDomindsNoteInvalidMultiTeammateTargets(getWorkLanguage(), { unknown });
        toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
        toolOutputs.push({
          type: 'call_result_msg',
          role: 'tool',
          responderId: 'dominds',
          headLine,
          status: 'failed',
          content: msg,
        });
        await dlg.receiveToolResponse('dominds', headLine, msg, 'failed', callId);
        dlg.clearCurrentCallId();
        return { toolOutputs, suspend: false, subdialogsCreated: [] };
      }

      if (options?.skipTellaskSessionDirectiveValidation !== true) {
        const tellaskSessionDirective = parseTellaskSessionDirectiveFromHeadline(headLine);
        if (tellaskSessionDirective.kind === 'multiple') {
          const msg = formatDomindsNoteMultipleTellaskSessionDirectives(getWorkLanguage());
          toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
          toolOutputs.push({
            type: 'call_result_msg',
            role: 'tool',
            responderId: 'dominds',
            headLine,
            status: 'failed',
            content: msg,
          });
          await dlg.receiveToolResponse('dominds', headLine, msg, 'failed', callId);
          dlg.clearCurrentCallId();
          return { toolOutputs, suspend: false, subdialogsCreated: [] };
        }
        if (tellaskSessionDirective.kind === 'invalid') {
          const msg = formatDomindsNoteInvalidTellaskSessionDirective(getWorkLanguage());
          toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
          toolOutputs.push({
            type: 'call_result_msg',
            role: 'tool',
            responderId: 'dominds',
            headLine,
            status: 'failed',
            content: msg,
          });
          await dlg.receiveToolResponse('dominds', headLine, msg, 'failed', callId);
          dlg.clearCurrentCallId();
          return { toolOutputs, suspend: false, subdialogsCreated: [] };
        }
      }

      const perTargetResults = await Promise.all(
        knownTargets.map(async (targetId) => {
          return await executeTellaskCall(dlg, agent, targetId, headLine, body, callId, {
            allowMultiTeammateTargets: false,
            collectiveTargets: knownTargets,
            skipTellaskSessionDirectiveValidation: true,
          });
        }),
      );

      return {
        toolOutputs: perTargetResults.flatMap((r) => r.toolOutputs),
        suspend: perTargetResults.some((r) => r.suspend),
        subdialogsCreated: perTargetResults.flatMap((r) => r.subdialogsCreated),
      };
    }
  }

  // === Q4H: Handle @human teammate tellasks (Questions for Human) ===
  // Q4H works for both user-initiated and assistant-initiated @human calls
  const isQ4H = firstMention === 'human';
  if (isQ4H) {
    try {
      // Create HumanQuestion entry
      const questionId = `q4h-${generateDialogID()}`;
      const question: HumanQuestion = {
        id: questionId,
        kind: 'generic',
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
          kind: question.kind,
          selfId: dlg.id.selfId,
          headLine: question.headLine,
          bodyContent: question.bodyContent,
          askedAt: question.askedAt,
          callSiteRef: question.callSiteRef,
          rootId: dlg.id.rootId,
          agentId: dlg.agentId,
          taskDocPath: dlg.taskDocPath,
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
    // This is a teammate tellask - parse using Phase 5 taxonomy (Type A/B/C).
    if (isSuperAlias && !(dlg instanceof SubDialog)) {
      const response = formatDomindsNoteSuperOnlyInSubdialog(getWorkLanguage());
      try {
        await dlg.receiveTeammateResponse('dominds', headLine, 'failed', dlg.id, {
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

    if (options?.skipTellaskSessionDirectiveValidation !== true) {
      const tellaskSessionDirective = parseTellaskSessionDirectiveFromHeadline(headLine);

      if (isSuperAlias && tellaskSessionDirective.kind !== 'none') {
        const response = formatDomindsNoteSuperNoTellaskSession(getWorkLanguage());
        try {
          await dlg.receiveTeammateResponse('dominds', headLine, 'failed', dlg.id, {
            response,
            agentId: 'dominds',
            callId,
            originMemberId: dlg.agentId,
          });
        } catch (err) {
          log.warn('Failed to emit @super !tellaskSession syntax error response', err, {
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
          type: 'call_result_msg',
          role: 'tool',
          responderId: 'dominds',
          headLine,
          status: 'failed',
          content: msg,
        });
        await dlg.receiveToolResponse('dominds', headLine, msg, 'failed', callId);
        dlg.clearCurrentCallId();
        return { toolOutputs, suspend: false, subdialogsCreated: [] };
      }
      if (tellaskSessionDirective.kind === 'invalid') {
        const msg = formatDomindsNoteInvalidTellaskSessionDirective(getWorkLanguage());
        toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
        toolOutputs.push({
          type: 'call_result_msg',
          role: 'tool',
          responderId: 'dominds',
          headLine,
          status: 'failed',
          content: msg,
        });
        await dlg.receiveToolResponse('dominds', headLine, msg, 'failed', callId);
        dlg.clearCurrentCallId();
        return { toolOutputs, suspend: false, subdialogsCreated: [] };
      }
    }

    const parseResult: TeammateTellaskParseResult = isSuperAlias
      ? { type: 'A', agentId: (dlg as SubDialog).supdialog.agentId }
      : parseTeammateTellask(firstMention, headLine, dlg);

    // If the agent calls itself via `@<agentId>` (instead of `@self`), allow it to proceed
    // (self-calls are useful for FBR), but emit a correction bubble so the user can distinguish
    // intentional self-FBR from accidental echo/quote triggers.
    const isDirectSelfCall = !isSelfAlias && !isSuperAlias && parseResult.agentId === dlg.agentId;
    if (isDirectSelfCall) {
      const response = formatDomindsNoteDirectSelfCall(getWorkLanguage());
      try {
        await dlg.receiveTeammateResponse('dominds', headLine, 'completed', dlg.id, {
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

          const resultMsg: TellaskCallResultMsg = {
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
          const resultMsg: TellaskCallResultMsg = {
            type: 'call_result_msg',
            role: 'tool',
            responderId: parseResult.agentId,
            headLine,
            status: 'failed',
            content: errorText,
          };
          toolOutputs.push(resultMsg);
          await dlg.receiveTeammateResponse(parseResult.agentId, headLine, 'failed', supdialog.id, {
            response: errorText,
            agentId: parseResult.agentId,
            callId,
            originMemberId: dlg.agentId,
          });
        }
      } else {
        log.warn('Type A call on dialog without supdialog, falling back to Type C', {
          dialogId: dlg.id.selfId,
        });
        // Fall through to Type C handling
      }
    } else if (parseResult.type === 'B') {
      // Type B: Registered subdialog with tellaskSession (root registry, caller can be root or subdialog)
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
            tellaskSession: parseResult.tellaskSession,
            collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
          });

          const pendingRecord: PendingSubdialogRecordType = {
            subdialogId: sub.id.selfId,
            createdAt: formatUnifiedTimestamp(new Date()),
            headLine,
            targetAgentId: parseResult.agentId,
            callType: 'C',
            tellaskSession: parseResult.tellaskSession,
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
                  collectiveTargets: options?.collectiveTargets ?? [sub.agentId],
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
          collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
        };

        const existingSubdialog = rootDialog.lookupSubdialog(
          parseResult.agentId,
          parseResult.tellaskSession,
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
              collectiveTargets: options?.collectiveTargets ?? [existingSubdialog.agentId],
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
            tellaskSession: parseResult.tellaskSession,
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
            tellaskSession: parseResult.tellaskSession,
            collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
          });
          rootDialog.registerSubdialog(sub);
          await rootDialog.saveSubdialogRegistry();

          const pendingRecord: PendingSubdialogRecordType = {
            subdialogId: sub.id.selfId,
            createdAt: formatUnifiedTimestamp(new Date()),
            headLine,
            targetAgentId: parseResult.agentId,
            callType: 'B',
            tellaskSession: parseResult.tellaskSession,
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
                  collectiveTargets: options?.collectiveTargets ?? [sub.agentId],
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
      try {
        const sub = await dlg.createSubDialog(parseResult.agentId, headLine, body, {
          originMemberId: dlg.agentId,
          callerDialogId: dlg.id.selfId,
          callId,
          collectiveTargets: options?.collectiveTargets ?? [parseResult.agentId],
        });
        const pendingRecord: PendingSubdialogRecordType = {
          subdialogId: sub.id.selfId,
          createdAt: formatUnifiedTimestamp(new Date()),
          headLine,
          targetAgentId: parseResult.agentId,
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
                collectiveTargets: options?.collectiveTargets ?? [sub.agentId],
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
        suspend = true;
      } catch (err) {
        log.warn('Subdialog creation error:', err);
      }
    }
  } else {
    // Not a team member: tellask is reserved for teammate tellasks.
    // All tools (including dialog control tools) must use native function-calling.
    const msg = formatDomindsNoteTellaskForTeammatesOnly(getWorkLanguage(), { firstMention });
    toolOutputs.push({ type: 'environment_msg', role: 'user', content: msg });
    toolOutputs.push({
      type: 'call_result_msg',
      role: 'tool',
      responderId: 'dominds',
      headLine,
      status: 'failed',
      content: msg,
    });
    await dlg.receiveToolResponse('dominds', headLine, msg, 'failed', callId);
    dlg.clearCurrentCallId();
  }

  return { toolOutputs, suspend, subdialogsCreated };
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

function extractMentionIdsFromHeadline(headLine: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < headLine.length; i++) {
    const ch = headLine[i] ?? '';
    if (ch !== '@') continue;
    const prev = i === 0 ? '' : (headLine[i - 1] ?? '');
    if (!isMentionBoundaryChar(prev)) continue;

    let j = i + 1;
    let raw = '';
    while (j < headLine.length) {
      const c = headLine[j] ?? '';
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
