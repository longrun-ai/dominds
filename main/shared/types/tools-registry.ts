import type { I18nText } from './i18n';

export type ToolKind = 'func';

export type ToolsetSource = 'dominds' | 'mcp';

export type ToolInfo = {
  name: string;
  kind: ToolKind;
  description?: string;
  descriptionI18n?: I18nText;
};

export type ToolsetInfo = {
  name: string;
  source: ToolsetSource;
  descriptionI18n?: I18nText;
  tools: ToolInfo[];
};

export type ToolsRegistrySnapshot = {
  toolsets: ToolsetInfo[];
  timestamp: string;
};
