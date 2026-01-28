import type { ToolInfo, ToolsetInfo, ToolsRegistrySnapshot } from '../shared/types/tools-registry';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import type { Tool } from '../tool';
import { getToolsetMeta, toolsetsRegistry } from './registry';

export function createToolsRegistrySnapshot(): ToolsRegistrySnapshot {
  const toolsets: ToolsetInfo[] = [];
  for (const [toolsetName, tools] of toolsetsRegistry.entries()) {
    const meta = getToolsetMeta(toolsetName);
    const descriptionI18n = meta ? meta.descriptionI18n : undefined;
    const source = meta?.source ?? 'dominds';
    toolsets.push({
      name: toolsetName,
      source,
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
  return {
    name: tool.name,
    kind: 'func',
    description: tool.description,
    descriptionI18n: tool.descriptionI18n,
  };
}
