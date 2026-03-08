import type { ProviderApiType, ProviderConfig } from '../client';

const DEFAULT_PROVIDER_TOOL_OUTPUT_CHAR_LIMITS: Readonly<Record<ProviderApiType, number>> = {
  codex: 8 * 1024 * 1024,
  openai: 8 * 1024 * 1024,
  'openai-compatible': 4 * 1024 * 1024,
  anthropic: 4 * 1024 * 1024,
  mock: 8 * 1024 * 1024,
};

export type ProviderToolOutputLimitResult = Readonly<{
  text: string;
  truncated: boolean;
  originalChars: number;
  limitChars: number;
}>;

function buildProviderToolOutputSuffix(originalChars: number, limitChars: number): string {
  return `\n[tool_output_truncated_for_provider original_chars=${originalChars} limit_chars=${limitChars}]`;
}

export function resolveProviderToolResultMaxChars(
  providerConfig?: Pick<ProviderConfig, 'apiType' | 'tool_result_max_chars'>,
): number {
  const configured = providerConfig?.tool_result_max_chars;
  if (typeof configured === 'number' && Number.isInteger(configured) && configured > 0) {
    return configured;
  }
  if (!providerConfig) {
    return DEFAULT_PROVIDER_TOOL_OUTPUT_CHAR_LIMITS['openai'];
  }
  return DEFAULT_PROVIDER_TOOL_OUTPUT_CHAR_LIMITS[providerConfig.apiType];
}

export function truncateProviderToolOutputText(
  text: string,
  limitChars = DEFAULT_PROVIDER_TOOL_OUTPUT_CHAR_LIMITS['openai'],
): ProviderToolOutputLimitResult {
  if (text.length <= limitChars) {
    return {
      text,
      truncated: false,
      originalChars: text.length,
      limitChars,
    };
  }

  const suffix = buildProviderToolOutputSuffix(text.length, limitChars);
  if (suffix.length >= limitChars) {
    return {
      text: suffix.slice(0, limitChars),
      truncated: true,
      originalChars: text.length,
      limitChars,
    };
  }

  const keepChars = limitChars - suffix.length;
  return {
    text: `${text.slice(0, keepChars)}${suffix}`,
    truncated: true,
    originalChars: text.length,
    limitChars,
  };
}
