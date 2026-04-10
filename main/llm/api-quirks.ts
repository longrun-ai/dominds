import type { LanguageCode } from '@longrun-ai/kernel/types/language';
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

function readErrorStatus(error: unknown): number | undefined {
  if (isRecord(error)) {
    if ('status' in error && typeof error.status === 'number') {
      return error.status;
    }
    if ('statusCode' in error && typeof error.statusCode === 'number') {
      return error.statusCode;
    }
    if ('error' in error && isRecord(error.error)) {
      return readErrorStatus(error.error);
    }
  }
  return undefined;
}

function readErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    const trimmed = error.message.trim();
    return trimmed.length > 0 ? trimmed : error.name;
  }
  if (typeof error === 'string') {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (isRecord(error)) {
    if ('message' in error && typeof error.message === 'string') {
      const trimmed = error.message.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
    if ('error' in error && isRecord(error.error)) {
      return readErrorMessage(error.error);
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      '继续调整常规重试策略也无助于恢复。请新开对话继续。',
    en:
      `${providerName} returned empty responses repeatedly for the same dialog context. ` +
      `Dominds stopped retrying after ${String(XCODE_BEST_EMPTY_RESPONSE_GIVE_UP_THRESHOLD)} empty responses because this usually means the provider-side conversation ` +
      'context is stuck; adjusting the normal retry policies will not recover it. ' +
      'Start a new dialog to continue.',
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
            'automatic retries will not help until a new dialog is started.',
          summaryTextI18n,
        };
      }

      consecutiveEmptyResponseCount = 0;
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
