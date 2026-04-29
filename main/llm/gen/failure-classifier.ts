import type { LlmFailureDisposition } from '../gen';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNestedError(error: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(error) || !('error' in error) || !isPlainObject(error.error)) {
    return undefined;
  }
  return error.error;
}

function readNestedResponse(error: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(error) || !('response' in error) || !isPlainObject(error.response)) {
    return undefined;
  }
  return error.response;
}

function readErrorRoots(error: unknown): Record<string, unknown>[] {
  const roots: Record<string, unknown>[] = [];
  if (isPlainObject(error)) {
    roots.push(error);
  }
  const nested = readNestedError(error);
  if (nested) {
    roots.push(nested);
  }
  const nestedResponse = nested ? readNestedResponse(nested) : undefined;
  if (nestedResponse) {
    roots.push(nestedResponse);
  }
  const response = readNestedResponse(error);
  if (response) {
    roots.push(response);
  }
  return roots;
}

function readStatusFromRoot(root: Record<string, unknown>): number | undefined {
  if ('status' in root && typeof root.status === 'number') {
    return root.status;
  }
  if ('statusCode' in root && typeof root.statusCode === 'number') {
    return root.statusCode;
  }
  return undefined;
}

export function readErrorStatus(error: unknown): number | undefined {
  for (const root of readErrorRoots(error)) {
    const status = readStatusFromRoot(root);
    if (status !== undefined) {
      return status;
    }
  }
  return undefined;
}

function errorHasStatus(error: unknown, expectedStatus: number): boolean {
  return readErrorRoots(error).some((root) => readStatusFromRoot(root) === expectedStatus);
}

export function readErrorCode(error: unknown): string | undefined {
  if (isPlainObject(error)) {
    if ('code' in error && typeof error.code === 'string') {
      return error.code;
    }
    if ('errno' in error && typeof error.errno === 'string') {
      return error.errno;
    }
  }
  const nested = readNestedError(error);
  if (nested && 'code' in nested && typeof nested.code === 'string') {
    return nested.code;
  }
  return undefined;
}

function readErrorType(error: unknown): string | undefined {
  if (isPlainObject(error) && 'type' in error && typeof error.type === 'string') {
    return error.type;
  }
  const nested = readNestedError(error);
  if (nested && 'type' in nested && typeof nested.type === 'string') {
    return nested.type;
  }
  return undefined;
}

export function readErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? message : error.name;
  }
  if (typeof error === 'string') {
    const message = error.trim();
    return message.length > 0 ? message : undefined;
  }
  if (isPlainObject(error) && 'message' in error && typeof error.message === 'string') {
    const message = error.message.trim();
    if (message.length > 0) {
      return message;
    }
  }
  const nested = readNestedError(error);
  if (nested && 'message' in nested && typeof nested.message === 'string') {
    const message = nested.message.trim();
    return message.length > 0 ? message : undefined;
  }
  return undefined;
}

function readErrorHeaderRoots(error: unknown): Record<string, unknown>[] {
  const headerRoots: Record<string, unknown>[] = [];
  for (const root of readErrorRoots(error)) {
    if ('headers' in root && isPlainObject(root.headers)) {
      headerRoots.push(root.headers);
    }
  }
  return headerRoots;
}

function readHeaderValue(headers: Record<string, unknown>, headerName: string): unknown {
  const target = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function parseRetryAfterHeaderMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value * 1000));
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return Math.max(0, Math.floor(numeric * 1000));
  }
  const parsedDateMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedDateMs)) return undefined;
  return Math.max(0, parsedDateMs - Date.now());
}

function parseDelayFieldMs(value: unknown, unit: 'milliseconds' | 'seconds'): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = unit === 'seconds' ? value * 1000 : value;
    return Math.max(0, Math.floor(ms));
  }
  if (typeof value !== 'string') return undefined;
  const numeric = Number(value.trim());
  if (!Number.isFinite(numeric)) return undefined;
  const ms = unit === 'seconds' ? numeric * 1000 : numeric;
  return Math.max(0, Math.floor(ms));
}

export function readProviderSuggestedRetryAfterMs(error: unknown): number | undefined {
  for (const headers of readErrorHeaderRoots(error)) {
    const retryAfter = parseRetryAfterHeaderMs(readHeaderValue(headers, 'retry-after'));
    if (retryAfter !== undefined) return retryAfter;
    const resetAfter =
      parseDelayFieldMs(readHeaderValue(headers, 'x-ratelimit-reset-after'), 'seconds') ??
      parseDelayFieldMs(readHeaderValue(headers, 'ratelimit-reset-after'), 'seconds');
    if (resetAfter !== undefined) return resetAfter;
  }

  for (const root of readErrorRoots(error)) {
    const retryAfterMs =
      parseDelayFieldMs(root.retryAfterMs, 'milliseconds') ??
      parseDelayFieldMs(root.retry_after_ms, 'milliseconds') ??
      parseDelayFieldMs(root.resetAfterMs, 'milliseconds') ??
      parseDelayFieldMs(root.reset_after_ms, 'milliseconds');
    if (retryAfterMs !== undefined) return retryAfterMs;

    const retryAfterSeconds =
      parseDelayFieldMs(root.retryAfter, 'seconds') ??
      parseDelayFieldMs(root.retry_after, 'seconds') ??
      parseDelayFieldMs(root.resetAfter, 'seconds') ??
      parseDelayFieldMs(root.reset_after, 'seconds');
    if (retryAfterSeconds !== undefined) return retryAfterSeconds;
  }

  return undefined;
}

function buildFailureMessage(error: unknown): string {
  return readErrorMessage(error) ?? 'Unknown LLM provider error.';
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

const OPENAI_LIKE_AGGRESSIVE_TRANSPORT_CODES = new Set<string>([
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

function isOpenAiLikeAggressiveTransportFailure(error: unknown, lowerMessage: string): boolean {
  const code = readErrorCode(error);
  if (typeof code === 'string' && OPENAI_LIKE_AGGRESSIVE_TRANSPORT_CODES.has(code)) {
    return true;
  }
  if (lowerMessage.includes('fetch failed') || lowerMessage.includes('socket hang up')) {
    return true;
  }
  if (lowerMessage.includes('terminated')) {
    return true;
  }
  if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
    return true;
  }
  return false;
}

function isHighConfidenceRejectedStatus(status: number | undefined): boolean {
  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 413 ||
    status === 422
  );
}

function isOpenAiLikeRejectedFailure(error: unknown): boolean {
  const status = readErrorStatus(error);
  if (errorHasStatus(error, 429)) {
    return false;
  }
  return isHighConfidenceRejectedStatus(status);
}

function isOpenAiLikeContextWindowRejectedFailure(args: {
  lowerMessage: string;
  lowerCode: string | undefined;
}): boolean {
  if (args.lowerCode === 'context_length_exceeded') {
    return true;
  }
  if (
    args.lowerMessage.includes('context window') &&
    (args.lowerMessage.includes('exceeds') || args.lowerMessage.includes('exceeded'))
  ) {
    return true;
  }
  if (args.lowerMessage.includes('context limit exceeded')) {
    return true;
  }
  if (args.lowerMessage.includes('maximum context length')) {
    return true;
  }
  if (args.lowerMessage.includes('context_length_exceeded')) {
    return true;
  }
  return args.lowerMessage.includes('too many tokens') && args.lowerMessage.includes('context');
}

export function isOpenAiLikeRateLimitFailure(error: unknown): boolean {
  const lowerMessage = buildFailureMessage(error).toLowerCase();
  const code = readErrorCode(error)?.toLowerCase();

  if (errorHasStatus(error, 429)) {
    return true;
  }
  if (typeof code === 'string' && code.includes('rate_limit')) {
    return true;
  }
  if (lowerMessage.includes('rate limit')) {
    return true;
  }
  if (lowerMessage.includes('concurrency limit exceeded')) {
    return true;
  }
  if (lowerMessage.includes('concurrent request limit')) {
    return true;
  }
  if (
    lowerMessage.includes('concurrency limit') &&
    (lowerMessage.includes('retry later') || lowerMessage.includes('try again later'))
  ) {
    return true;
  }
  if (lowerMessage.includes('requests per min')) {
    return true;
  }
  return lowerMessage.includes('rpm') && lowerMessage.includes('limit');
}

export function classifyOpenAiLikeFailure(error: unknown): LlmFailureDisposition | undefined {
  const message = buildFailureMessage(error);
  const lowerMessage = message.toLowerCase();
  const status = readErrorStatus(error);
  const code = readErrorCode(error);
  const lowerCode = typeof code === 'string' ? code.trim().toLowerCase() : undefined;

  if (
    isOpenAiLikeRejectedFailure(error) ||
    isOpenAiLikeContextWindowRejectedFailure({ lowerMessage, lowerCode })
  ) {
    return {
      kind: 'rejected',
      message,
      status,
      code,
    };
  }

  if (code === 'OPENAI_MALFORMED_BATCH_OUTPUT_ITEM') {
    return {
      kind: 'fatal',
      message,
      status,
      code,
    };
  }

  if (isOpenAiLikeRateLimitFailure(error)) {
    return {
      kind: 'retriable',
      message,
      status,
      code,
      retryStrategy: 'smart_rate',
      retryAfterMs: readProviderSuggestedRetryAfterMs(error),
    };
  }

  if (isOpenAiLikeAggressiveTransportFailure(error, lowerMessage)) {
    return {
      kind: 'retriable',
      message,
      status,
      code,
      retryStrategy: 'aggressive',
    };
  }

  if (isOpenAiRetriableProcessingFailureMessage(lowerMessage)) {
    return {
      kind: 'retriable',
      message,
      status,
      code,
      retryStrategy: 'conservative',
    };
  }

  if (status !== undefined || code !== undefined) {
    return {
      kind: 'retriable',
      message,
      status,
      code,
      retryStrategy: 'conservative',
    };
  }

  return undefined;
}

function isAnthropicRejectedFailure(error: unknown): boolean {
  const status = readErrorStatus(error);
  const errorType = readErrorType(error);
  if (isHighConfidenceRejectedStatus(status)) {
    return true;
  }
  return (
    errorType === 'invalid_request_error' ||
    errorType === 'authentication_error' ||
    errorType === 'permission_error' ||
    errorType === 'not_found_error'
  );
}

function isAnthropicRateLimitFailure(error: unknown): boolean {
  const status = readErrorStatus(error);
  const errorType = readErrorType(error);
  const lowerMessage = buildFailureMessage(error).toLowerCase();

  if (status === 429 || errorType === 'rate_limit_error') {
    return true;
  }
  return lowerMessage.includes('rate limit');
}

export function classifyAnthropicFailure(error: unknown): LlmFailureDisposition | undefined {
  const message = buildFailureMessage(error);
  const status = readErrorStatus(error);
  const code = readErrorCode(error);

  if (isAnthropicRejectedFailure(error)) {
    return {
      kind: 'rejected',
      message,
      status,
      code,
    };
  }

  if (isAnthropicRateLimitFailure(error)) {
    return {
      kind: 'retriable',
      message,
      status,
      code,
      retryStrategy: 'smart_rate',
      retryAfterMs: readProviderSuggestedRetryAfterMs(error),
    };
  }

  if (status !== undefined || readErrorType(error) !== undefined) {
    return {
      kind: 'retriable',
      message,
      status,
      code,
      retryStrategy: 'conservative',
    };
  }

  return undefined;
}
