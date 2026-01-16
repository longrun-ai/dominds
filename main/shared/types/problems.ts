export type ProblemSeverity = 'info' | 'warning' | 'error';

export type WorkspaceProblem =
  | {
      kind: 'mcp_workspace_config_error';
      source: 'mcp';
      id: string;
      severity: 'error';
      timestamp: string;
      message: string;
      detail: {
        filePath: string;
        errorText: string;
      };
    }
  | {
      kind: 'mcp_server_error';
      source: 'mcp';
      id: string;
      severity: 'error';
      timestamp: string;
      message: string;
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
      detail: {
        text: string;
      };
    };

export interface GetProblemsRequest {
  type: 'get_problems';
}

export interface ProblemsSnapshotMessage {
  type: 'problems_snapshot';
  version: number;
  problems: WorkspaceProblem[];
  timestamp: string;
}

