/**
 * Shared language codes (frontend + backend twin).
 *
 * Keep in sync with `dominds/main/shared/types/language.ts`.
 */

export const supportedLanguageCodes = ['en', 'zh'] as const;

export type LanguageCode = (typeof supportedLanguageCodes)[number];

export function isLanguageCode(value: string): value is LanguageCode {
  return (supportedLanguageCodes as readonly string[]).includes(value);
}

export function normalizeLanguageCode(input: string): LanguageCode | null {
  const raw = input.trim();
  if (raw === '') return null;

  const lowered = raw.replace(/_/g, '-').toLowerCase();
  if (lowered === 'en' || lowered.startsWith('en-')) return 'en';
  if (lowered === 'zh' || lowered.startsWith('zh-')) return 'zh';

  return null;
}

export function formatLanguageName(lang: LanguageCode, inLanguage: LanguageCode): string {
  switch (inLanguage) {
    case 'en': {
      return lang === 'en' ? 'English' : 'Simplified Chinese';
    }
    case 'zh': {
      return lang === 'en' ? '英语' : '简体中文';
    }
    default: {
      const _exhaustive: never = inLanguage;
      throw new Error(`Unsupported inLanguage: ${_exhaustive}`);
    }
  }
}
