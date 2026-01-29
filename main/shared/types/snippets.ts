export type SnippetTemplateSource = 'builtin' | 'workspace';

export type SnippetTemplate = {
  id: string;
  name: string;
  description?: string;
  content: string;
  source: SnippetTemplateSource;
  path?: string;
};

export type SnippetTemplateGroup = {
  key: string;
  titleI18n: { en: string; zh: string };
  templates: SnippetTemplate[];
};

export type SnippetCatalogResponse =
  | { success: true; groups: SnippetTemplateGroup[] }
  | { success: false; error: string };

export type SnippetTemplatesResponse =
  | { success: true; templates: SnippetTemplate[] }
  | { success: false; error: string };

export type SaveWorkspaceSnippetTemplateRequest = {
  groupKey: string;
  fileName?: string;
  uiLanguage: 'en' | 'zh';
  name: string;
  description?: string;
  content: string;
};

export type SaveWorkspaceSnippetTemplateResponse =
  | { success: true; template: SnippetTemplate }
  | { success: false; error: string };

export type CreateWorkspaceSnippetGroupRequest = {
  title: string;
  uiLanguage: 'en' | 'zh';
};

export type CreateWorkspaceSnippetGroupResponse =
  | { success: true; groupKey: string }
  | { success: false; error: string };

export type TeamMgmtManualRequest = {
  topics?: ReadonlyArray<string>;
  uiLanguage: 'en' | 'zh';
};

export type TeamMgmtManualResponse =
  | { success: true; markdown: string }
  | { success: false; error: string };
