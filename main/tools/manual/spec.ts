import type { LanguageCode } from '../../shared/types/language';

export const MANUAL_TOPICS = ['index', 'principles', 'tools', 'scenarios', 'errors'] as const;

export type ManualTopic = (typeof MANUAL_TOPICS)[number];

export const DEFAULT_MANUAL_TOPICS: readonly ManualTopic[] = ['index', 'tools'];

export type ManualTopicTitle = Readonly<Record<LanguageCode, string>>;

export const MANUAL_TOPIC_TITLES: Readonly<Record<ManualTopic, ManualTopicTitle>> = {
  index: { en: 'Overview', zh: '概述' },
  principles: { en: 'Principles', zh: '原则' },
  tools: { en: 'Tools', zh: '工具' },
  scenarios: { en: 'Scenarios', zh: '场景' },
  errors: { en: 'Error Handling', zh: '错误处理' },
};

export type ManualSpec = Readonly<{
  topics?: readonly ManualTopic[];
  topicTitlesI18n?: Partial<Record<ManualTopic, ManualTopicTitle>>;
  topicFilesI18n?: Partial<Record<LanguageCode, Partial<Record<ManualTopic, string>>>>;
  warnOnMissing?: boolean;
  includeSchemaToolsSection?: boolean;
}>;

export function getManualSpecTopics(spec?: ManualSpec): readonly ManualTopic[] {
  const topics = spec?.topics;
  if (!Array.isArray(topics) || topics.length === 0) {
    return MANUAL_TOPICS;
  }
  return topics;
}

export function getManualTopicTitle(
  topic: ManualTopic,
  language: LanguageCode,
  spec?: ManualSpec,
): string {
  const override = spec?.topicTitlesI18n?.[topic];
  if (override) {
    return override[language];
  }
  return MANUAL_TOPIC_TITLES[topic][language];
}

export function shouldWarnMissingSection(spec?: ManualSpec): boolean {
  return spec?.warnOnMissing ?? true;
}

export function shouldIncludeSchemaToolsSection(spec?: ManualSpec): boolean {
  return spec?.includeSchemaToolsSection ?? true;
}


export function buildStandardManualSpec(options: {
  baseDir: string;
  topics?: readonly ManualTopic[];
  warnOnMissing?: boolean;
  includeSchemaToolsSection?: boolean;
}): ManualSpec {
  const baseDir = stripTrailingSlash(options.baseDir);
  const topics = options.topics && options.topics.length > 0 ? [...options.topics] : [...MANUAL_TOPICS];

  return {
    topics,
    warnOnMissing: options.warnOnMissing ?? true,
    includeSchemaToolsSection: options.includeSchemaToolsSection ?? true,
    topicFilesI18n: {
      en: topicPathsFor(baseDir, 'en'),
      zh: topicPathsFor(baseDir, 'zh'),
    },
  };
}

function topicPathsFor(baseDir: string, language: LanguageCode): Record<ManualTopic, string> {
  return {
    index: `${baseDir}/${language}/index.md`,
    principles: `${baseDir}/${language}/principles.md`,
    tools: `${baseDir}/${language}/tools.md`,
    scenarios: `${baseDir}/${language}/scenarios.md`,
    errors: `${baseDir}/${language}/errors.md`,
  };
}

function stripTrailingSlash(input: string): string {
  return input.replace(/\/+$/g, '');
}
