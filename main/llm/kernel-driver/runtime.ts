import * as fs from 'fs';
import * as path from 'path';

import { DILIGENCE_FALLBACK_TEXT } from '@longrun-ai/kernel/diligence';
import type {
  DialogDisplayTextI18n,
  DialogLlmRetryExhaustedReason,
  DialogLlmRetryRecoveryAction,
  DialogRetryDisplay,
} from '@longrun-ai/kernel/types/display-state';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { generateShortId } from '@longrun-ai/kernel/utils/id';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { Dialog } from '../../dialog';
import { postDialogEvent } from '../../evt-registry';
import { extractErrorDetails, log } from '../../log';
import { removeProblem, upsertProblem } from '../../problems';
import {
  formatDiligenceAutoContinuePrompt,
  formatQ4HDiligencePushBudgetExhausted,
} from '../../runtime/driver-messages';
import { getWorkLanguage } from '../../runtime/work-language';
import type { FuncTool, ToolArguments } from '../../tool';
import { validateArgs } from '../../tool';
import {
  createLlmFailureQuirkHandlerSession,
  type LlmFailureKind,
  type LlmFailureQuirkHandlerSession,
  type LlmQuirkFailureHandling,
} from '../api-quirks';
import type { ProviderConfig } from '../client';
import {
  LlmStreamErrorEmittedError,
  type LlmFailureClassifier,
  type LlmFailureDisposition,
  type LlmRetryStrategy,
} from '../gen';
import { buildHumanSystemStopReasonTextI18n } from '../stop-reason-i18n';
import type { KernelDriverHumanPrompt } from './types';

export class LlmRetryStoppedError extends Error {
  public readonly reason: DialogLlmRetryExhaustedReason;

  constructor(reason: DialogLlmRetryExhaustedReason, message: string) {
    super(message);
    this.name = 'LlmRetryStoppedError';
    this.reason = reason;
  }
}

export class LlmRequestFailedError extends Error {
  public readonly detail: string;
  public readonly streamErrorEmitted: boolean;
  public readonly i18nStopReason?: DialogDisplayTextI18n;

  constructor(args: {
    message: string;
    detail: string;
    streamErrorEmitted: boolean;
    i18nStopReason?: DialogDisplayTextI18n;
  }) {
    super(args.message);
    this.name = 'LlmRequestFailedError';
    this.detail = args.detail;
    this.streamErrorEmitted = args.streamErrorEmitted;
    this.i18nStopReason = args.i18nStopReason;
  }
}

function isNodeErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function stripMarkdownFrontmatter(raw: string): string {
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return match ? (match[1] ?? '') : raw;
}

type RtwsDiligenceResolution =
  | { kind: 'disabled'; reason: 'empty_file' | 'empty_body' }
  | { kind: 'enabled'; diligenceText: string };

async function resolveRtwsDiligenceConfig(): Promise<RtwsDiligenceResolution> {
  const workLanguage = getWorkLanguage();
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

  return {
    kind: 'enabled',
    diligenceText: DILIGENCE_FALLBACK_TEXT[workLanguage],
  };
}

export async function maybePrepareDiligenceAutoContinuePrompt(options: {
  dlg: Dialog;
  isRootDialog: boolean;
  remainingBudget: number;
  diligencePushMax: number;
  suppressDiligencePush?: boolean;
}): Promise<
  | { kind: 'disabled'; nextRemainingBudget: number }
  | { kind: 'budget_exhausted'; maxInjectCount: number; nextRemainingBudget: number }
  | {
      kind: 'prompt';
      prompt: KernelDriverHumanPrompt;
      maxInjectCount: number;
      nextRemainingBudget: number;
    }
> {
  if (!options.isRootDialog) {
    return { kind: 'disabled', nextRemainingBudget: options.remainingBudget };
  }

  if (options.dlg.disableDiligencePush || options.suppressDiligencePush === true) {
    const normalizedRemaining =
      typeof options.remainingBudget === 'number' && Number.isFinite(options.remainingBudget)
        ? Math.max(0, Math.floor(options.remainingBudget))
        : 0;
    return { kind: 'disabled', nextRemainingBudget: normalizedRemaining };
  }

  const resolved = await resolveRtwsDiligenceConfig();
  if (resolved.kind === 'disabled') {
    return { kind: 'disabled', nextRemainingBudget: options.remainingBudget };
  }

  const maxInjectCount =
    typeof options.diligencePushMax === 'number' && Number.isFinite(options.diligencePushMax)
      ? Math.floor(options.diligencePushMax)
      : 0;
  const normalizedRemaining =
    typeof options.remainingBudget === 'number' && Number.isFinite(options.remainingBudget)
      ? Math.max(0, Math.floor(options.remainingBudget))
      : 0;

  if (maxInjectCount < 1) {
    if (normalizedRemaining < 1) {
      return { kind: 'disabled', nextRemainingBudget: 0 };
    }
    const prompt: KernelDriverHumanPrompt = {
      content: formatDiligenceAutoContinuePrompt(getWorkLanguage(), resolved.diligenceText),
      msgId: generateShortId(),
      grammar: 'markdown',
      origin: 'diligence_push',
    };
    return {
      kind: 'prompt',
      prompt,
      maxInjectCount: 0,
      nextRemainingBudget: normalizedRemaining - 1,
    };
  }

  const currentRemaining = Math.min(normalizedRemaining, maxInjectCount);
  if (currentRemaining < 1) {
    return { kind: 'budget_exhausted', maxInjectCount, nextRemainingBudget: 0 };
  }

  const prompt: KernelDriverHumanPrompt = {
    content: formatDiligenceAutoContinuePrompt(getWorkLanguage(), resolved.diligenceText),
    msgId: generateShortId(),
    grammar: 'markdown',
    origin: 'diligence_push',
  };
  return {
    kind: 'prompt',
    prompt,
    maxInjectCount,
    nextRemainingBudget: currentRemaining - 1,
  };
}

export async function suspendForKeepGoingBudgetExhausted(options: {
  dlg: Dialog;
  maxInjectCount: number;
}): Promise<void> {
  const { dlg, maxInjectCount } = options;
  const language = dlg.getLastUserLanguageCode();
  const content = formatQ4HDiligencePushBudgetExhausted(language, { maxInjectCount });
  const genseq = dlg.activeGenSeqOrUndefined ?? 1;
  // This is informational only: it stops further automatic diligence pushes, but does not create
  // a Q4H wait state and does not participate in revive gating.
  await dlg.persistUiOnlyMarkdown(content, genseq);
  postDialogEvent(dlg, {
    type: 'ui_only_markdown_evt',
    content,
    course: dlg.currentCourse,
    genseq,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const FUNC_TOOL_ARG_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  readonly_shell: {
    timeout: 'timeout_ms',
  },
};

function normalizeFuncToolArguments(
  toolName: string,
  args: Record<string, unknown>,
): ToolArguments {
  const aliases = FUNC_TOOL_ARG_ALIASES[toolName];
  if (!aliases) return args as ToolArguments;
  let normalized: Record<string, unknown> | undefined;

  for (const [aliasKey, canonicalKey] of Object.entries(aliases)) {
    if (!(aliasKey in args)) continue;
    if (!normalized) normalized = { ...args };
    if (!(canonicalKey in normalized)) {
      normalized[canonicalKey] = normalized[aliasKey];
    }
    delete normalized[aliasKey];
  }

  return (normalized ?? args) as ToolArguments;
}

export function validateFuncToolArguments(
  tool: FuncTool,
  rawArgs: unknown,
): { ok: true; args: ToolArguments } | { ok: false; error: string } {
  if (!isPlainObject(rawArgs)) {
    return { ok: false, error: 'Arguments must be an object' };
  }
  const normalizedArgs = normalizeFuncToolArguments(tool.name, rawArgs);
  if (tool.argsValidation === 'passthrough') {
    return { ok: true, args: normalizedArgs };
  }
  const validation = validateArgs(tool.parameters, normalizedArgs);
  return validation.ok
    ? { ok: true, args: normalizedArgs }
    : { ok: false, error: validation.error };
}

type ClassifiedLlmFailure = {
  kind: LlmFailureKind;
  message: string;
  status?: number;
  code?: string;
  retryStrategy?: LlmRetryStrategy;
  retryAfterMs?: number;
};

type EffectiveLlmFailureHandling = {
  failure: ClassifiedLlmFailure;
  handling: LlmQuirkFailureHandling;
};

type SmartRateAdaptiveState = {
  penaltyLevel: number;
  rememberedDelayMs?: number;
  updatedAtMs: number;
};

const SMART_RATE_DECAY_WINDOW_MS = 5 * 60 * 1000;
const smartRateAdaptiveStateByKey = new Map<string, SmartRateAdaptiveState>();

const RETRIABLE_LLM_ERROR_CODES = new Set<string>([
  'DOMINDS_LLM_EMPTY_RESPONSE',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function readErrorCause(error: unknown): unknown {
  if (error instanceof Error) {
    const withCause = error as Error & { cause?: unknown };
    return withCause.cause;
  }
  if (isPlainObject(error) && 'cause' in error) {
    return error.cause;
  }
  return undefined;
}

function readErrorCode(error: unknown): string | undefined {
  if (!isPlainObject(error)) {
    return undefined;
  }
  if ('code' in error && typeof error.code === 'string') {
    return error.code;
  }
  if ('errno' in error && typeof error.errno === 'string') {
    return error.errno;
  }
  return undefined;
}

function isRetriableLlmErrorCode(code: string | undefined): boolean {
  if (!code) return false;
  return RETRIABLE_LLM_ERROR_CODES.has(code);
}

function isRetriableLlmMessage(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes('fetch failed') || lower.includes('socket hang up')) {
    return true;
  }
  if (lower.includes('terminated')) {
    return true;
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return true;
  }
  return false;
}

function readGenericRetriableMessage(err: unknown): string | undefined {
  if (err instanceof Error) {
    const message = err.message.trim();
    if (message !== '') return message;
    const name = err.name.trim();
    return name !== '' ? name : undefined;
  }
  if (typeof err === 'string') {
    const trimmed = err.trim();
    return trimmed !== '' ? trimmed : undefined;
  }
  if (!isPlainObject(err)) {
    return undefined;
  }
  if ('message' in err && typeof err.message === 'string') {
    const trimmed = err.message.trim();
    if (trimmed !== '') return trimmed;
  }
  if (
    'error' in err &&
    isPlainObject(err.error) &&
    'message' in err.error &&
    typeof err.error.message === 'string'
  ) {
    const trimmed = err.error.message.trim();
    if (trimmed !== '') return trimmed;
  }
  if (
    'cause' in err &&
    isPlainObject(err.cause) &&
    'message' in err.cause &&
    typeof err.cause.message === 'string'
  ) {
    const trimmed = err.cause.message.trim();
    if (trimmed !== '') return trimmed;
  }
  return undefined;
}

function normalizeFailureDisposition(
  err: unknown,
  disposition: LlmFailureDisposition,
): ClassifiedLlmFailure {
  const fallbackMessage =
    err instanceof Error
      ? err.message || err.name
      : typeof err === 'string'
        ? err
        : JSON.stringify(err);
  const errCode = readErrorCode(err);
  const causeCode = readErrorCode(readErrorCause(err));
  return {
    kind: disposition.kind,
    message: disposition.message.trim().length > 0 ? disposition.message : fallbackMessage,
    status: disposition.status,
    code: disposition.code ?? errCode ?? causeCode,
    retryStrategy: disposition.retryStrategy,
    retryAfterMs: disposition.retryAfterMs,
  };
}

function classifyGenericLlmFailure(err: unknown): ClassifiedLlmFailure {
  // Ownership boundary:
  // - Wrapper classifiers own provider/API semantics such as HTTP status handling, response-body
  //   rejection semantics, rate limits, overload signals, and provider-advised backoff headers.
  // - The runtime generic classifier only owns provider-agnostic transport/runtime failures such
  //   as local timeout / socket / fetch failures and Dominds internal retriable error codes.
  // When a new unexpected pattern appears, keep it here only if it is clearly transport/runtime
  // scoped and not tied to any specific upstream API contract.
  const fallbackMessage =
    err instanceof Error
      ? err.message || err.name
      : typeof err === 'string'
        ? err
        : JSON.stringify(err);
  const errCode = readErrorCode(err);
  const cause = readErrorCause(err);
  const causeCode = readErrorCode(cause);

  if (err instanceof Error && err.message === 'AbortError') {
    return { kind: 'fatal', message: 'Aborted.' };
  }

  if (isRetriableLlmErrorCode(errCode)) {
    return {
      kind: 'retriable',
      code: errCode,
      message: fallbackMessage,
      retryStrategy: 'aggressive',
    };
  }
  if (isRetriableLlmErrorCode(causeCode)) {
    return {
      kind: 'retriable',
      code: causeCode,
      message: fallbackMessage,
      retryStrategy: 'aggressive',
    };
  }

  const msg = readGenericRetriableMessage(err);
  if (typeof msg === 'string' && isRetriableLlmMessage(msg)) {
    return {
      kind: 'retriable',
      code: errCode ?? causeCode,
      message: msg,
      retryStrategy: 'aggressive',
    };
  }

  if (isPlainObject(err) && 'cause' in err) {
    const causeMessage = readGenericRetriableMessage(err.cause);
    if (typeof causeMessage === 'string' && isRetriableLlmMessage(causeMessage)) {
      return {
        kind: 'retriable',
        code: errCode ?? causeCode,
        message: causeMessage,
        retryStrategy: 'aggressive',
      };
    }
  }

  return { kind: 'fatal', message: fallbackMessage };
}

function classifyLlmFailure(
  err: unknown,
  classifyFailure?: LlmFailureClassifier,
): ClassifiedLlmFailure {
  const providerDisposition = classifyFailure?.(err);
  if (providerDisposition) {
    return normalizeFailureDisposition(err, providerDisposition);
  }
  return classifyGenericLlmFailure(err);
}

function applyQuirkFailureHandling(
  failure: ClassifiedLlmFailure,
  handling: LlmQuirkFailureHandling,
): EffectiveLlmFailureHandling {
  const nextMessage =
    'message' in handling && typeof handling.message === 'string' && handling.message.trim() !== ''
      ? handling.message.trim()
      : failure.message;
  switch (handling.kind) {
    case 'default':
      return { failure, handling };
    case 'give_up':
      return {
        failure: {
          ...failure,
          message: nextMessage,
        },
        handling,
      };
    case 'retry_strategy':
      return {
        failure: {
          ...failure,
          kind: 'retriable',
          message: nextMessage,
          retryStrategy: handling.retryStrategy,
        },
        handling,
      };
    case 'single_retry':
      return {
        failure: {
          ...failure,
          kind: 'retriable',
          message: nextMessage,
          retryStrategy: failure.retryStrategy ?? 'aggressive',
        },
        handling,
      };
    default: {
      const _exhaustive: never = handling;
      return _exhaustive;
    }
  }
}

async function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted) {
    throw new Error('AbortError');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      reject(new Error('AbortError'));
    };

    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeRetryInitialDelayMs(value: number): number {
  if (!Number.isFinite(value)) return 1000;
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : 1000;
}

function normalizeRetryConservativeDelayMs(value: number, fallbackMin: number): number {
  if (!Number.isFinite(value)) return Math.max(30_000, fallbackMin);
  const normalized = Math.floor(value);
  if (normalized < 0) return Math.max(30_000, fallbackMin);
  return Math.max(fallbackMin, normalized);
}

function normalizeRetryBackoffMultiplier(value: number): number {
  if (!Number.isFinite(value)) return 2;
  return value >= 1 ? value : 2;
}

function normalizeRetryMaxDelayMs(value: number, fallbackMin: number): number {
  if (!Number.isFinite(value)) return Math.max(30_000, fallbackMin);
  const normalized = Math.floor(value);
  if (normalized < 0) return Math.max(30_000, fallbackMin);
  return Math.max(fallbackMin, normalized);
}

function buildSmartRateAdaptiveKey(params: { providerId: string; modelId: string }): string {
  return `${params.providerId}::${params.modelId}`;
}

function readSmartRateAdaptiveState(
  key: string,
  nowMs: number,
): SmartRateAdaptiveState | undefined {
  const existing = smartRateAdaptiveStateByKey.get(key);
  if (!existing) return undefined;
  const decayWindows = Math.max(
    0,
    Math.floor((nowMs - existing.updatedAtMs) / SMART_RATE_DECAY_WINDOW_MS),
  );
  if (decayWindows <= 0) {
    return existing;
  }
  const penaltyLevel = Math.max(0, existing.penaltyLevel - decayWindows);
  let rememberedDelayMs = existing.rememberedDelayMs;
  for (let index = 0; index < decayWindows && rememberedDelayMs !== undefined; index += 1) {
    rememberedDelayMs =
      rememberedDelayMs <= 1000 ? undefined : Math.max(1000, Math.floor(rememberedDelayMs * 0.75));
  }
  if (penaltyLevel === 0 && rememberedDelayMs === undefined) {
    smartRateAdaptiveStateByKey.delete(key);
    return undefined;
  }
  const decayed: SmartRateAdaptiveState = {
    penaltyLevel,
    rememberedDelayMs,
    updatedAtMs: nowMs,
  };
  smartRateAdaptiveStateByKey.set(key, decayed);
  return decayed;
}

function recordSmartRateFailureAndResolveBackoffMs(args: {
  providerId: string;
  modelId: string;
  baseDelayMs: number;
  maxDelayMs: number;
  retryAfterMs?: number;
}): number {
  const nowMs = Date.now();
  const key = buildSmartRateAdaptiveKey({
    providerId: args.providerId,
    modelId: args.modelId,
  });
  const current = readSmartRateAdaptiveState(key, nowMs);
  const nextPenaltyLevel = (current?.penaltyLevel ?? 0) + 1;
  const adaptiveDelayMs = Math.min(
    args.maxDelayMs,
    Math.max(
      args.baseDelayMs,
      Math.floor(args.baseDelayMs * 2 ** Math.max(0, nextPenaltyLevel - 1)),
    ),
  );
  const rememberedDelayMs =
    current?.rememberedDelayMs === undefined
      ? undefined
      : Math.max(args.baseDelayMs, current.rememberedDelayMs);
  const providerSuggestedDelayMs =
    args.retryAfterMs === undefined ? undefined : Math.max(0, Math.floor(args.retryAfterMs));
  const backoffMs = Math.max(
    args.baseDelayMs,
    adaptiveDelayMs,
    rememberedDelayMs ?? 0,
    providerSuggestedDelayMs ?? 0,
  );
  smartRateAdaptiveStateByKey.set(key, {
    penaltyLevel: nextPenaltyLevel,
    rememberedDelayMs:
      providerSuggestedDelayMs === undefined
        ? Math.max(backoffMs, rememberedDelayMs ?? 0)
        : Math.max(backoffMs, providerSuggestedDelayMs),
    updatedAtMs: nowMs,
  });
  return backoffMs;
}

function decaySmartRateAdaptiveState(args: { providerId: string; modelId: string }): void {
  const nowMs = Date.now();
  const key = buildSmartRateAdaptiveKey({
    providerId: args.providerId,
    modelId: args.modelId,
  });
  const current = readSmartRateAdaptiveState(key, nowMs);
  if (!current) return;
  const nextPenaltyLevel = Math.max(0, current.penaltyLevel - 1);
  const nextRememberedDelayMs =
    current.rememberedDelayMs === undefined
      ? undefined
      : current.rememberedDelayMs <= 1000
        ? undefined
        : Math.max(1000, Math.floor(current.rememberedDelayMs * 0.75));
  if (nextPenaltyLevel === 0 && nextRememberedDelayMs === undefined) {
    smartRateAdaptiveStateByKey.delete(key);
    return;
  }
  smartRateAdaptiveStateByKey.set(key, {
    penaltyLevel: nextPenaltyLevel,
    rememberedDelayMs: nextRememberedDelayMs,
    updatedAtMs: nowMs,
  });
}

function resolveRetryModeFromHandling(
  handling: LlmQuirkFailureHandling,
): 'policy' | 'quirk_single' {
  return handling.kind === 'single_retry' || handling.kind === 'give_up'
    ? 'quirk_single'
    : 'policy';
}

function emitLlmRetryEventBestEffort(
  args:
    | {
        dlg: Dialog;
        phase: 'waiting';
        display: DialogRetryDisplay;
        errorText: string;
      }
    | {
        dlg: Dialog;
        phase: 'running';
        display: DialogRetryDisplay;
        errorText: string;
      }
    | {
        dlg: Dialog;
        phase: 'resolved';
        display: DialogRetryDisplay;
      }
    | {
        dlg: Dialog;
        phase: 'stopped';
        continueEnabled: boolean;
        reason: DialogLlmRetryExhaustedReason;
      },
): void {
  const rawCourse = args.dlg.activeGenCourseOrUndefined ?? args.dlg.currentCourse;
  const rawGenseq = args.dlg.activeGenSeq;
  if (!Number.isFinite(rawCourse) || rawCourse <= 0) return;
  if (!Number.isFinite(rawGenseq) || rawGenseq <= 0) return;

  switch (args.phase) {
    case 'waiting':
      postDialogEvent(args.dlg, {
        type: 'llm_retry_evt',
        course: Math.floor(rawCourse),
        genseq: Math.floor(rawGenseq),
        phase: 'waiting',
        display: args.display,
        error: args.errorText,
      });
      return;
    case 'running':
      postDialogEvent(args.dlg, {
        type: 'llm_retry_evt',
        course: Math.floor(rawCourse),
        genseq: Math.floor(rawGenseq),
        phase: 'running',
        display: args.display,
        error: args.errorText,
      });
      return;
    case 'resolved':
      postDialogEvent(args.dlg, {
        type: 'llm_retry_evt',
        course: Math.floor(rawCourse),
        genseq: Math.floor(rawGenseq),
        phase: 'resolved',
        display: args.display,
      });
      return;
    case 'stopped':
      postDialogEvent(args.dlg, {
        type: 'llm_retry_evt',
        course: Math.floor(rawCourse),
        genseq: Math.floor(rawGenseq),
        phase: 'stopped',
        continueEnabled: args.continueEnabled,
        reason: args.reason,
      });
      return;
    default: {
      const _exhaustive: never = args;
      return _exhaustive;
    }
  }
}

function buildLlmRetryExhaustedReason(args: {
  errorText: string;
  display: DialogRetryDisplay;
  recoveryAction?: DialogLlmRetryRecoveryAction;
}): DialogLlmRetryExhaustedReason {
  return {
    kind: 'llm_retry_stopped',
    error: args.errorText,
    display: args.display,
    recoveryAction: args.recoveryAction ?? { kind: 'none' },
  };
}

export async function runLlmRequestWithRetry<T>(params: {
  dlg: Dialog;
  provider: string;
  modelId: string;
  providerConfig: ProviderConfig;
  abortSignal?: AbortSignal;
  maxRetries: number;
  retryInitialDelayMs: number;
  retryConservativeDelayMs: number;
  retryBackoffMultiplier: number;
  retryMaxDelayMs: number;
  classifyFailure?: LlmFailureClassifier;
  // Optional opaque per-drive quirk session supplied by the caller. The driver/runtime may carry
  // this session across multiple request invocations, including course changes within the same
  // driver run, but all provider-specific state transitions remain encapsulated inside the quirk
  // handler itself.
  quirkFailureHandlerSession?: LlmFailureQuirkHandlerSession;
  canRetry: () => boolean;
  onRetry?: () => Promise<void> | void;
  onGiveUp?: () => Promise<void> | void;
  // Driver hook for quirk-authored structured recovery actions. Returning 'continue' means the
  // caller has accepted/reserved that recovery path for this stop decision, so the quirk session
  // should treat the recovery budget as consumed immediately even before the follow-up request
  // actually starts. The transient retry-stopped event should stay suppressed for this stop
  // decision.
  onRetryStopped?: (
    reason: DialogLlmRetryExhaustedReason,
  ) => Promise<'continue' | 'stop'> | 'continue' | 'stop';
  doRequest: () => Promise<T>;
}): Promise<T> {
  const providerProblemId = `llm/provider_rejected/${params.dlg.id.valueOf()}`;
  const retryInitialDelayMs = normalizeRetryInitialDelayMs(params.retryInitialDelayMs);
  const retryConservativeDelayMs = normalizeRetryConservativeDelayMs(
    params.retryConservativeDelayMs,
    retryInitialDelayMs,
  );
  const retryBackoffMultiplier = normalizeRetryBackoffMultiplier(params.retryBackoffMultiplier);
  const retryMaxDelayMs = normalizeRetryMaxDelayMs(
    params.retryMaxDelayMs,
    Math.max(retryInitialDelayMs, retryConservativeDelayMs),
  );
  const retryFlowStartedAtMs = Date.now();
  let activeRetryContext:
    | {
        failure: ClassifiedLlmFailure;
        errorText: string;
        handling: LlmQuirkFailureHandling;
      }
    | undefined;
  const quirkFailureHandler =
    params.quirkFailureHandlerSession ?? createLlmFailureQuirkHandlerSession(params.providerConfig);
  let policyRetryCount = 0;

  for (let attempt = 0; ; attempt++) {
    try {
      if (attempt > 0 && activeRetryContext) {
        const retryStrategy = activeRetryContext.failure.retryStrategy ?? 'aggressive';
        const retryMode = resolveRetryModeFromHandling(activeRetryContext.handling);
        emitLlmRetryEventBestEffort({
          dlg: params.dlg,
          phase: 'running',
          display: buildRetryProgressDisplay({
            phase: 'running',
            provider: params.provider,
            retryMode,
            retryStrategy,
            attemptNumber: attempt + 1,
          }),
          errorText: activeRetryContext.errorText,
        });
      }
      const res = await params.doRequest();
      quirkFailureHandler?.onRequestSucceeded?.();
      decaySmartRateAdaptiveState({
        providerId: params.provider,
        modelId: params.modelId,
      });
      if (attempt > 0 && activeRetryContext) {
        const retryStrategy = activeRetryContext.failure.retryStrategy ?? 'aggressive';
        const retryMode = resolveRetryModeFromHandling(activeRetryContext.handling);
        emitLlmRetryEventBestEffort({
          dlg: params.dlg,
          phase: 'resolved',
          display: buildRetryResolvedDisplay({
            provider: params.provider,
            retryMode,
            retryStrategy,
            attemptNumber: attempt + 1,
          }),
        });
      }
      removeProblem(providerProblemId);
      return res;
    } catch (err) {
      if (params.abortSignal?.aborted) {
        throw err;
      }
      if (err instanceof LlmStreamErrorEmittedError) {
        throw err;
      }

      const defaultFailure = classifyLlmFailure(err, params.classifyFailure);
      const handledFailure = applyQuirkFailureHandling(
        defaultFailure,
        quirkFailureHandler?.onFailure({
          provider: params.provider,
          providerConfig: params.providerConfig,
          failure: defaultFailure,
          error: err,
        }) ?? { kind: 'default' },
      );
      const failure = handledFailure.failure;
      const detail = extractErrorDetails(err).message;
      const errorCode = readErrorCode(err);
      const cause = readErrorCause(err);
      const causeCode = readErrorCode(cause);
      const causeMessage =
        cause === undefined || cause === null ? undefined : extractErrorDetails(cause).message;
      const attemptNo = attempt + 1;
      const retryStrategy = failure.retryStrategy ?? 'aggressive';
      const retryMode = resolveRetryModeFromHandling(handledFailure.handling);

      log.warn('LLM request attempt failed', err, {
        provider: params.provider,
        dialogId: params.dlg.id.valueOf(),
        rootId: params.dlg.id.rootId,
        selfId: params.dlg.id.selfId,
        retryStrategy,
        retryMode,
        attemptNumber: attemptNo,
        policyRetryCount,
        failureKind: failure.kind,
        quirkHandling: handledFailure.handling.kind,
        quirkSource: handledFailure.handling.sourceQuirk,
        status: failure.status,
        code: failure.code,
        errorCode,
        causeCode,
        causeMessage,
        errorText: detail,
      });

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
        let streamErrorEmitted = false;
        try {
          await params.dlg.streamError(detail);
          streamErrorEmitted = true;
        } catch {
          // best-effort
        }
        throw new LlmRequestFailedError({
          message: `Provider '${params.provider}' rejected the request: ${failure.message}`,
          detail,
          streamErrorEmitted,
          i18nStopReason: buildHumanSystemStopReasonTextI18n({
            detail,
            providerName:
              params.providerConfig.name.trim().length > 0
                ? params.providerConfig.name
                : params.provider,
            kind: 'provider_rejected',
          }),
        });
      }

      const canRetry = failure.kind === 'retriable' && params.canRetry();
      const stopRetryByQuirk = handledFailure.handling.kind === 'give_up';
      const canScheduleAnotherAttempt =
        handledFailure.handling.kind === 'single_retry' ||
        (retryMode === 'policy' &&
          (retryStrategy === 'conservative' || policyRetryCount < params.maxRetries));
      if (!canRetry || stopRetryByQuirk || !canScheduleAnotherAttempt) {
        if (params.onGiveUp) {
          await params.onGiveUp();
        }
        let retryStoppedError: LlmRetryStoppedError | undefined;
        if (failure.kind === 'retriable' || stopRetryByQuirk) {
          const summaryTextI18nOverride =
            handledFailure.handling.kind === 'give_up'
              ? handledFailure.handling.summaryTextI18n
              : undefined;
          const display = buildRetryExhaustedDisplay({
            provider: params.provider,
            attemptsMade: attemptNo,
            maxRetries: params.maxRetries,
            elapsedMs: Date.now() - retryFlowStartedAtMs,
            retryInitialDelayMs,
            retryConservativeDelayMs,
            retryBackoffMultiplier,
            retryMaxDelayMs,
            suppressRetryTuningHint: handledFailure.handling.kind === 'give_up',
            summaryTextI18nOverride,
          });
          const interruptionReason = buildLlmRetryExhaustedReason({
            errorText: detail,
            display,
            recoveryAction:
              handledFailure.handling.kind === 'give_up'
                ? handledFailure.handling.recoveryAction
                : undefined,
          });
          const retryStoppedDecision = params.onRetryStopped
            ? await params.onRetryStopped(interruptionReason)
            : 'stop';
          if (retryStoppedDecision === 'continue') {
            quirkFailureHandler?.onRecoveryActionUsed?.({
              action: interruptionReason.recoveryAction,
              sourceQuirk: handledFailure.handling.sourceQuirk,
            });
          }
          if (retryStoppedDecision !== 'continue') {
            // Keep the retry-stop progress event non-resumable by default. Do not flip this to
            // true just because the eventual finalized stopped state may allow manual Continue:
            // this event is emitted before the driver has fully unwound, cleared interrupted
            // markers, and persisted the terminal projection, so enabling Continue here would
            // advertise a resume action that is not yet safe or actually available.
            emitLlmRetryEventBestEffort({
              dlg: params.dlg,
              phase: 'stopped',
              continueEnabled: false,
              reason: interruptionReason,
            });
          }
          log.warn('LLM retriable failure stopped retry flow', undefined, {
            provider: params.provider,
            dialogId: params.dlg.id.valueOf(),
            rootId: params.dlg.id.rootId,
            selfId: params.dlg.id.selfId,
            retryStrategy,
            retryMode,
            attemptNumber: attemptNo,
            policyRetryCount,
            maxRetries: params.maxRetries,
            retryInitialDelayMs,
            retryConservativeDelayMs,
            retryBackoffMultiplier,
            retryMaxDelayMs,
            stopRetryByQuirk,
            errorText: detail,
            retryStoppedDecision,
            quirkSource: handledFailure.handling.sourceQuirk,
            summaryTextI18nOverride,
          });
          const interruptionDetail = formatLlmRetryExhaustedInterruptionDetail({
            language: params.dlg.getLastUserLanguageCode(),
            summaryTextI18n: interruptionReason.display.summaryTextI18n,
            errorText: detail,
          });
          retryStoppedError = new LlmRetryStoppedError(interruptionReason, interruptionDetail);
        }
        let streamErrorEmitted = false;
        try {
          await params.dlg.streamError(detail);
          streamErrorEmitted = true;
        } catch {
          // best-effort
        }
        if (retryStoppedError) {
          throw retryStoppedError;
        }
        throw new LlmRequestFailedError({
          message: `LLM failed: ${failure.message}`,
          detail,
          streamErrorEmitted,
          i18nStopReason: buildHumanSystemStopReasonTextI18n({
            detail,
            providerName:
              params.providerConfig.name.trim().length > 0
                ? params.providerConfig.name
                : params.provider,
            fallbackKind: 'request_failed',
          }),
        });
      }

      const conservativeRampAttempt = Math.max(0, Math.floor(attempt / 10));
      const backoffMs =
        handledFailure.handling.kind === 'single_retry'
          ? handledFailure.handling.delayMs
          : retryStrategy === 'conservative'
            ? Math.min(
                retryMaxDelayMs,
                Math.max(
                  0,
                  Math.floor(
                    retryConservativeDelayMs * retryBackoffMultiplier ** conservativeRampAttempt,
                  ),
                ),
              )
            : retryStrategy === 'smart_rate'
              ? recordSmartRateFailureAndResolveBackoffMs({
                  providerId: params.provider,
                  modelId: params.modelId,
                  baseDelayMs: retryConservativeDelayMs,
                  maxDelayMs: retryMaxDelayMs,
                  retryAfterMs: failure.retryAfterMs,
                })
              : Math.min(
                  retryMaxDelayMs,
                  Math.max(0, Math.floor(retryInitialDelayMs * retryBackoffMultiplier ** attempt)),
                );
      emitLlmRetryEventBestEffort({
        dlg: params.dlg,
        phase: 'waiting',
        display: buildRetryProgressDisplay({
          phase: 'waiting',
          provider: params.provider,
          retryMode,
          retryStrategy,
          attemptNumber: attemptNo,
        }),
        errorText: detail,
      });
      activeRetryContext = {
        failure,
        errorText: detail,
        handling: handledFailure.handling,
      };
      log.warn(`Retrying LLM request after retriable error`, undefined, {
        provider: params.provider,
        retryStrategy,
        retryMode,
        attemptNumber: attemptNo,
        policyRetryCount,
        backoffMs,
        retryInitialDelayMs,
        retryConservativeDelayMs,
        retryBackoffMultiplier,
        retryMaxDelayMs,
        failure,
      });
      if (handledFailure.handling.kind !== 'single_retry') {
        policyRetryCount += 1;
      }
      if (params.onRetry) {
        await params.onRetry();
      }
      await sleepWithAbort(backoffMs, params.abortSignal);
      continue;
    }
  }

  throw new Error('LLM failed.');
}

function formatRetryElapsedDuration(language: LanguageCode, elapsedMsRaw: number): string {
  const elapsedMs = Math.max(0, Math.floor(elapsedMsRaw));
  if (elapsedMs < 1000) {
    return `${elapsedMs}ms`;
  }

  const totalSeconds = elapsedMs / 1000;
  if (totalSeconds < 60) {
    const text = totalSeconds >= 10 ? totalSeconds.toFixed(1) : totalSeconds.toFixed(2);
    return language === 'zh' ? `${text} 秒` : `${text}s`;
  }

  const wholeSeconds = Math.round(totalSeconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds % 60;
  if (language === 'zh') {
    return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
  }
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function buildRetryDisplayTextI18n(args: { zh: string; en: string }): DialogDisplayTextI18n {
  return {
    zh: args.zh,
    en: args.en,
  };
}

function resolveDisplayTextI18n(
  texts: DialogDisplayTextI18n,
  language: LanguageCode,
): string | null {
  const localized = texts[language];
  if (typeof localized === 'string' && localized.trim() !== '') {
    return localized.trim();
  }
  const fallback = texts.zh ?? texts.en;
  return typeof fallback === 'string' && fallback.trim() !== '' ? fallback.trim() : null;
}

function formatRetryStrategyForDisplay(args: {
  language: LanguageCode;
  retryStrategy: LlmRetryStrategy;
}): string {
  if (args.language === 'zh') {
    switch (args.retryStrategy) {
      case 'aggressive':
        return 'aggressive';
      case 'conservative':
        return 'conservative';
      case 'smart_rate':
        return 'smart_rate（限频自适应）';
      default: {
        const _exhaustive: never = args.retryStrategy;
        return _exhaustive;
      }
    }
  }
  switch (args.retryStrategy) {
    case 'aggressive':
      return 'aggressive';
    case 'conservative':
      return 'conservative';
    case 'smart_rate':
      return 'smart_rate (adaptive rate backoff)';
    default: {
      const _exhaustive: never = args.retryStrategy;
      return _exhaustive;
    }
  }
}

function buildRetryProgressDisplay(args: {
  phase: 'waiting' | 'running';
  provider: string;
  retryMode: 'policy' | 'quirk_single';
  retryStrategy: LlmRetryStrategy;
  attemptNumber: number;
}): DialogRetryDisplay {
  const providerTextZh = args.provider.trim() === '' ? '当前模型服务' : args.provider.trim();
  const providerTextEn =
    args.provider.trim() === '' ? 'the current provider' : args.provider.trim();
  if (args.retryMode === 'quirk_single') {
    if (args.phase === 'waiting') {
      return {
        titleTextI18n: buildRetryDisplayTextI18n({
          zh: '临时重试',
          en: 'Temporary retry',
        }),
        summaryTextI18n: buildRetryDisplayTextI18n({
          zh: `${providerTextZh} 返回了需要 quirk 处理的可重试错误。Dominds 正在执行一次不占用常规重试预算的临时退避，并将在退避结束后再次尝试。`,
          en: `${providerTextEn} returned a quirk-handled retriable failure. Dominds is performing a temporary backoff and will try once more without consuming the normal retry budget.`,
        }),
      };
    }
    return {
      titleTextI18n: buildRetryDisplayTextI18n({
        zh: '临时重试',
        en: 'Temporary retry',
      }),
      summaryTextI18n: buildRetryDisplayTextI18n({
        zh: `${providerTextZh} 的临时重试正在执行中。`,
        en: `${providerTextEn} temporary retry is now running.`,
      }),
    };
  }

  if (args.phase === 'waiting') {
    const strategyZh = formatRetryStrategyForDisplay({
      language: 'zh',
      retryStrategy: args.retryStrategy,
    });
    const strategyEn = formatRetryStrategyForDisplay({
      language: 'en',
      retryStrategy: args.retryStrategy,
    });
    return {
      titleTextI18n: buildRetryDisplayTextI18n({
        zh: '正在重试',
        en: 'Retrying',
      }),
      summaryTextI18n: buildRetryDisplayTextI18n({
        zh:
          `${providerTextZh} 遇到可重试错误，Dominds 正在退避并将在退避结束后自动继续重试。` +
          `当前失败发生在第 ${String(args.attemptNumber)} 次请求，策略=${strategyZh}。`,
        en:
          `${providerTextEn} hit a retriable failure. Dominds is backing off and will retry automatically when the backoff window ends. ` +
          `The failure occurred on request ${String(args.attemptNumber)}, strategy=${strategyEn}.`,
      }),
    };
  }

  const strategyZh = formatRetryStrategyForDisplay({
    language: 'zh',
    retryStrategy: args.retryStrategy,
  });
  const strategyEn = formatRetryStrategyForDisplay({
    language: 'en',
    retryStrategy: args.retryStrategy,
  });
  return {
    titleTextI18n: buildRetryDisplayTextI18n({
      zh: '正在重试',
      en: 'Retrying',
    }),
    summaryTextI18n: buildRetryDisplayTextI18n({
      zh: `${providerTextZh} 的第 ${String(args.attemptNumber)} 次请求正在执行中，策略=${strategyZh}。即将验证是否恢复。`,
      en: `${providerTextEn} request ${String(args.attemptNumber)} is now running, strategy=${strategyEn}. Recovery is being verified now.`,
    }),
  };
}

function buildRetryExhaustedSummaryTextI18n(args: {
  provider: string;
  attemptsMade: number;
  maxRetries: number;
  elapsedMs: number;
  retryInitialDelayMs: number;
  retryConservativeDelayMs: number;
  retryBackoffMultiplier: number;
  retryMaxDelayMs: number;
  suppressRetryTuningHint?: boolean;
  summaryTextI18nOverride?: DialogDisplayTextI18n;
}): DialogDisplayTextI18n {
  if (args.summaryTextI18nOverride) {
    return args.summaryTextI18nOverride;
  }
  const providerPath = `providers.${args.provider}`;
  const durationTextZh = formatRetryElapsedDuration('zh', args.elapsedMs);
  const durationTextEn = formatRetryElapsedDuration('en', args.elapsedMs);
  const actualRetryCount = Math.max(0, args.attemptsMade - 1);
  const zhBase =
    `LLM 自动重试已停止：provider=${args.provider}，共尝试 ${args.attemptsMade} 次` +
    `（初始请求 1 次 + 重试 ${actualRetryCount} 次），总耗时 ${durationTextZh}。` +
    `当前重试配置：llm_retry_max_retries=${args.maxRetries}，` +
    `llm_retry_initial_delay_ms=${args.retryInitialDelayMs}，` +
    `llm_retry_conservative_delay_ms=${args.retryConservativeDelayMs}，` +
    `llm_retry_backoff_multiplier=${args.retryBackoffMultiplier}，` +
    `llm_retry_max_delay_ms=${args.retryMaxDelayMs}。`;
  const zhTuningHint = args.suppressRetryTuningHint
    ? ''
    : `若想增加重试次数或拉长重试间隔，请编辑 \`.minds/llm.yaml\` 中的 ` +
      `\`${providerPath}.llm_retry_max_retries\`、` +
      `\`${providerPath}.llm_retry_initial_delay_ms\`、` +
      `\`${providerPath}.llm_retry_conservative_delay_ms\`、` +
      `\`${providerPath}.llm_retry_backoff_multiplier\`、` +
      `\`${providerPath}.llm_retry_max_delay_ms\`，并检查 provider / network 稳定性。`;
  const enBase =
    `LLM automatic retries stopped: provider=${args.provider}, ${args.attemptsMade} attempts total ` +
    `(1 initial request + ${actualRetryCount} retries), elapsed ${durationTextEn}. ` +
    `Current retry config: llm_retry_max_retries=${args.maxRetries}, ` +
    `llm_retry_initial_delay_ms=${args.retryInitialDelayMs}, ` +
    `llm_retry_conservative_delay_ms=${args.retryConservativeDelayMs}, ` +
    `llm_retry_backoff_multiplier=${args.retryBackoffMultiplier}, ` +
    `llm_retry_max_delay_ms=${args.retryMaxDelayMs}. `;
  const enTuningHint = args.suppressRetryTuningHint
    ? ''
    : `If you want more retries or longer retry intervals, edit ` +
      `\`.minds/llm.yaml\`: \`${providerPath}.llm_retry_max_retries\`, ` +
      `\`${providerPath}.llm_retry_initial_delay_ms\`, ` +
      `\`${providerPath}.llm_retry_conservative_delay_ms\`, ` +
      `\`${providerPath}.llm_retry_backoff_multiplier\`, ` +
      `\`${providerPath}.llm_retry_max_delay_ms\`, and verify provider/network stability. `;
  return buildRetryDisplayTextI18n({
    zh: zhBase + zhTuningHint,
    en: enBase + enTuningHint,
  });
}

function buildRetryResolvedDisplay(args: {
  provider: string;
  retryMode: 'policy' | 'quirk_single';
  retryStrategy: LlmRetryStrategy;
  attemptNumber: number;
}): DialogRetryDisplay {
  const providerTextZh = args.provider.trim() === '' ? '当前模型服务' : args.provider.trim();
  const providerTextEn =
    args.provider.trim() === '' ? 'the current provider' : args.provider.trim();
  if (args.retryMode === 'quirk_single') {
    return {
      titleTextI18n: buildRetryDisplayTextI18n({
        zh: '临时重试已恢复',
        en: 'Temporary retry recovered',
      }),
      summaryTextI18n: buildRetryDisplayTextI18n({
        zh: `${providerTextZh} 的临时重试已成功恢复，本次生成将继续进行。`,
        en: `${providerTextEn} temporary retry recovered successfully and generation will continue.`,
      }),
    };
  }
  return {
    titleTextI18n: buildRetryDisplayTextI18n({
      zh: '重试已恢复',
      en: 'Retry recovered',
    }),
    summaryTextI18n: buildRetryDisplayTextI18n({
      zh: `${providerTextZh} 的重试已成功恢复，本次生成将继续进行。恢复发生在第 ${String(args.attemptNumber)} 次请求，策略=${formatRetryStrategyForDisplay(
        {
          language: 'zh',
          retryStrategy: args.retryStrategy,
        },
      )}。`,
      en: `${providerTextEn} retry recovered successfully and generation will continue. Recovery happened on request ${String(args.attemptNumber)}, strategy=${formatRetryStrategyForDisplay(
        {
          language: 'en',
          retryStrategy: args.retryStrategy,
        },
      )}.`,
    }),
  };
}

function buildRetryExhaustedDisplay(args: {
  provider: string;
  attemptsMade: number;
  maxRetries: number;
  elapsedMs: number;
  retryInitialDelayMs: number;
  retryConservativeDelayMs: number;
  retryBackoffMultiplier: number;
  retryMaxDelayMs: number;
  suppressRetryTuningHint?: boolean;
  summaryTextI18nOverride?: DialogDisplayTextI18n;
}): DialogRetryDisplay {
  return {
    titleTextI18n: buildRetryDisplayTextI18n({
      zh: '重试已停止',
      en: 'Retry stopped',
    }),
    summaryTextI18n: buildRetryExhaustedSummaryTextI18n(args),
  };
}

function formatLlmRetryExhaustedInterruptionDetail(args: {
  language: LanguageCode;
  summaryTextI18n: DialogDisplayTextI18n;
  errorText: string;
}): string {
  const summaryText = resolveDisplayTextI18n(args.summaryTextI18n, args.language);
  const trimmedError = args.errorText.trim();
  if (summaryText === null || summaryText === '') {
    return trimmedError;
  }
  if (trimmedError === '') {
    return summaryText;
  }
  if (args.language === 'zh') {
    return `${summaryText}最后错误：${trimmedError}`;
  }
  return `${summaryText} Last error: ${trimmedError}`;
}
