export type TaskDocumentSummary = {
  path: string;
  relativePath: string;
  name: string;
  size: number;
  lastModified: string;
};

export type TaskDocumentSuggestion = {
  path: string;
  relativePath: string;
  name: string;
};

export type SearchTaskDocumentSuggestionsResponse =
  | {
      success: true;
      query: string;
      requestKey: string;
      suggestions: TaskDocumentSuggestion[];
      html: string;
    }
  | {
      success: false;
      error: string;
    };
