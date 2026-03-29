import type { LanguageCode } from './language';

export type ProblemSeverity = 'info' | 'warning' | 'error';
export type ProblemI18nText = Partial<Record<LanguageCode, string>>;

export type WorkspaceProblemLifecycle = Readonly<{
  occurredAt?: string;
  resolved?: boolean;
  resolvedAt?: string | null;
}>;

export type WorkspaceProblem =
  | {
      kind: 'mcp_workspace_config_error';
      source: 'mcp';
      id: string;
      severity: 'error';
      timestamp: string;
      message: string;
      messageI18n?: ProblemI18nText;
      detailTextI18n?: ProblemI18nText;
      detail: {
        filePath: string;
        errorText: string;
      };
    }
  | {
      kind: 'team_workspace_config_error';
      source: 'team';
      id: string;
      severity: 'error' | 'warning';
      timestamp: string;
      message: string;
      messageI18n?: ProblemI18nText;
      detailTextI18n?: ProblemI18nText;
      detail: {
        filePath: string;
        errorText: string;
      };
    }
  | {
      kind: 'mcp_server_error';
      source: 'mcp';
      id: string;
      severity: 'info' | 'error';
      timestamp: string;
      message: string;
      messageI18n?: ProblemI18nText;
      detailTextI18n?: ProblemI18nText;
      detail: {
        serverId: string;
        errorText: string;
      };
    }
  | {
      kind: 'mcp_tool_collision';
      source: 'mcp';
      id: string;
      severity: 'warning';
      timestamp: string;
      message: string;
      messageI18n?: ProblemI18nText;
      detailTextI18n?: ProblemI18nText;
      detail: {
        serverId: string;
        toolName: string;
        domindsToolName: string;
      };
    }
  | {
      kind: 'mcp_tool_blacklisted';
      source: 'mcp';
      id: string;
      severity: 'info' | 'warning';
      timestamp: string;
      message: string;
      messageI18n?: ProblemI18nText;
      detailTextI18n?: ProblemI18nText;
      detail: {
        serverId: string;
        toolName: string;
        pattern: string;
      };
    }
  | {
      kind: 'mcp_tool_not_whitelisted';
      source: 'mcp';
      id: string;
      severity: 'info' | 'warning';
      timestamp: string;
      message: string;
      messageI18n?: ProblemI18nText;
      detailTextI18n?: ProblemI18nText;
      detail: {
        serverId: string;
        toolName: string;
        pattern: string;
      };
    }
  | {
      kind: 'mcp_tool_invalid_name';
      source: 'mcp';
      id: string;
      severity: 'warning';
      timestamp: string;
      message: string;
      messageI18n?: ProblemI18nText;
      detailTextI18n?: ProblemI18nText;
      detail: {
        serverId: string;
        toolName: string;
        rule: string;
      };
    }
  | {
      kind: 'llm_provider_rejected_request';
      source: 'llm';
      id: string;
      severity: 'error';
      timestamp: string;
      message: string;
      messageI18n?: ProblemI18nText;
      detailTextI18n?: ProblemI18nText;
      detail: {
        dialogId: string;
        provider: string;
        errorText: string;
      };
    }
  | {
      kind: 'generic_problem';
      source: 'system';
      id: string;
      severity: ProblemSeverity;
      timestamp: string;
      message: string;
      messageI18n?: ProblemI18nText;
      detailTextI18n?: ProblemI18nText;
      detail: {
        text: string;
      };
    };

export type WorkspaceProblemRecord = WorkspaceProblem & WorkspaceProblemLifecycle;

export interface GetProblemsRequest {
  type: 'get_problems';
}

export interface ClearResolvedProblemsRequest {
  type: 'clear_resolved_problems';
}

export interface ClearResolvedProblemsResultMessage {
  type: 'clear_resolved_problems_result';
  removedCount: number;
  timestamp: string;
}

export interface ProblemsSnapshotMessage {
  type: 'problems_snapshot';
  version: number;
  problems: WorkspaceProblemRecord[];
  timestamp: string;
}
