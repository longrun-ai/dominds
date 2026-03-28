import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type { Dialog } from '../dialog';
import { getWorkLanguage } from '../runtime/work-language';
import { Team } from '../team';
import type { FuncTool, JsonObject } from '../tool';
import { renderToolsetManual } from './manual/render';
import { MANUAL_TOPICS, type ManualTopic } from './manual/spec';
import { getToolsetMeta, listToolsets } from './registry';
import { renderTeamMgmtGuideContent } from './team_mgmt';

const MANUAL_OUTPUT_CHAR_LIMIT = 8_000;

type ToolsetManualResult = {
  tools: FuncTool[];
  toolNames: string[];
};

export type RenderToolsetManualContentInput = Readonly<{
  toolsetId: string;
  language: LanguageCode;
  topic?: string;
  topics?: readonly string[];
  availableToolNames: Set<string>;
}>;

export function buildToolsetManualTools(_options: {
  toolsetNames: string[];
  existingToolNames: Set<string>;
}): ToolsetManualResult {
  // Create a single unified `man` function instead of man_xxx series
  const tool: FuncTool = buildManTool();

  return { tools: [tool], toolNames: [tool.name] };
}

export async function renderToolsetManualContent(
  input: RenderToolsetManualContentInput,
): Promise<string> {
  if (input.toolsetId === 'team_mgmt') {
    return renderManualResult(
      input.language,
      input.toolsetId,
      await renderTeamMgmtGuideViaManualRequest(input.language, {
        topic: input.topic,
        topics: input.topics,
      }),
    );
  }

  const rendered = renderToolsetManual({
    toolsetId: input.toolsetId,
    language: input.language,
    request: {
      requestedTopic: input.topic,
      requestedTopics: input.topics,
    },
    availableToolNames: input.availableToolNames,
  });

  if (!rendered.foundToolset) {
    return renderManualResult(
      input.language,
      input.toolsetId,
      input.language === 'zh'
        ? `未找到 toolset '${input.toolsetId}'。可用的 toolsets: ${Object.keys(listToolsets()).join(', ')}`
        : `Toolset '${input.toolsetId}' not found. Available toolsets: ${Object.keys(listToolsets()).join(', ')}`,
    );
  }
  return renderManualResult(input.language, input.toolsetId, rendered.content);
}

function renderManualResult(language: LanguageCode, toolsetId: string, content: string): string {
  if (content.length <= MANUAL_OUTPUT_CHAR_LIMIT) {
    return content;
  }
  return language === 'zh'
    ? [
        '# Tool Manual',
        '',
        `当前请求的 \`${toolsetId}\` 手册内容过长（${content.length} chars），本次不直接截断正文，以免说明语义残缺。`,
        '请按业务章节缩小范围后再读，例如只请求一个 topic，或改用更少的 topics。',
        `示例：\`man({ "toolsetId": "${toolsetId}", "topic": "tools" })\``,
        `示例：\`man({ "toolsetId": "${toolsetId}", "topics": ["principles","errors"] })\``,
      ].join('\n')
    : [
        '# Tool Manual',
        '',
        `The requested manual content for \`${toolsetId}\` is too large (${content.length} chars). This tool does not hard-cut the prose body because that would damage the manual's meaning.`,
        'Narrow the request by business section instead: ask for one topic, or a smaller set of topics.',
        `Example: \`man({ "toolsetId": "${toolsetId}", "topic": "tools" })\``,
        `Example: \`man({ "toolsetId": "${toolsetId}", "topics": ["principles","errors"] })\``,
      ].join('\n');
}

function getToolsetDescription(language: LanguageCode, toolsetId: string): string {
  const meta = getToolsetMeta(toolsetId);
  const description = meta?.descriptionI18n;
  if (!description) {
    return language === 'zh' ? '工具集说明暂缺' : 'No description available';
  }
  return description[language] ?? description.en ?? description.zh ?? '';
}

function formatToolsetEntry(
  language: LanguageCode,
  toolsetId: string,
  includeCall: boolean,
): string {
  const description = getToolsetDescription(language, toolsetId);
  const endsWithSentencePunctuation =
    description.endsWith('。') ||
    description.endsWith('.') ||
    description.endsWith('!') ||
    description.endsWith('！');
  if (language === 'zh') {
    return includeCall
      ? `- \`${toolsetId}\`：${description}${endsWithSentencePunctuation ? '' : '。'}查看详情：\`man({ "toolsetId": "${toolsetId}" })\``
      : `- \`${toolsetId}\`：${description}`;
  }
  return includeCall
    ? `- \`${toolsetId}\`: ${description}${endsWithSentencePunctuation ? '' : '.'} Details: \`man({ "toolsetId": "${toolsetId}" })\``
    : `- \`${toolsetId}\`: ${description}`;
}

function formatToolsetEntries(
  language: LanguageCode,
  toolsetIds: readonly string[],
  includeCall: boolean,
): string {
  if (toolsetIds.length === 0) {
    return language === 'zh' ? '（当前无可用工具集）' : '(no toolsets currently available)';
  }
  return toolsetIds
    .map((toolsetId) => formatToolsetEntry(language, toolsetId, includeCall))
    .join('\n');
}

function formatToolsetIdList(language: LanguageCode, toolsetIds: readonly string[]): string {
  if (toolsetIds.length === 0) {
    return language === 'zh' ? '（当前无可用工具集）' : '(no toolsets currently available)';
  }
  return toolsetIds.map((toolsetId) => `- \`${toolsetId}\``).join('\n');
}

export function formatToolsetManualIntro(
  language: LanguageCode,
  toolNames: string[],
  toolsetIds: readonly string[],
): string {
  const names = toolNames.map((name) => `\`${name}\``).join(', ');
  if (toolNames.length === 0) {
    return language === 'zh' ? '（无可用手册工具）' : '(no manual tool available)';
  }
  if (language === 'zh') {
    return [
      `手册工具：${names}`,
      '可用工具集：',
      formatToolsetEntries(language, toolsetIds, true),
      '何时查阅手册：当某个工具集的功能边界、参数写法、典型场景或报错处理不确定时，调用 `man` 查看详情。',
    ].join('\n');
  }
  return [
    `Manual tool: ${names}`,
    'Available toolsets:',
    formatToolsetEntries(language, toolsetIds, true),
    'When to read the manual: call `man` when a toolset’s boundaries, argument shape, typical scenarios, or error handling are unclear.',
  ].join('\n');
}

function buildManTool(): FuncTool {
  const topicEnums = [...MANUAL_TOPICS, 'all'];
  return {
    type: 'func',
    name: 'man',
    description: `Show manual for a toolset. Use without 'toolsetId' to list available toolsets. Use 'toolsetId' to inspect one toolset and 'topic' or 'topics' to select sections.`,
    descriptionI18n: {
      en: `Show manual for a toolset. Use without 'toolsetId' to list available toolsets. Use 'toolsetId' to inspect one toolset and 'topic' or 'topics' to select sections.`,
      zh: `查看工具集手册。不带 'toolsetId' 时列出可用工具集；带上 'toolsetId' 时查看单个工具集；使用 'topic' 或 'topics' 选择章节。`,
    },
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        toolsetId: {
          type: 'string',
          description:
            'The toolset ID to show manual for. Use without toolsetId to get available toolsets.',
        },
        topic: {
          type: 'string',
          description: `Single topic to display. Standard topics: ${topicEnums.join(', ')}. Some toolsets may accept additional toolset-specific topic keys.`,
        },
        topics: {
          type: 'array',
          items: {
            type: 'string',
          },
          description:
            'Multiple topics to display (union). Standard topics are index/principles/tools/scenarios/errors; some toolsets may accept additional toolset-specific topic keys.',
        },
      },
    },
    argsValidation: 'dominds',
    async call(_dlg: Dialog, _caller: Team.Member, args: JsonObject): Promise<string> {
      const language =
        typeof _dlg?.getLastUserLanguageCode === 'function'
          ? _dlg.getLastUserLanguageCode()
          : getWorkLanguage();
      const dynamicToolsetNames = await Team.listDynamicToolsetNamesForMember({
        member: _caller,
        taskDocPath: _dlg.taskDocPath,
      });

      // Get toolsetId from args
      const toolsetId = args?.toolsetId as string | undefined;
      if (!toolsetId) {
        // When no toolsetId is provided, show all available toolsets
        const availableToolsetNames = _caller.listResolvedToolsetNames({ dynamicToolsetNames });
        if (language === 'zh') {
          return [
            '**可用工具集**',
            '',
            formatToolsetIdList(language, availableToolsetNames),
            '',
            '提示：当某个工具集的功能边界、参数写法、场景示例或错误处理不确定时，继续调用 `man({ "toolsetId": "<toolset>" })` 查看详情。',
          ].join('\n');
        }
        return [
          '**Available toolsets**',
          '',
          formatToolsetIdList(language, availableToolsetNames),
          '',
          'Hint: when a toolset’s boundaries, argument shape, scenarios, or error handling are unclear, call `man({ "toolsetId": "<toolset>" })` for details.',
        ].join('\n');
      }

      // Step 1: Get available toolsets for this caller (dynamic availability)
      const availableToolsetNames = _caller.listResolvedToolsetNames({ dynamicToolsetNames });

      // Find closest match for fuzzy matching
      const allToolsets = Object.keys(listToolsets());
      const suggestion = findClosestToolset(toolsetId, allToolsets);

      // Step 2: Check if the toolset is available for this caller
      if (!availableToolsetNames.includes(toolsetId)) {
        // Toolset is not available for this user
        if (suggestion && availableToolsetNames.includes(suggestion)) {
          // The suggested toolset IS available, user might have meant that
          return language === 'zh'
            ? `工具集 '${toolsetId}' 暂未配置给您使用。您是否在找：'${suggestion}'？`
            : `Toolset '${toolsetId}' is not available to you. Did you mean: '${suggestion}'?`;
        }
        // No suggestion available, just report unavailability and list available toolsets
        const list = formatToolsetIdList(language, availableToolsetNames);
        return language === 'zh'
          ? `工具集 '${toolsetId}' 暂未配置给您使用。\n\n可用工具集：\n${list}`
          : `Toolset '${toolsetId}' is not available to you.\n\nAvailable toolsets:\n${list}`;
      }

      if (toolsetId === 'team_mgmt') {
        return renderManualResult(
          language,
          toolsetId,
          await renderTeamMgmtGuideViaMan(language, args),
        );
      }

      const availableToolNames = new Set(
        _caller
          .listTools({
            onMissingToolset: 'silent',
            onMissingTool: 'silent',
            dynamicToolsetNames,
          })
          .map((tool) => tool.name),
      );

      return await renderToolsetManualContent({
        toolsetId,
        language,
        topic: typeof args?.topic === 'string' ? (args.topic as string) : undefined,
        topics: Array.isArray(args?.topics)
          ? (args.topics as unknown[]).filter((entry): entry is string => typeof entry === 'string')
          : undefined,
        availableToolNames,
      });
    },
  };
}

const TEAM_MGMT_GUIDE_COMPAT_TOPIC_MAP: Readonly<Record<ManualTopic, readonly string[]>> = {
  index: ['topics'],
  principles: ['team', 'permissions', 'llm', 'mcp', 'minds', 'skills', 'priming', 'env'],
  tools: ['team', 'toolsets', 'llm', 'mcp'],
  scenarios: ['topics', 'team', 'minds', 'skills', 'priming'],
  errors: ['troubleshooting'],
};

function normalizeTeamMgmtGuideTopics(args: JsonObject): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed === '' || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  const pushManualTopic = (topic: ManualTopic): void => {
    const mapped = TEAM_MGMT_GUIDE_COMPAT_TOPIC_MAP[topic] ?? [];
    for (const entry of mapped) {
      push(entry);
    }
  };

  const topicValue = args?.topic;
  if (typeof topicValue === 'string') {
    if (topicValue === 'all') {
      for (const topic of MANUAL_TOPICS) {
        pushManualTopic(topic);
      }
      return out;
    }
    if ((MANUAL_TOPICS as readonly string[]).includes(topicValue)) {
      pushManualTopic(topicValue as ManualTopic);
      return out;
    }
    push(topicValue);
    return out;
  }

  const topicsValue = args?.topics;
  if (Array.isArray(topicsValue) && topicsValue.length > 0) {
    for (const entry of topicsValue) {
      if (typeof entry !== 'string') continue;
      if ((MANUAL_TOPICS as readonly string[]).includes(entry)) {
        pushManualTopic(entry as ManualTopic);
        continue;
      }
      push(entry);
    }
    return out;
  }

  push('topics');
  return out;
}

async function renderTeamMgmtGuideViaMan(
  language: LanguageCode,
  args: JsonObject,
): Promise<string> {
  const topics = normalizeTeamMgmtGuideTopics(args);
  return await renderTeamMgmtGuideContent(language, topics);
}

async function renderTeamMgmtGuideViaManualRequest(
  language: LanguageCode,
  request: Readonly<{ topic?: string; topics?: readonly string[] }>,
): Promise<string> {
  const args: JsonObject = {};
  if (typeof request.topic === 'string') {
    args['topic'] = request.topic;
  }
  if (Array.isArray(request.topics)) {
    args['topics'] = [...request.topics];
  }
  const topics = normalizeTeamMgmtGuideTopics(args);
  return await renderTeamMgmtGuideContent(language, topics);
}

/**
 * Find the closest matching toolset name using substring matching and edit distance.
 * Priority: substring match > edit distance
 */
function findClosestToolset(input: string, toolsets: string[]): string | null {
  if (toolsets.length === 0 || !input) {
    return null;
  }

  // First, try substring match (case-insensitive)
  const lowerInput = input.toLowerCase();
  for (const toolset of toolsets) {
    if (toolset.toLowerCase().includes(lowerInput) || lowerInput.includes(toolset.toLowerCase())) {
      return toolset;
    }
  }

  // Second, try edit distance (Levenshtein distance)
  let bestMatch: string | null = null;
  let bestDistance = Infinity;

  for (const toolset of toolsets) {
    const distance = levenshteinDistance(input.toLowerCase(), toolset.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = toolset;
    }
  }

  // Only suggest if the distance is reasonable (less than half the length of the shorter string)
  if (bestMatch && bestDistance <= Math.min(input.length, bestMatch.length) / 2) {
    return bestMatch;
  }

  return null;
}

/**
 * Calculate Levenshtein distance between two strings.
 */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  // Initialize matrix
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1, // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}
