import type {
  DialogDisplayTextI18n,
  DialogInterruptionReason,
  DialogLlmRetryExhaustedReason,
  DialogRetryDisplay,
} from '@longrun-ai/kernel/types/display-state';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';

export function resolveLocalizedText(
  textI18n: DialogDisplayTextI18n,
  language: LanguageCode,
): string {
  const localized = textI18n[language];
  if (typeof localized === 'string' && localized.trim() !== '') {
    return localized.trim();
  }
  const fallback = textI18n.zh ?? textI18n.en;
  if (typeof fallback === 'string' && fallback.trim() !== '') {
    return fallback.trim();
  }
  return '';
}

export function resolveRetryDisplayTitle(
  display: DialogRetryDisplay,
  language: LanguageCode,
): string {
  return resolveLocalizedText(display.titleTextI18n, language);
}

export function resolveRetryDisplaySummary(
  display: DialogRetryDisplay,
  language: LanguageCode,
): string {
  return resolveLocalizedText(display.summaryTextI18n, language);
}

export function formatRetryStoppedReason(
  reason: DialogLlmRetryExhaustedReason,
  language: LanguageCode,
): string {
  const summary = resolveRetryDisplaySummary(reason.display, language);
  const errorText = reason.error.trim();
  if (summary === '') return errorText;
  if (errorText === '') return summary;
  if (language === 'zh') {
    return `${summary}最后错误：${errorText}`;
  }
  return `${summary} Last error: ${errorText}`;
}

export function formatSystemStopReason(
  reason: Extract<DialogInterruptionReason, { kind: 'system_stop' }>,
  language: LanguageCode,
): string {
  const summary =
    reason.i18nStopReason !== undefined
      ? resolveLocalizedText(reason.i18nStopReason, language)
      : '';
  const detail = reason.detail.trim();
  if (summary !== '') {
    return summary;
  }
  return detail;
}
