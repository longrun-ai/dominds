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

function readErrorStatus(error: unknown): number | undefined {
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

function readErrorCode(error: unknown): string | undefined {
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

function readErrorMessage(error: unknown): string | undefined {
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

function isConservativeRetryMessage(lowerMessage: string): boolean {
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

export function classifyOpenAiLikeFailure(error: unknown): LlmFailureDisposition | undefined {
  const message = buildFailureMessage(error);
  const lowerMessage = message.toLowerCase();
  const status = readErrorStatus(error);
  const code = readErrorCode(error);

  if (status === 503 || status === 529 || isConservativeRetryMessage(lowerMessage)) {
    return {
      kind: 'retriable',
      message,
      status,
      code,
      retryStrategy: 'conservative',
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
