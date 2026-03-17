import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import * as path from 'path';

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

// ---------------------------------------------------------------------------
// Path builders (no hardcoded toolsetId / serverId strings)
// ---------------------------------------------------------------------------

/**
 * Build manual topic file paths for a built-in toolset.
 * Format: `prompts/<toolsetId>/<lang>/<topic>.md`
 *
 * No heuristics — `toolsetId` is an explicit parameter.
 */
export function builtinManualTopicPaths(
  toolsetId: string,
  language: LanguageCode,
): Record<ManualTopic, string> {
  const suffix = language === 'en' ? '.en' : '';
  const langDir = language;
  const baseDir = `prompts/${toolsetId}`;
  return {
    index: path.join(baseDir, langDir, `index${suffix}.md`),
    principles: path.join(baseDir, langDir, `principles${suffix}.md`),
    tools: path.join(baseDir, langDir, `tools${suffix}.md`),
    scenarios: path.join(baseDir, langDir, `scenarios${suffix}.md`),
    errors: path.join(baseDir, langDir, `errors${suffix}.md`),
  };
}

/**
 * Build manual topic file paths for an MCP toolset.
 * Format: `<contentFilePrefix>/<topic>.<lang>.md`
 *
 * `contentFilePrefix` comes directly from the MCP server's mcp.yaml
 * `manual.contentFile` field — no hardcoded serverId paths.
 */
export function mcpManualTopicPaths(
  contentFilePrefix: string,
  language: LanguageCode,
): Record<ManualTopic, string> {
  const prefix = stripTrailingSlash(contentFilePrefix);
  const suffix = language === 'en' ? '.en' : '';
  return {
    index: `${prefix}/index${suffix}.md`,
    principles: `${prefix}/principles${suffix}.md`,
    tools: `${prefix}/tools${suffix}.md`,
    scenarios: `${prefix}/scenarios${suffix}.md`,
    errors: `${prefix}/errors${suffix}.md`,
  };
}

// ---------------------------------------------------------------------------
// Factory functions (selected by call site, not by path inspection)
// ---------------------------------------------------------------------------

/**
 * Build a ManualSpec for a built-in toolset.
 * Calls `builtinManualTopicPaths` internally — no hardcoded path inspection.
 */
export function buildBuiltinManualSpec(
  options?: {
    topics?: readonly ManualTopic[];
    warnOnMissing?: boolean;
    includeSchemaToolsSection?: boolean;
  } & ({ toolsetId: string } | Record<string, never>),
): ManualSpec {
  const topics =
    options?.topics && options.topics.length > 0 ? [...options.topics] : [...MANUAL_TOPICS];
  return {
    topics,
    warnOnMissing: options?.warnOnMissing ?? true,
    includeSchemaToolsSection: options?.includeSchemaToolsSection ?? true,
    topicFilesI18n: {
      en: builtinManualTopicPaths(options?.toolsetId ?? '', 'en'),
      zh: builtinManualTopicPaths(options?.toolsetId ?? '', 'zh'),
    },
  };
}

/**
 * Build a ManualSpec for an MCP toolset.
 * Calls `mcpManualTopicPaths` internally — no hardcoded serverId paths.
 * `contentFilePrefix` is sourced from mcp.yaml `manual.contentFile`.
 */
export function buildMcpManualSpec(
  contentFilePrefix: string,
  options?: {
    topics?: readonly ManualTopic[];
    warnOnMissing?: boolean;
    includeSchemaToolsSection?: boolean;
  },
): ManualSpec {
  const topics =
    options?.topics && options.topics.length > 0 ? [...options.topics] : [...MANUAL_TOPICS];
  return {
    topics,
    warnOnMissing: options?.warnOnMissing ?? true,
    includeSchemaToolsSection: options?.includeSchemaToolsSection ?? true,
    topicFilesI18n: {
      en: mcpManualTopicPaths(contentFilePrefix, 'en'),
      zh: mcpManualTopicPaths(contentFilePrefix, 'zh'),
    },
  };
}

function stripTrailingSlash(input: string): string {
  return input.replace(/\/+$/g, '');
}
