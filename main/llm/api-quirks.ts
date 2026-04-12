import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import { findDomindsPersistenceFileError } from '../persistence-errors';
import type { ProviderConfig } from './client';
import type { LlmRetryStrategy } from './gen';

export type LlmFailureKind = 'retriable' | 'rejected' | 'fatal';

export type LlmFailureSummary = {
  kind: LlmFailureKind;
  message: string;
  status?: number;
  code?: string;
};

export type LlmQuirkFailureHandling =
  | { kind: 'default' }
  | {
      kind: 'give_up';
      message?: string;
      summaryTextI18n?: Partial<Record<LanguageCode, string>>;
    }
  | {
      kind: 'retry_strategy';
      retryStrategy: LlmRetryStrategy;
      message?: string;
    }
  | {
      kind: 'single_retry';
      delayMs: number;
      message?: string;
    };

export type LlmFailureQuirkHandlerSession = {
  onFailure: (args: {
    provider: string;
    providerConfig: ProviderConfig;
    failure: LlmFailureSummary;
    error: unknown;
  }) => LlmQuirkFailureHandling;
};

type LlmFailureQuirkHandlerFactory = (
  providerConfig: ProviderConfig,
) => LlmFailureQuirkHandlerSession;

const DOMINDS_LLM_EMPTY_RESPONSE_ERROR_CODE = 'DOMINDS_LLM_EMPTY_RESPONSE';
const XCODE_BEST_EMPTY_RESPONSE_SINGLE_RETRY_DELAY_MS = 3000;
const XCODE_BEST_EMPTY_RESPONSE_GIVE_UP_THRESHOLD = 5;
const XCODE_BEST_GATEWAY_HTML_502_RETRY_MESSAGE =
  'xcode.best gateway returned an HTML 502 Bad Gateway page; retrying conservatively.';
const XCODE_BEST_UNEXPECTED_EOF_RETRY_MESSAGE =
  'xcode.best upstream stream ended unexpectedly (unexpected EOF); retrying conservatively.';
const LOCAL_FILE_IO_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM']);
const LOCAL_FILE_IO_SYSCALLS = new Set([
  'open',
  'read',
  'write',
  'close',
  'stat',
  'lstat',
  'fstat',
  'rename',
  'truncate',
  'mkdir',
  'readdir',
]);

function isXcodeBestGatewayHtml502Failure(failure: LlmFailureSummary, error: unknown): boolean {
  const status = failure.status ?? readErrorStatus(error);
  if (status !== 502) {
    return false;
  }

  const message = readErrorMessage(error) ?? failure.message;
  const lowerMessage = message.toLowerCase();
  if (!lowerMessage.includes('bad gateway')) {
    return false;
  }
  if (lowerMessage.includes('<!doctype html')) {
    return true;
  }
  return lowerMessage.includes('<html') || lowerMessage.includes('cloudflare');
}

function isXcodeBestUnexpectedEofFailure(failure: LlmFailureSummary, error: unknown): boolean {
  return (
    (errorChainIncludesMessageFragment(error, 'unexpected eof') ||
      failure.message.toLowerCase().includes('unexpected eof')) &&
    !hasLikelyLocalFileErrorContext(error)
  );
}

function getErrorChain(error: unknown): unknown[] {
  const queue: unknown[] = [error];
  const visited = new Set<object>();
  const chain: unknown[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }
    if (typeof current === 'object' && current !== null) {
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);
    }
    chain.push(current);

    const nestedError = readNestedError(current);
    if (nestedError !== undefined) {
      queue.push(nestedError);
    }
    const cause = readErrorCause(current);
    if (cause !== undefined) {
      queue.push(cause);
    }
  }

  return chain;
}

function readErrorStatus(error: unknown): number | undefined {
  for (const current of getErrorChain(error)) {
    if (isRecord(current)) {
      if ('status' in current && typeof current.status === 'number') {
        return current.status;
      }
      if ('statusCode' in current && typeof current.statusCode === 'number') {
        return current.statusCode;
      }
    }
  }
  return undefined;
}

function readErrorCause(error: unknown): unknown {
  if (error instanceof Error) {
    const withCause = error as Error & { cause?: unknown };
    return withCause.cause;
  }
  if (isRecord(error) && 'cause' in error) {
    return error.cause;
  }
  return undefined;
}

function readNestedError(error: unknown): unknown {
  if (isRecord(error) && 'error' in error && isRecord(error.error)) {
    return error.error;
  }
  return undefined;
}

function readErrorPath(error: unknown): string | undefined {
  for (const current of getErrorChain(error)) {
    if (current instanceof Error) {
      const withPath = current as Error & { path?: unknown };
      if (typeof withPath.path === 'string' && withPath.path.trim() !== '') {
        return withPath.path;
      }
    }
    if (isRecord(current)) {
      if ('path' in current && typeof current.path === 'string' && current.path.trim() !== '') {
        return current.path;
      }
    }
  }
  return undefined;
}

function readErrorSyscall(error: unknown): string | undefined {
  for (const current of getErrorChain(error)) {
    if (current instanceof Error) {
      const withSyscall = current as Error & { syscall?: unknown };
      if (typeof withSyscall.syscall === 'string' && withSyscall.syscall.trim() !== '') {
        return withSyscall.syscall;
      }
    }
    if (isRecord(current)) {
      if (
        'syscall' in current &&
        typeof current.syscall === 'string' &&
        current.syscall.trim() !== ''
      ) {
        return current.syscall;
      }
    }
  }
  return undefined;
}

function readErrorMessage(error: unknown): string | undefined {
  for (const current of getErrorChain(error)) {
    if (current instanceof Error) {
      const trimmed = current.message.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
      if (current.name.trim().length > 0) {
        return current.name;
      }
    }
    if (typeof current === 'string') {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
    if (isRecord(current)) {
      if ('message' in current && typeof current.message === 'string') {
        const trimmed = current.message.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
  }
  return undefined;
}

function errorChainIncludesMessageFragment(error: unknown, fragment: string): boolean {
  const lowerFragment = fragment.toLowerCase();
  for (const current of getErrorChain(error)) {
    if (current instanceof Error) {
      if (current.message.toLowerCase().includes(lowerFragment)) {
        return true;
      }
      continue;
    }
    if (typeof current === 'string') {
      if (current.toLowerCase().includes(lowerFragment)) {
        return true;
      }
      continue;
    }
    if (isRecord(current) && 'message' in current && typeof current.message === 'string') {
      if (current.message.toLowerCase().includes(lowerFragment)) {
        return true;
      }
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasLikelyLocalFileErrorContext(error: unknown): boolean {
  const persistenceFileError = findDomindsPersistenceFileError(error);
  if (persistenceFileError) {
    return true;
  }
  const pathValue = readErrorPath(error);
  const syscall = readErrorSyscall(error);
  if (typeof syscall === 'string' && LOCAL_FILE_IO_SYSCALLS.has(syscall)) {
    return true;
  }
  const code = readErrorCode(error);
  if (
    typeof code === 'string' &&
    LOCAL_FILE_IO_ERROR_CODES.has(code) &&
    isLikelyDomindsFilePath(pathValue)
  ) {
    return true;
  }
  if (isLikelyDomindsFilePath(pathValue)) {
    return true;
  }
  return false;
}

function isLikelyDomindsFilePath(filePath: string | undefined): boolean {
  if (typeof filePath !== 'string') {
    return false;
  }
  const normalized = filePath.split('\\').join('/').trim().toLowerCase();
  if (normalized === '') {
    return false;
  }
  return (
    normalized.includes('/.dialogs/') ||
    normalized.includes('/.minds/') ||
    normalized.endsWith('/latest.yaml') ||
    normalized.endsWith('/dialog.yaml') ||
    normalized.endsWith('/q4h.yaml') ||
    normalized.endsWith('.jsonl')
  );
}

function readErrorCode(error: unknown): string | undefined {
  for (const current of getErrorChain(error)) {
    if (current instanceof Error) {
      const withCode = current as Error & { code?: unknown; errno?: unknown };
      if (typeof withCode.code === 'string' && withCode.code.trim() !== '') {
        return withCode.code;
      }
      if (typeof withCode.errno === 'string' && withCode.errno.trim() !== '') {
        return withCode.errno;
      }
    }
    if (isRecord(current)) {
      if ('code' in current && typeof current.code === 'string' && current.code.trim() !== '') {
        return current.code;
      }
      if ('errno' in current && typeof current.errno === 'string' && current.errno.trim() !== '') {
        return current.errno;
      }
    }
  }
  return undefined;
}

function buildXcodeBestEmptyResponseGiveUpText(
  providerConfig: ProviderConfig,
  provider: string,
): {
  providerName: string;
  summaryTextI18n: Partial<Record<LanguageCode, string>>;
} {
  const providerName = providerConfig.name.trim().length > 0 ? providerConfig.name : provider;
  const summaryTextI18n: Partial<Record<LanguageCode, string>> = {
    zh:
      `${providerName} 在同一对话上下文中连续返回 empty response。` +
      `Dominds 已在 ${String(XCODE_BEST_EMPTY_RESPONSE_GIVE_UP_THRESHOLD)} 次 empty response 后停止继续重试，因为这通常表示 provider 侧该对话上下文已经卡住；` +
      '如果直接点继续，大概率仍然无法有真实进展；更建议先输入一些新的指令再尝试，或许还有恢复的机会。',
    en:
      `${providerName} returned empty responses repeatedly for the same dialog context. ` +
      `Dominds stopped retrying after ${String(XCODE_BEST_EMPTY_RESPONSE_GIVE_UP_THRESHOLD)} empty responses because this usually means the provider-side conversation ` +
      'context is stuck; simply pressing Continue is still unlikely to make real progress, ' +
      'but trying again with some fresh user instructions may still have a chance to recover.',
  };
  return {
    providerName,
    summaryTextI18n,
  };
}

function createXcodeBestFailureQuirkHandlerSession(
  providerConfig: ProviderConfig,
): LlmFailureQuirkHandlerSession {
  let consecutiveEmptyResponseCount = 0;

  return {
    onFailure(args) {
      const { providerName, summaryTextI18n } = buildXcodeBestEmptyResponseGiveUpText(
        providerConfig,
        args.provider,
      );
      if (args.failure.code === DOMINDS_LLM_EMPTY_RESPONSE_ERROR_CODE) {
        consecutiveEmptyResponseCount += 1;
        if (consecutiveEmptyResponseCount < XCODE_BEST_EMPTY_RESPONSE_GIVE_UP_THRESHOLD) {
          return {
            kind: 'single_retry',
            delayMs: XCODE_BEST_EMPTY_RESPONSE_SINGLE_RETRY_DELAY_MS,
          };
        }

        return {
          kind: 'give_up',
          message:
            `${providerName} returned empty responses repeatedly for the same dialog context; ` +
            'automatic retries were stopped; simply continuing is still unlikely to make real progress, but retrying with some fresh user instructions may still have a chance to recover.',
          summaryTextI18n,
        };
      }

      consecutiveEmptyResponseCount = 0;
      if (isXcodeBestUnexpectedEofFailure(args.failure, args.error)) {
        return {
          kind: 'retry_strategy',
          retryStrategy: 'conservative',
          message: XCODE_BEST_UNEXPECTED_EOF_RETRY_MESSAGE,
        };
      }
      if (isXcodeBestGatewayHtml502Failure(args.failure, args.error)) {
        return {
          kind: 'retry_strategy',
          retryStrategy: 'conservative',
          message: XCODE_BEST_GATEWAY_HTML_502_RETRY_MESSAGE,
        };
      }

      return { kind: 'default' };
    },
  };
}

const FAILURE_QUIRK_HANDLER_FACTORIES: Record<string, LlmFailureQuirkHandlerFactory> = {
  'xcode.best': createXcodeBestFailureQuirkHandlerSession,
};

export function normalizeProviderApiQuirks(providerConfig: ProviderConfig): Set<string> {
  const raw = providerConfig.apiQuirks;
  if (typeof raw === 'string') {
    return raw.trim().length > 0 ? new Set([raw.trim()]) : new Set();
  }
  if (Array.isArray(raw)) {
    return new Set(
      raw.flatMap((entry) => {
        if (typeof entry !== 'string') return [];
        const trimmed = entry.trim();
        return trimmed === '' ? [] : [trimmed];
      }),
    );
  }
  return new Set();
}

export function createLlmFailureQuirkHandlerSession(
  providerConfig: ProviderConfig,
): LlmFailureQuirkHandlerSession | undefined {
  const sessions: LlmFailureQuirkHandlerSession[] = [];
  for (const quirk of normalizeProviderApiQuirks(providerConfig)) {
    const factory = FAILURE_QUIRK_HANDLER_FACTORIES[quirk];
    if (!factory) continue;
    sessions.push(factory(providerConfig));
  }
  if (sessions.length === 0) {
    return undefined;
  }
  return {
    onFailure(args) {
      for (const session of sessions) {
        const handling = session.onFailure(args);
        if (handling.kind !== 'default') {
          return handling;
        }
      }
      return { kind: 'default' };
    },
  };
}
