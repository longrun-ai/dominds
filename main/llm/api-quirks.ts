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

function createXcodeBestFailureQuirkHandlerSession(
  providerConfig: ProviderConfig,
): LlmFailureQuirkHandlerSession {
  let consecutiveEmptyResponseCount = 0;

  return {
    onFailure(args) {
      if (args.failure.code !== DOMINDS_LLM_EMPTY_RESPONSE_ERROR_CODE) {
        consecutiveEmptyResponseCount = 0;
        return { kind: 'default' };
      }

      consecutiveEmptyResponseCount += 1;
      if (consecutiveEmptyResponseCount < XCODE_BEST_EMPTY_RESPONSE_GIVE_UP_THRESHOLD) {
        return {
          kind: 'single_retry',
          delayMs: XCODE_BEST_EMPTY_RESPONSE_SINGLE_RETRY_DELAY_MS,
        };
      }

      const providerName =
        providerConfig.name.trim().length > 0 ? providerConfig.name : args.provider;
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
        kind: 'give_up',
        message:
          `${providerName} returned empty responses repeatedly for the same dialog context; ` +
          'automatic retries will not help until a new dialog is started.',
        summaryTextI18n,
      };
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
