import type { DialogStatusKind } from './wire';

export type PrimingScriptScope = 'individual' | 'team_shared';

export type PrimingScriptSummary = {
  ref: string;
  scope: PrimingScriptScope;
  slug: string;
  title?: string;
  path: string;
  updatedAt: string;
  ownerAgentId?: string;
};

export type PrimingScriptLoadWarning = {
  path: string;
  error: string;
};

export type PrimingScriptWarningSummary = {
  skippedCount: number;
  samples: PrimingScriptLoadWarning[];
};

export type ListPrimingScriptsResponse =
  | {
      success: true;
      recent: PrimingScriptSummary[];
      warningSummary?: PrimingScriptWarningSummary;
    }
  | {
      success: false;
      error: string;
    };

export type SearchPrimingScriptsResponse =
  | {
      success: true;
      scripts: PrimingScriptSummary[];
      warningSummary?: PrimingScriptWarningSummary;
    }
  | {
      success: false;
      error: string;
    };

export type SaveCurrentCoursePrimingRequest = {
  dialog: {
    rootId: string;
    selfId: string;
    status?: DialogStatusKind;
  };
  course: number;
  slug: string;
  overwrite?: boolean;
};

export type SaveCurrentCoursePrimingResponse =
  | {
      success: true;
      script: PrimingScriptSummary;
      messageCount: number;
      path: string;
    }
  | {
      success: false;
      error: string;
      errorCode?: 'ALREADY_EXISTS' | 'INVALID_REQUEST' | 'INTERNAL_ERROR';
    };
