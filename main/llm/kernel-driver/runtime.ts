import * as fs from 'fs';
import * as path from 'path';

import { Dialog } from '../../dialog';
import { postDialogEvent } from '../../evt-registry';
import { extractErrorDetails, log } from '../../log';
import { DialogPersistence } from '../../persistence';
import { removeProblem, upsertProblem } from '../../problems';
import { DILIGENCE_FALLBACK_TEXT } from '../../shared/diligence';
import { formatQ4HDiligencePushBudgetExhausted } from '../../shared/i18n/driver-messages';
import { getWorkLanguage } from '../../shared/runtime-language';
import type { NewQ4HAskedEvent } from '../../shared/types/dialog';
import type { LanguageCode } from '../../shared/types/language';
import type { HumanQuestion } from '../../shared/types/storage';
import { generateShortId } from '../../shared/utils/id';
import { formatUnifiedTimestamp } from '../../shared/utils/time';
import type { FuncTool, ToolArguments } from '../../tool';
import { validateArgs } from '../../tool';
import { generateDialogID } from '../../utils/id';
import type { KernelDriverHumanPrompt } from './types';

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
      content: resolved.diligenceText,
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
    content: resolved.diligenceText,
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
  const questionId = `q4h-${generateDialogID()}`;
  const language = dlg.getLastUserLanguageCode();
  const question: HumanQuestion = {
    id: questionId,
    tellaskContent: formatQ4HDiligencePushBudgetExhausted(language, { maxInjectCount }),
    askedAt: formatUnifiedTimestamp(new Date()),
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

type LlmFailureKind = 'retriable' | 'rejected' | 'fatal';

type ClassifiedLlmFailure = {
  kind: LlmFailureKind;
  message: string;
  status?: number;
  code?: string;
};

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

function isOpenAiRetriableProcessingFailureMessage(lowerMessage: string): boolean {
  if (!lowerMessage.includes('processing your request')) {
    return false;
  }
  if (
    lowerMessage.includes('you can retry your request') ||
    lowerMessage.includes('please retry your request')
  ) {
    return true;
  }
  return lowerMessage.includes('help.openai.com') && lowerMessage.includes('request id');
}

function isRetriableLlmMessage(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes('fetch failed') || lower.includes('socket hang up')) {
    return true;
  }
  if (lower.includes('terminated')) {
    return true;
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('rate limit')) {
    return true;
  }
  if (isOpenAiRetriableProcessingFailureMessage(lower)) {
    return true;
  }
  return false;
}

function classifyLlmFailure(err: unknown): ClassifiedLlmFailure {
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
    return { kind: 'retriable', code: errCode, message: fallbackMessage };
  }
  if (isRetriableLlmErrorCode(causeCode)) {
    return { kind: 'retriable', code: causeCode, message: fallbackMessage };
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
      if (isRetriableLlmMessage(msg)) {
        return { kind: 'retriable', code: errCode ?? causeCode, message: msg };
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

    const code = readErrorCode(err);

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

    if (isRetriableLlmErrorCode(code)) {
      return { kind: 'retriable', code, message: msg };
    }

    if (isRetriableLlmMessage(msg)) {
      return { kind: 'retriable', code: code ?? causeCode, message: msg };
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

function normalizeRetryInitialDelayMs(value: number): number {
  if (!Number.isFinite(value)) return 1000;
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : 1000;
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

function emitLlmRetryEventBestEffort(args: {
  dlg: Dialog;
  phase: 'retrying' | 'exhausted';
  provider: string;
  attempt: number;
  totalAttempts: number;
  maxRetries: number;
  retriesRemaining: number;
  backoffMs?: number;
  failure: ClassifiedLlmFailure;
  errorText: string;
  suggestion?: string;
}): void {
  const rawCourse = args.dlg.activeGenCourseOrUndefined ?? args.dlg.currentCourse;
  const rawGenseq = args.dlg.activeGenSeq;
  if (!Number.isFinite(rawCourse) || rawCourse <= 0) return;
  if (!Number.isFinite(rawGenseq) || rawGenseq <= 0) return;

  postDialogEvent(args.dlg, {
    type: 'llm_retry_evt',
    course: Math.floor(rawCourse),
    genseq: Math.floor(rawGenseq),
    phase: args.phase,
    provider: args.provider,
    attempt: args.attempt,
    totalAttempts: args.totalAttempts,
    maxRetries: args.maxRetries,
    retriesRemaining: args.retriesRemaining,
    backoffMs: args.backoffMs,
    failureKind: args.failure.kind,
    status: args.failure.status,
    code: args.failure.code,
    error: args.errorText,
    suggestion: args.suggestion,
  });
}

export async function runLlmRequestWithRetry<T>(params: {
  dlg: Dialog;
  provider: string;
  abortSignal?: AbortSignal;
  maxRetries: number;
  retryInitialDelayMs: number;
  retryBackoffMultiplier: number;
  retryMaxDelayMs: number;
  canRetry: () => boolean;
  onRetry?: () => Promise<void> | void;
  onGiveUp?: () => Promise<void> | void;
  doRequest: () => Promise<T>;
}): Promise<T> {
  const providerProblemId = `llm/provider_rejected/${params.dlg.id.valueOf()}`;
  const totalAttempts = params.maxRetries + 1;
  const retryInitialDelayMs = normalizeRetryInitialDelayMs(params.retryInitialDelayMs);
  const retryBackoffMultiplier = normalizeRetryBackoffMultiplier(params.retryBackoffMultiplier);
  const retryMaxDelayMs = normalizeRetryMaxDelayMs(params.retryMaxDelayMs, retryInitialDelayMs);
  const retryFlowStartedAtMs = Date.now();

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
      const errorCode = readErrorCode(err);
      const cause = readErrorCause(err);
      const causeCode = readErrorCode(cause);
      const causeMessage =
        cause === undefined || cause === null ? undefined : extractErrorDetails(cause).message;
      const attemptNo = attempt + 1;
      const retriesRemaining = Math.max(0, params.maxRetries - attempt);

      log.warn('LLM request attempt failed', err, {
        provider: params.provider,
        dialogId: params.dlg.id.valueOf(),
        rootId: params.dlg.id.rootId,
        selfId: params.dlg.id.selfId,
        attempt: attemptNo,
        totalAttempts,
        retriesRemaining,
        failureKind: failure.kind,
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
        try {
          await params.dlg.streamError(detail);
        } catch {
          // best-effort
        }
        throw new Error(`Provider '${params.provider}' rejected the request: ${failure.message}`);
      }

      const canRetry = failure.kind === 'retriable' && params.canRetry();
      const isLastAttempt = attempt >= params.maxRetries;
      if (!canRetry || isLastAttempt) {
        if (params.onGiveUp) {
          await params.onGiveUp();
        }
        if (failure.kind === 'retriable') {
          const suggestion = `Consider increasing providers.${params.provider}.llm_retry_max_retries / llm_retry_initial_delay_ms / llm_retry_backoff_multiplier / llm_retry_max_delay_ms in .minds/llm.yaml, and verify provider/network stability.`;
          emitLlmRetryEventBestEffort({
            dlg: params.dlg,
            phase: 'exhausted',
            provider: params.provider,
            attempt: attemptNo,
            totalAttempts,
            maxRetries: params.maxRetries,
            retriesRemaining,
            failure,
            errorText: detail,
            suggestion,
          });
          log.warn('LLM retriable failure exhausted retries', undefined, {
            provider: params.provider,
            dialogId: params.dlg.id.valueOf(),
            rootId: params.dlg.id.rootId,
            selfId: params.dlg.id.selfId,
            attempt: attemptNo,
            totalAttempts,
            maxRetries: params.maxRetries,
            retryInitialDelayMs,
            retryBackoffMultiplier,
            retryMaxDelayMs,
            errorText: detail,
            suggestion,
          });
        }
        try {
          await params.dlg.streamError(detail);
        } catch {
          // best-effort
        }
        if (canRetry) {
          const interruptionDetail = formatLlmRetryExhaustedInterruptionDetail({
            language: params.dlg.getLastUserLanguageCode(),
            provider: params.provider,
            totalAttempts,
            maxRetries: params.maxRetries,
            elapsedMs: Date.now() - retryFlowStartedAtMs,
            retryInitialDelayMs,
            retryBackoffMultiplier,
            retryMaxDelayMs,
            errorText: detail,
          });
          throw new Error(interruptionDetail);
        }
        throw new Error(`LLM failed: ${failure.message}`);
      }

      const backoffMs = Math.min(
        retryMaxDelayMs,
        Math.max(0, Math.floor(retryInitialDelayMs * retryBackoffMultiplier ** attempt)),
      );
      emitLlmRetryEventBestEffort({
        dlg: params.dlg,
        phase: 'retrying',
        provider: params.provider,
        attempt: attemptNo,
        totalAttempts,
        maxRetries: params.maxRetries,
        retriesRemaining,
        backoffMs,
        failure,
        errorText: detail,
      });
      log.warn(`Retrying LLM request after retriable error`, undefined, {
        provider: params.provider,
        attempt: attemptNo,
        backoffMs,
        retryInitialDelayMs,
        retryBackoffMultiplier,
        retryMaxDelayMs,
        failure,
      });
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

function formatLlmRetryExhaustedInterruptionDetail(args: {
  language: LanguageCode;
  provider: string;
  totalAttempts: number;
  maxRetries: number;
  elapsedMs: number;
  retryInitialDelayMs: number;
  retryBackoffMultiplier: number;
  retryMaxDelayMs: number;
  errorText: string;
}): string {
  const providerPath = `providers.${args.provider}`;
  const durationText = formatRetryElapsedDuration(args.language, args.elapsedMs);
  const trimmedError = args.errorText.trim();
  if (args.language === 'zh') {
    return (
      `LLM 自动重试已耗尽：provider=${args.provider}，共尝试 ${args.totalAttempts} 次` +
      `（初始请求 1 次 + 重试 ${args.maxRetries} 次），总耗时 ${durationText}。` +
      `当前重试配置：llm_retry_max_retries=${args.maxRetries}，` +
      `llm_retry_initial_delay_ms=${args.retryInitialDelayMs}，` +
      `llm_retry_backoff_multiplier=${args.retryBackoffMultiplier}，` +
      `llm_retry_max_delay_ms=${args.retryMaxDelayMs}。` +
      `若想增加重试次数或拉长重试间隔，请编辑 \`.minds/llm.yaml\` 中的 ` +
      `\`${providerPath}.llm_retry_max_retries\`、` +
      `\`${providerPath}.llm_retry_initial_delay_ms\`、` +
      `\`${providerPath}.llm_retry_backoff_multiplier\`、` +
      `\`${providerPath}.llm_retry_max_delay_ms\`，并检查 provider / network 稳定性。` +
      `最后错误：${trimmedError}`
    );
  }

  return (
    `LLM automatic retries exhausted: provider=${args.provider}, ${args.totalAttempts} attempts total ` +
    `(1 initial request + ${args.maxRetries} retries), elapsed ${durationText}. ` +
    `Current retry config: llm_retry_max_retries=${args.maxRetries}, ` +
    `llm_retry_initial_delay_ms=${args.retryInitialDelayMs}, ` +
    `llm_retry_backoff_multiplier=${args.retryBackoffMultiplier}, ` +
    `llm_retry_max_delay_ms=${args.retryMaxDelayMs}. ` +
    `If you want more retries or longer retry intervals, edit ` +
    `\`.minds/llm.yaml\`: \`${providerPath}.llm_retry_max_retries\`, ` +
    `\`${providerPath}.llm_retry_initial_delay_ms\`, ` +
    `\`${providerPath}.llm_retry_backoff_multiplier\`, ` +
    `\`${providerPath}.llm_retry_max_delay_ms\`, and verify provider/network stability. ` +
    `Last error: ${trimmedError}`
  );
}
