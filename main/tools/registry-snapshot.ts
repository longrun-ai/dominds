import type { ToolInfo, ToolsetInfo } from '../shared/types/tools-registry';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import type { Tool } from '../tool';
import { listToolsets } from './registry';

export type ToolsRegistrySnapshot = {
  toolsets: ToolsetInfo[];
  timestamp: string;
};

export function createToolsRegistrySnapshot(): ToolsRegistrySnapshot {
  const toolsetsRecord = listToolsets();
  const toolsets: ToolsetInfo[] = Object.keys(toolsetsRecord)
    .sort((a, b) => a.localeCompare(b))
    .map((toolsetName) => {
      const tools = toolsetsRecord[toolsetName] ?? [];
      return {
        name: toolsetName,
        tools: tools
          .map(toolToInfo)
          .sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind)),
      };
    });

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
      };
    case 'texter':
      return {
        name: tool.name,
        kind: 'texter',
        description: tool.usageDescription,
      };
    default: {
      const _exhaustive: never = tool;
      return _exhaustive;
    }
  }
}
