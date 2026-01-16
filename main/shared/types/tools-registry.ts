import type { I18nText } from './i18n';

export type ToolKind = 'func' | 'texter';

export type ToolInfo = {
  name: string;
  kind: ToolKind;
  description?: string;
  descriptionI18n?: I18nText;
};

export type ToolsetInfo = {
  name: string;
  descriptionI18n?: I18nText;
  tools: ToolInfo[];
};

export type ToolsRegistrySnapshot = {
  toolsets: ToolsetInfo[];
  timestamp: string;
};
