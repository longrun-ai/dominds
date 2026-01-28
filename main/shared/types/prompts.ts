export type PromptTemplateSource = 'builtin' | 'workspace';

export type PromptTemplate = {
  id: string;
  name: string;
  description?: string;
  content: string;
  source: PromptTemplateSource;
  path?: string;
};

export type PromptTemplateGroup = {
  key: string;
  titleI18n: { en: string; zh: string };
  templates: PromptTemplate[];
};

export type PromptCatalogResponse =
  | { success: true; groups: PromptTemplateGroup[] }
  | { success: false; error: string };

export type PromptTemplatesResponse =
  | { success: true; templates: PromptTemplate[] }
  | { success: false; error: string };

export type SaveWorkspacePromptTemplateRequest = {
  groupKey: string;
  fileName?: string;
  uiLanguage: 'en' | 'zh';
  name: string;
  description?: string;
  content: string;
};

export type SaveWorkspacePromptTemplateResponse =
  | { success: true; template: PromptTemplate }
  | { success: false; error: string };

export type TeamMgmtManualRequest = {
  topics?: ReadonlyArray<string>;
  uiLanguage: 'en' | 'zh';
};

export type TeamMgmtManualResponse =
  | { success: true; markdown: string }
  | { success: false; error: string };
