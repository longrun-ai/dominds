export type ToolKind = 'func' | 'texter';

export type ToolInfo = {
  name: string;
  kind: ToolKind;
  description?: string;
};

export type ToolsetInfo = {
  name: string;
  tools: ToolInfo[];
};

export type ToolsRegistrySnapshot = {
  toolsets: ToolsetInfo[];
  timestamp: string;
};
