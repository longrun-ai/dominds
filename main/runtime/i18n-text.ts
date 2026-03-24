import type { I18nText } from '@longrun-ai/kernel/types/i18n';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';

export function getTextForLanguage(
  value: { i18n?: I18nText; fallback?: string },
  language: LanguageCode,
): string {
  const i18n = value.i18n;
  if (i18n) return i18n[language];
  return value.fallback ?? '';
}
