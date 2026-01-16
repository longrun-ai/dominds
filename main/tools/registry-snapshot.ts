import type { ToolInfo, ToolsetInfo } from '../shared/types/tools-registry';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import type { Tool } from '../tool';
import { getToolsetMeta, toolsetsRegistry } from './registry';

export type ToolsRegistrySnapshot = {
  toolsets: ToolsetInfo[];
  timestamp: string;
};

export function createToolsRegistrySnapshot(): ToolsRegistrySnapshot {
  const toolsets: ToolsetInfo[] = [];
  for (const [toolsetName, tools] of toolsetsRegistry.entries()) {
    const meta = getToolsetMeta(toolsetName);
    const descriptionI18n = meta ? meta.descriptionI18n : undefined;
    toolsets.push({
      name: toolsetName,
      descriptionI18n,
      tools: tools.map(toolToInfo),
    });
  }

  return {
    toolsets,
    timestamp: formatUnifiedTimestamp(new Date()),
  };
}

function toolToInfo(tool: Tool): ToolInfo {
  switch (tool.type) {
    case 'func':
      return {
        name: tool.name,
        kind: 'func',
        description: tool.description,
        descriptionI18n: tool.descriptionI18n,
      };
    case 'texter':
      return {
        name: tool.name,
        kind: 'texter',
        description: tool.usageDescription,
        descriptionI18n: tool.usageDescriptionI18n,
      };
    default: {
      const _exhaustive: never = tool;
      return _exhaustive;
    }
  }
}
