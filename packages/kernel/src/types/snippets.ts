export type SnippetTemplateSource = 'builtin' | 'rtws' | 'mcp_prompt';

export type SnippetTemplate = {
  id: string;
  name: string;
  description?: string;
  content: string;
  source: SnippetTemplateSource;
  path?: string;
  readonly?: boolean;
  mcpPrompt?: {
    serverId: string;
    promptId: string;
    name: string;
    arguments?: ReadonlyArray<{
      name: string;
      description?: string;
      required?: boolean;
    }>;
  };
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

export type SaveRtwsSnippetTemplateRequest = {
  groupKey: string;
  fileName?: string;
  uiLanguage: 'en' | 'zh';
  name: string;
  description?: string;
  content: string;
};

export type SaveRtwsSnippetTemplateResponse =
  | { success: true; template: SnippetTemplate }
  | { success: false; error: string };

export type CreateRtwsSnippetGroupRequest = {
  title: string;
  uiLanguage: 'en' | 'zh';
};

export type CreateRtwsSnippetGroupResponse =
  | { success: true; groupKey: string }
  | { success: false; error: string };

export type ToolsetManualRequest = {
  toolsetId: string;
  topic?: string;
  topics?: ReadonlyArray<string>;
  uiLanguage: 'en' | 'zh';
};

export type ToolsetManualResponse =
  | { success: true; markdown: string }
  | { success: false; error: string };

export type RenderMcpPromptSnippetRequest = {
  promptId: string;
  arguments?: Record<string, string>;
};

export type RenderMcpPromptSnippetResponse =
  | { success: true; content: string }
  | { success: false; error: string };
