import type { LanguageCode } from './types/language';
import { normalizeLanguageCode } from './types/language';

let workingLanguage: LanguageCode = 'en';

export type WorkingLanguageSource = 'os' | 'default';

export function getWorkingLanguage(): LanguageCode {
  return workingLanguage;
}

export function setWorkingLanguage(language: LanguageCode): void {
  workingLanguage = language;
}

function normalizeLocaleLike(value: string): string {
  // Examples: "en_US.UTF-8" -> "en-US", "zh_CN" -> "zh-CN"
  const stripped = value.split('.')[0] ?? value;
  return stripped.replace(/_/g, '-');
}

export function detectOsDefaultWorkingLanguage(env: NodeJS.ProcessEnv): LanguageCode | null {
  const candidates: string[] = [];

  const lang = env.LANG;
  if (typeof lang === 'string' && lang.trim() !== '') candidates.push(lang);

  for (const raw of candidates) {
    const normalized = normalizeLocaleLike(raw);
    const parsed = normalizeLanguageCode(normalized);
    if (parsed) return parsed;
  }

  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    const parsed = normalizeLanguageCode(locale);
    if (parsed) return parsed;
  } catch {
    // ignore
  }

  return null;
}

export function resolveWorkingLanguage(options: { env: NodeJS.ProcessEnv }): {
  language: LanguageCode;
  source: WorkingLanguageSource;
} {
  const detected = detectOsDefaultWorkingLanguage(options.env);
  if (detected) return { language: detected, source: 'os' };

  return { language: 'en', source: 'default' };
}
