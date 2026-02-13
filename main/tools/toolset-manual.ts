import type { Dialog } from '../dialog';
import { getWorkLanguage } from '../shared/runtime-language';
import type { LanguageCode } from '../shared/types/language';
import type { Team } from '../team';
import type { FuncTool, JsonObject } from '../tool';
import { MANUAL_TOPICS } from './manual/spec';
import { renderToolsetManual } from './manual/render';
import { listToolsets } from './registry';

type ToolsetManualResult = {
  tools: FuncTool[];
  toolNames: string[];
};

export function buildToolsetManualTools(_options: {
  toolsetNames: string[];
  existingToolNames: Set<string>;
}): ToolsetManualResult {
  // Create a single unified `man` function instead of man_xxx series
  const tool: FuncTool = buildManTool();

  return { tools: [tool], toolNames: [tool.name] };
}

export function formatToolsetManualIntro(language: LanguageCode, toolNames: string[]): string {
  const names = toolNames.map((name) => `\`${name}\``).join(', ');
  const calls = toolNames.map((name) => `\`${name}({ "toolsetId": "..." })\``).join(', ');
  if (toolNames.length === 0) {
    return language === 'zh' ? '（无可用手册工具）' : '(no manual tool available)';
  }
  return language === 'zh'
    ? `手册：${names}（调用：${calls}）`
    : `Manuals: ${names} (call: ${calls})`;
}

function buildManTool(): FuncTool {
  const topicEnums = [...MANUAL_TOPICS, 'all'];
  return {
    type: 'func',
    name: 'man',
    description: `Show manual for a toolset. Use 'toolsetId' to specify which toolset. Use 'topic' or 'topics' to select sections.`,
    descriptionI18n: {
      en: `Show manual for a toolset. Use 'toolsetId' to specify which toolset. Use 'topic' or 'topics' to select sections.`,
      zh: `查看工具集的手册。使用 'toolsetId' 指定工具集。使用 'topic' 或 'topics' 选择章节。`,
    },
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        toolsetId: {
          type: 'string',
          description: 'The toolset ID to show manual for. Use without toolsetId to get available toolsets.',
        },
        topic: {
          type: 'string',
          enum: topicEnums,
          description: 'Single topic to display',
        },
        topics: {
          type: 'array',
          items: {
            type: 'string',
            enum: [...MANUAL_TOPICS],
          },
          description: 'Multiple topics to display (union)',
        },
      },
    },
    argsValidation: 'dominds',
    async call(_dlg: Dialog, _caller: Team.Member, args: JsonObject): Promise<string> {
      const language = getWorkLanguage();

      // Get toolsetId from args
      const toolsetId = args?.toolsetId as string | undefined;
      if (!toolsetId) {
        // When no toolsetId is provided, show all available toolsets
        const availableToolsetNames = _caller.listResolvedToolsetNames();
        const list = availableToolsetNames.map((t) => `\`${t}\``).join(', ');
        return language === 'zh'
          ? `可用的工具集：${list}`
          : `Available toolsets: ${list}`;
      }

      // Step 1: Get available toolsets for this caller (dynamic availability)
      const availableToolsetNames = _caller.listResolvedToolsetNames();

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
        const list = availableToolsetNames.map((t) => `\`${t}\``).join(', ');
        return language === 'zh'
          ? `工具集 '${toolsetId}' 暂未配置给您使用。可用工具集：${list}`
          : `Toolset '${toolsetId}' is not available to you. Available toolsets: ${list}`;
      }

      const availableToolNames = new Set(
        _caller
          .listTools({ onMissingToolset: 'silent', onMissingTool: 'silent' })
          .map((tool) => tool.name),
      );

      const rendered = renderToolsetManual({
        toolsetId,
        language,
        request: {
          requestedTopic: typeof args?.topic === 'string' ? (args.topic as string) : undefined,
          requestedTopics: Array.isArray(args?.topics)
            ? (args.topics as unknown[]).filter((entry): entry is string => typeof entry === 'string')
            : undefined,
        },
        availableToolNames,
      });

      if (!rendered.foundToolset) {
        return language === 'zh'
          ? `未找到 toolset '${toolsetId}'。可用的 toolsets: ${Object.keys(listToolsets()).join(', ')}`
          : `Toolset '${toolsetId}' not found. Available toolsets: ${Object.keys(listToolsets()).join(', ')}`;
      }
      return rendered.content;
    },
  };
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
