import { isValidProviderToolName } from '../mcp/tool-names';
import { getTextForLanguage } from '../shared/i18n/text';
import { getWorkLanguage } from '../shared/runtime-language';
import type { LanguageCode } from '../shared/types/language';
import type { FuncTool } from '../tool';
import { getToolsetPromptI18n } from './registry';

type ToolsetManualResult = {
  tools: FuncTool[];
  toolNames: string[];
};

export function buildToolsetManualTools(options: {
  toolsetNames: string[];
  existingToolNames: Set<string>;
}): ToolsetManualResult {
  const tools: FuncTool[] = [];
  const toolNames: string[] = [];
  const seen = new Set<string>();

  for (const toolsetName of options.toolsetNames) {
    if (seen.has(toolsetName)) continue;
    seen.add(toolsetName);

    if (!getToolsetPromptI18n(toolsetName)) {
      continue;
    }

    const toolName = `man_${toolsetName}`;
    if (!isValidProviderToolName(toolName)) {
      continue;
    }
    if (options.existingToolNames.has(toolName)) {
      continue;
    }

    const tool = buildToolsetManualTool(toolsetName, toolName);
    tools.push(tool);
    toolNames.push(toolName);
    options.existingToolNames.add(toolName);
  }

  return { tools, toolNames };
}

export function formatToolsetManualIntro(language: LanguageCode, toolNames: string[]): string {
  const names = toolNames.map((name) => `\`${name}\``).join(', ');
  const calls = toolNames.map((name) => `\`${name}({})\``).join(', ');
  if (toolNames.length === 0) {
    return language === 'zh' ? '（无可用 toolset 手册）' : '(no toolset manuals available)';
  }
  return language === 'zh'
    ? `手册：${names}（调用：${calls}）`
    : `Manuals: ${names} (call: ${calls})`;
}

function buildToolsetManualTool(toolsetName: string, toolName: string): FuncTool {
  return {
    type: 'func',
    name: toolName,
    description: `Show manual for toolset '${toolsetName}'.`,
    descriptionI18n: {
      en: `Show manual for toolset '${toolsetName}'.`,
      zh: `查看 toolset '${toolsetName}' 的使用手册。`,
    },
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    argsValidation: 'dominds',
    async call(): Promise<string> {
      const language = getWorkLanguage();
      const promptI18n = getToolsetPromptI18n(toolsetName);
      const prompt = getTextForLanguage({ i18n: promptI18n, fallback: '' }, language).trim();
      if (prompt === '') {
        return language === 'zh'
          ? `未找到 toolset '${toolsetName}' 的说明。`
          : `No manual available for toolset '${toolsetName}'.`;
      }
      const title =
        language === 'zh'
          ? `**toolset 手册：${toolsetName}**`
          : `**Toolset manual: ${toolsetName}**`;
      return `${title}\n\n${prompt}`;
    },
  };
}
