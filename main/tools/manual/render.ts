import * as fs from 'fs';
import * as path from 'path';
import type { LanguageCode } from '../../shared/types/language';
import type { FuncTool } from '../../tool';
import { getToolset, getToolsetMeta } from '../registry';
import {
  DEFAULT_MANUAL_TOPICS,
  type ManualSpec,
  MANUAL_TOPICS,
  type ManualTopic,
  getManualSpecTopics,
  getManualTopicTitle,
  shouldIncludeSchemaToolsSection,
  shouldWarnMissingSection,
} from './spec';
import { buildSchemaToolsSection } from './schema';

export type ManualRequest = {
  requestedTopic?: string;
  requestedTopics?: readonly string[];
};

export type RenderManualInput = {
  toolsetId: string;
  language: LanguageCode;
  request: ManualRequest;
  availableToolNames: Set<string>;
};

type TopicLoadStatus = 'ok' | 'missing' | 'error';

type TopicContent = {
  topic: ManualTopic;
  title: string;
  body: string;
};

type MissingTopic = {
  topic: ManualTopic;
  filePath: string;
  status: TopicLoadStatus;
};

type TopicLoadResult = {
  status: TopicLoadStatus;
  filePath: string;
  content: string;
};

export type RenderManualResult = {
  foundToolset: boolean;
  content: string;
};

export function renderToolsetManual(input: RenderManualInput): RenderManualResult {
  const meta = getToolsetMeta(input.toolsetId);
  if (!meta) {
    return { foundToolset: false, content: '' };
  }

  const spec = resolveManualSpec(meta.manualSpec, meta.promptFilesI18n);
  const resolvedTopics = resolveRequestedTopics(input.request, spec);
  const topicSections: TopicContent[] = [];
  const missingTopics: MissingTopic[] = [];

  for (const topic of resolvedTopics) {
    const loaded = loadTopicDoc({ toolsetId: input.toolsetId, topic, language: input.language, spec });
    if (loaded.status !== 'ok') {
      if (shouldWarnMissingSection(spec)) {
        missingTopics.push({ topic, filePath: loaded.filePath, status: loaded.status });
      }
      continue;
    }
    const body = sanitizeManualBody(loaded.content);
    if (body === '') {
      if (shouldWarnMissingSection(spec)) {
        missingTopics.push({ topic, filePath: loaded.filePath, status: 'missing' });
      }
      continue;
    }
    topicSections.push({
      topic,
      title: getManualTopicTitle(topic, input.language, spec),
      body,
    });
  }

  if (shouldIncludeSchemaToolsSection(spec) && resolvedTopics.includes('tools')) {
    const schemaSection = buildSchemaSection(input.toolsetId, input.language, input.availableToolNames);
    if (schemaSection !== '') {
      const toolsSection = topicSections.find((section) => section.topic === 'tools');
      if (toolsSection) {
        toolsSection.body = appendSchemaSection(toolsSection.body, schemaSection, input.language);
      }
    }
  }

  const sections: string[] = [];
  if (missingTopics.length > 0) {
    sections.push(renderMissingTopicsWarning(input.language, input.toolsetId, missingTopics));
  }
  for (const section of topicSections) {
    sections.push(`### ${section.title}\n\n${section.body}`);
  }

  if (sections.length === 0) {
    const fallback =
      input.language === 'zh'
        ? `该工具集 '${input.toolsetId}' 暂未配置手册。`
        : `Toolset '${input.toolsetId}' has no manual configured.`;
    return { foundToolset: true, content: fallback };
  }

  const title =
    input.language === 'zh'
      ? `**工具集手册：${input.toolsetId}**`
      : `**Toolset manual: ${input.toolsetId}**`;
  return { foundToolset: true, content: `${title}\n\n${sections.join('\n\n---\n\n')}` };
}

function resolveRequestedTopics(request: ManualRequest, spec?: ManualSpec): ManualTopic[] {
  const allowedTopics = new Set(getManualSpecTopics(spec));
  const topicArg = request.requestedTopic;
  if (topicArg && typeof topicArg === 'string') {
    if (topicArg === 'all') {
      return [...allowedTopics] as ManualTopic[];
    }
    if (isManualTopic(topicArg) && allowedTopics.has(topicArg)) {
      return [topicArg];
    }
  }

  const topicsArg = request.requestedTopics;
  if (Array.isArray(topicsArg) && topicsArg.length > 0) {
    const deduped: ManualTopic[] = [];
    const seen = new Set<ManualTopic>();
    for (const entry of topicsArg) {
      if (!isManualTopic(entry)) continue;
      if (!allowedTopics.has(entry)) continue;
      if (seen.has(entry)) continue;
      seen.add(entry);
      deduped.push(entry);
    }
    if (deduped.length > 0) {
      return deduped;
    }
  }

  const defaults = DEFAULT_MANUAL_TOPICS.filter((topic) => allowedTopics.has(topic));
  if (defaults.length > 0) {
    return [...defaults];
  }
  return [...allowedTopics] as ManualTopic[];
}

function loadTopicDoc(params: {
  toolsetId: string;
  topic: ManualTopic;
  language: LanguageCode;
  spec?: ManualSpec;
}): TopicLoadResult {
  const topicPath = resolveTopicPath(params.toolsetId, params.topic, params.language, params.spec);
  if (!topicPath) {
    return { status: 'missing', filePath: '', content: '' };
  }
  const absPathFromToolsRoot = path.resolve(__dirname, '..', topicPath);
  try {
    const content = fs.readFileSync(absPathFromToolsRoot, 'utf8');
    return { status: 'ok', filePath: topicPath, content };
  } catch (error: unknown) {
    if (isNodeErrno(error, 'ENOENT')) {
      return { status: 'missing', filePath: topicPath, content: '' };
    }
    return { status: 'error', filePath: topicPath, content: '' };
  }
}

function resolveTopicPath(
  toolsetId: string,
  topic: ManualTopic,
  language: LanguageCode,
  spec?: ManualSpec,
): string | null {
  const fromSpec = spec?.topicFilesI18n?.[language]?.[topic];
  if (typeof fromSpec === 'string' && fromSpec.trim() !== '') {
    return fromSpec;
  }

  const meta = getToolsetMeta(toolsetId);
  const basePath = meta?.promptFilesI18n?.[language];
  if (!basePath) {
    return null;
  }
  const baseDir = path.dirname(basePath);
  return path.join(baseDir, `${topic}.md`);
}

function resolveManualSpec(
  spec: ManualSpec | undefined,
  promptFilesI18n: Partial<Record<LanguageCode, string>> | undefined,
): ManualSpec | undefined {
  if (spec) {
    return spec;
  }
  const enBase = promptFilesI18n?.en;
  const zhBase = promptFilesI18n?.zh;
  if (!enBase && !zhBase) {
    return undefined;
  }

  const out: ManualSpec = {
    topics: MANUAL_TOPICS,
    warnOnMissing: true,
    includeSchemaToolsSection: true,
    topicFilesI18n: {
      en: enBase ? topicPathsFromBase(enBase) : undefined,
      zh: zhBase ? topicPathsFromBase(zhBase) : undefined,
    },
  };

  return out;
}

function topicPathsFromBase(baseIndexPath: string): Record<ManualTopic, string> {
  const baseDir = path.dirname(baseIndexPath);
  return {
    index: path.join(baseDir, 'index.md'),
    principles: path.join(baseDir, 'principles.md'),
    tools: path.join(baseDir, 'tools.md'),
    scenarios: path.join(baseDir, 'scenarios.md'),
    errors: path.join(baseDir, 'errors.md'),
  };
}

function buildSchemaSection(
  toolsetId: string,
  language: LanguageCode,
  availableToolNames: Set<string>,
): string {
  const tools = (getToolsetMetaTools(toolsetId) ?? []).filter((tool) => availableToolNames.has(tool.name));
  if (tools.length === 0) {
    return '';
  }
  return buildSchemaToolsSection(language, tools);
}

function getToolsetMetaTools(toolsetId: string): FuncTool[] | null {
  const toolset = getToolset(toolsetId);
  if (!Array.isArray(toolset)) {
    return null;
  }
  const out: FuncTool[] = [];
  for (const tool of toolset) {
    if (tool && typeof tool === 'object' && 'type' in tool && (tool as { type: string }).type === 'func') {
      out.push(tool as FuncTool);
    }
  }
  return out;
}

function renderMissingTopicsWarning(
  language: LanguageCode,
  toolsetId: string,
  missingTopics: readonly MissingTopic[],
): string {
  const header =
    language === 'zh'
      ? `> ⚠️ 手册章节缺失（toolset: \`${toolsetId}\`）`
      : `> ⚠️ Missing manual sections (toolset: \`${toolsetId}\`)`;
  const details = missingTopics
    .map((item) => {
      const label =
        language === 'zh'
          ? item.status === 'error'
            ? '读取失败'
            : '缺失'
          : item.status === 'error'
            ? 'read error'
            : 'missing';
      const pathInfo = item.filePath !== '' ? ` (${item.filePath})` : '';
      return `> - \`${item.topic}\`: ${label}${pathInfo}`;
    })
    .join('\n');
  return [header, details].join('\n');
}

function isManualTopic(value: string): value is ManualTopic {
  return (MANUAL_TOPICS as readonly string[]).includes(value);
}

function isNodeErrno(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === 'string' && maybeCode === code;
}

function sanitizeManualBody(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let skippingTemplate = false;
  let templateHeadingLevel = 0;

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmedStart = line.trimStart();
    const isFence = isFenceLine(trimmedStart);

    if (isFence) {
      inCodeBlock = !inCodeBlock;
      if (!skippingTemplate) {
        out.push(line);
      }
      continue;
    }

    const heading = inCodeBlock ? null : parseHeading(trimmedStart);

    if (skippingTemplate) {
      if (!inCodeBlock && heading && heading.level <= templateHeadingLevel) {
        skippingTemplate = false;
      } else {
        continue;
      }
    }

    if (!inCodeBlock && heading) {
      if (heading.level === 1) {
        continue;
      }
      if (isTemplateHeadingText(heading.text)) {
        skippingTemplate = true;
        templateHeadingLevel = heading.level;
        continue;
      }
      const normalizedLevel = normalizeHeadingLevel(heading.level);
      if (normalizedLevel !== heading.level) {
        const leading = line.slice(0, line.length - trimmedStart.length);
        out.push(`${leading}${'#'.repeat(normalizedLevel)} ${heading.text}`);
        continue;
      }
    }

    out.push(line);
  }

  return out.join('\n').trim();
}

function appendSchemaSection(body: string, schemaSection: string, language: LanguageCode): string {
  const heading = language === 'zh' ? '工具契约（Schema）' : 'Tool Contract (Schema)';
  const normalized = normalizeSchemaSection(schemaSection);
  if (normalized === '') {
    return body;
  }
  const trimmedBody = body.trim();
  if (trimmedBody === '') {
    return `#### ${heading}\n\n${normalized}`;
  }
  return `${trimmedBody}\n\n#### ${heading}\n\n${normalized}`;
}

function normalizeSchemaSection(schemaSection: string): string {
  const lines = schemaSection.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let droppedTitle = false;

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmedStart = line.trimStart();
    const isFence = isFenceLine(trimmedStart);

    if (isFence) {
      inCodeBlock = !inCodeBlock;
      out.push(line);
      continue;
    }

    if (!inCodeBlock && !droppedTitle && trimmedStart.startsWith('## ')) {
      droppedTitle = true;
      continue;
    }

    if (!inCodeBlock && trimmedStart.startsWith('### ')) {
      const leading = line.slice(0, line.length - trimmedStart.length);
      out.push(`${leading}##### ${trimmedStart.slice(4)}`);
      continue;
    }

    out.push(line);
  }

  return out.join('\n').trim();
}

function isFenceLine(trimmedStart: string): boolean {
  return trimmedStart.startsWith('```') || trimmedStart.startsWith('~~~');
}

type HeadingInfo = {
  level: number;
  text: string;
};

function parseHeading(trimmedStart: string): HeadingInfo | null {
  if (!trimmedStart.startsWith('#')) {
    return null;
  }
  const match = /^(#{1,6})\s+(.+)$/.exec(trimmedStart);
  if (!match) {
    return null;
  }
  return { level: match[1].length, text: match[2] ?? '' };
}

function normalizeHeadingLevel(level: number): number {
  if (level <= 3) {
    return 4;
  }
  return level;
}

function isTemplateHeadingText(text: string): boolean {
  const title = text.trimStart();
  if (title.toLowerCase().startsWith('template')) {
    return true;
  }
  return title.startsWith('模板');
}
