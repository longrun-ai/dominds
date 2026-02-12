import * as fs from 'fs';
import * as path from 'path';
import type { Dialog } from '../dialog';
import { getWorkLanguage } from '../shared/runtime-language';
import type { LanguageCode } from '../shared/types/language';
import type { Team } from '../team';
import type { FuncTool, JsonObject } from '../tool';
import { getToolsetMeta, listToolsets } from './registry';

type Topic = 'index' | 'principles' | 'tools' | 'scenarios' | 'errors' | 'all';

const ALL_TOPICS: Topic[] = ['index', 'principles', 'tools', 'scenarios', 'errors'];

const DEFAULT_TOPICS: Topic[] = ['index', 'tools'];

// LoadableTopic excludes 'all' which is a special keyword
type LoadableTopic = 'index' | 'principles' | 'tools' | 'scenarios' | 'errors';

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
          description: 'The toolset ID to show manual for (e.g., "ws_mod", "team-mgmt")',
        },
        topic: {
          type: 'string',
          enum: ['index', 'principles', 'tools', 'scenarios', 'errors', 'all'],
          description: 'Single topic to display',
        },
        topics: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['index', 'principles', 'tools', 'scenarios', 'errors'],
          },
          description: 'Multiple topics to display (union)',
        },
      },
      required: ['toolsetId'],
    },
    argsValidation: 'dominds',
    async call(_dlg: Dialog, _caller: Team.Member, args: JsonObject): Promise<string> {
      const language = getWorkLanguage();

      // Get toolsetId from args
      const toolsetId = args?.toolsetId as string | undefined;
      if (!toolsetId) {
        return language === 'zh'
          ? '请提供 toolsetId 参数。'
          : 'Please provide toolsetId parameter.';
      }

      // Check if the toolset exists
      const meta = getToolsetMeta(toolsetId);
      if (!meta) {
        const availableToolsets = Object.keys(listToolsets()).join(', ');
        return language === 'zh'
          ? `未找到 toolset '${toolsetId}'。可用的 toolsets: ${availableToolsets}`
          : `Toolset '${toolsetId}' not found. Available toolsets: ${availableToolsets}`;
      }

      // Determine which topics to load
      const topicArg = args?.topic as Topic | undefined;
      const topicsArg = args?.topics as Topic[] | undefined;

      let topicsToLoad: LoadableTopic[];
      if (topicArg) {
        if (topicArg === 'all') {
          topicsToLoad = ALL_TOPICS as LoadableTopic[];
        } else {
          topicsToLoad = [topicArg] as LoadableTopic[];
        }
      } else if (topicsArg && topicsArg.length > 0) {
        topicsToLoad = topicsArg as LoadableTopic[];
      } else {
        topicsToLoad = DEFAULT_TOPICS as LoadableTopic[];
      }

      // Load content for each topic
      const sections: string[] = [];
      for (const topic of topicsToLoad) {
        const content = loadToolsetTopicContent(toolsetId, language, topic);
        if (content.trim()) {
          const topicTitle = language === 'zh' ? getTopicTitleZh(topic) : getTopicTitleEn(topic);
          sections.push(`## ${topicTitle}\n\n${content.trim()}`);
        }
      }

      if (sections.length === 0) {
        return language === 'zh'
          ? `该工具集 '${toolsetId}' 暂未配置手册。`
          : `Toolset '${toolsetId}' has no manual configured.`;
      }

      const title =
        language === 'zh' ? `**工具集手册：${toolsetId}**` : `**Toolset manual: ${toolsetId}**`;

      return `${title}\n\n${sections.join('\n\n---\n\n')}`;
    },
  };
}

function loadToolsetTopicContent(
  toolsetName: string,
  language: LanguageCode,
  topic: LoadableTopic,
): string {
  const meta = getToolsetMeta(toolsetName);
  if (!meta?.promptFilesI18n) {
    return '';
  }

  const langKey = language === 'zh' ? 'zh' : 'en';
  const basePath = meta.promptFilesI18n[langKey];
  if (!basePath) {
    return '';
  }

  // Derive the topic file path from the base path
  // e.g., ./prompts/ws_mod/en/index.md -> ./prompts/ws_mod/en/{topic}.md
  const baseDir = path.dirname(basePath);
  const topicFilePath = path.join(baseDir, `${topic}.md`);

  try {
    const absPath = path.resolve(__dirname, topicFilePath);
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
}

function getTopicTitleZh(topic: LoadableTopic): string {
  const titles: Record<LoadableTopic, string> = {
    index: '概述',
    principles: '原则',
    tools: '工具',
    scenarios: '场景',
    errors: '错误处理',
  };
  return titles[topic];
}

function getTopicTitleEn(topic: LoadableTopic): string {
  const titles: Record<LoadableTopic, string> = {
    index: 'Overview',
    principles: 'Principles',
    tools: 'Tools',
    scenarios: 'Scenarios',
    errors: 'Error Handling',
  };
  return titles[topic];
}
