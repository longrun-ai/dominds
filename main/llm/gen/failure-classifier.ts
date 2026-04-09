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

export function readErrorStatus(error: unknown): number | undefined {
  if (isPlainObject(error)) {
    if ('status' in error && typeof error.status === 'number') {
      return error.status;
    }
    if ('statusCode' in error && typeof error.statusCode === 'number') {
      return error.statusCode;
    }
  }
  const nested = readNestedError(error);
  if (!nested) {
    return undefined;
  }
  if ('status' in nested && typeof nested.status === 'number') {
    return nested.status;
  }
  if ('statusCode' in nested && typeof nested.statusCode === 'number') {
    return nested.statusCode;
  }
  return undefined;
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

function readErrorHeaders(error: unknown): Record<string, unknown> | undefined {
  if (isPlainObject(error) && 'headers' in error && isPlainObject(error.headers)) {
    return error.headers;
  }
  const nested = readNestedError(error);
  if (nested && 'headers' in nested && isPlainObject(nested.headers)) {
    return nested.headers;
  }
  const response = readNestedResponse(error);
  if (response && 'headers' in response && isPlainObject(response.headers)) {
    return response.headers;
  }
  return undefined;
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
  const headers = readErrorHeaders(error);
  if (headers) {
    const retryAfter = parseRetryAfterHeaderMs(readHeaderValue(headers, 'retry-after'));
    if (retryAfter !== undefined) return retryAfter;
    const resetAfter =
      parseDelayFieldMs(readHeaderValue(headers, 'x-ratelimit-reset-after'), 'seconds') ??
      parseDelayFieldMs(readHeaderValue(headers, 'ratelimit-reset-after'), 'seconds');
    if (resetAfter !== undefined) return resetAfter;
  }

  const roots: Record<string, unknown>[] = [];
  if (isPlainObject(error)) roots.push(error);
  const nested = readNestedError(error);
  if (nested) roots.push(nested);
  const response = readNestedResponse(error);
  if (response) roots.push(response);

  for (const root of roots) {
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

export function isConservativeRetryMessage(lowerMessage: string): boolean {
  if (lowerMessage.includes('servers are currently overloaded')) {
    return true;
  }
  if (lowerMessage.includes('server is currently overloaded')) {
    return true;
  }
  if (lowerMessage.includes('currently overloaded')) {
    return true;
  }
  if (lowerMessage.includes('temporarily overloaded')) {
    return true;
  }
  if (lowerMessage.includes('service unavailable')) {
    return true;
  }
  return lowerMessage.includes('overloaded') && lowerMessage.includes('try again later');
}

export function isOpenAiLikeOverloadFailure(error: unknown): boolean {
  const lowerMessage = buildFailureMessage(error).toLowerCase();
  const status = readErrorStatus(error);
  return status === 503 || status === 529 || isConservativeRetryMessage(lowerMessage);
}

export function isOpenAiLikeRateLimitFailure(error: unknown): boolean {
  const lowerMessage = buildFailureMessage(error).toLowerCase();
  const status = readErrorStatus(error);
  const code = readErrorCode(error)?.toLowerCase();

  if (status === 429) {
    return true;
  }
  if (typeof code === 'string' && code.includes('rate_limit')) {
    return true;
  }
  if (lowerMessage.includes('rate limit')) {
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

  if (code === 'OPENAI_MALFORMED_BATCH_OUTPUT_ITEM') {
    return {
      kind: 'fatal',
      message,
      status,
      code,
    };
  }

  if (code === 'XCODE_BEST_STREAM_INTERNAL_ERROR') {
    return {
      kind: 'retriable',
      message,
      status,
      code,
      retryStrategy: 'aggressive',
    };
  }

  if (isOpenAiLikeOverloadFailure(error)) {
    return {
      kind: 'retriable',
      message,
      status,
      code,
      retryStrategy: 'conservative',
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

  if (isOpenAiRetriableProcessingFailureMessage(lowerMessage)) {
    return {
      kind: 'retriable',
      message,
      status,
      code,
      retryStrategy: 'aggressive',
    };
  }

  return undefined;
}

export function classifyAnthropicFailure(error: unknown): LlmFailureDisposition | undefined {
  const message = buildFailureMessage(error);
  const lowerMessage = message.toLowerCase();
  const status = readErrorStatus(error);
  const code = readErrorCode(error);
  const errorType = readErrorType(error);

  if (
    errorType === 'overloaded_error' ||
    status === 529 ||
    isConservativeRetryMessage(lowerMessage)
  ) {
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
