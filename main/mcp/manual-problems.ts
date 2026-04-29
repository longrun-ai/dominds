import type { WorkspaceProblem } from '@longrun-ai/kernel/types/problems';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import YAML from 'yaml';

import { listProblems, reconcileProblemsByPrefix } from '../problems';
import { MANUAL_SINGLE_REQUEST_CHAR_LIMIT } from '../tools/manual/output-limit';
import { renderToolsetManual } from '../tools/manual/render';
import { getToolsetMeta } from '../tools/registry';

const MCP_SERVER_PROBLEM_PREFIX = 'mcp/server/';

export type McpToolsetManualSection = {
  title: string;
  content: string;
};

export type McpToolsetManual = {
  content?: string;
  contentFile?: string;
  sections: ReadonlyArray<McpToolsetManualSection>;
};

export type McpToolsetManualState =
  | { kind: 'missing' }
  | { kind: 'invalid'; errorText: string }
  | { kind: 'present'; manual: McpToolsetManual };

export type McpToolsetManualByServer = {
  manualByServerId: ReadonlyMap<string, McpToolsetManual>;
  invalidByServerId: ReadonlyMap<string, string>;
  warningTextByServerId: ReadonlyMap<string, string>;
};

type ParsedMcpManualField =
  | {
      kind: 'present';
      manual: McpToolsetManual;
      warningText?: string;
    }
  | {
      kind: 'invalid';
      errorText: string;
      warningText?: string;
    };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function emptyMcpToolsetManualByServer(): McpToolsetManualByServer {
  return {
    manualByServerId: new Map(),
    invalidByServerId: new Map(),
    warningTextByServerId: new Map(),
  };
}

export function mcpToolsetManualProblemPrefix(serverId: string): string {
  return `${MCP_SERVER_PROBLEM_PREFIX}${serverId}/toolset_manual_`;
}

export function mcpWorkspaceManualProblemPrefix(): string {
  return 'mcp/workspace_manual_';
}

export function parseMcpManualByServer(rawText: string): McpToolsetManualByServer {
  const manualByServerId = new Map<string, McpToolsetManual>();
  const invalidByServerId = new Map<string, string>();
  const warningTextByServerId = new Map<string, string>();

  let parsedRoot: unknown;
  try {
    parsedRoot = YAML.parse(rawText);
  } catch {
    return { manualByServerId, invalidByServerId, warningTextByServerId };
  }

  if (!isObjectRecord(parsedRoot)) {
    return { manualByServerId, invalidByServerId, warningTextByServerId };
  }

  const serversVal = parsedRoot['servers'];
  if (!isObjectRecord(serversVal)) {
    return { manualByServerId, invalidByServerId, warningTextByServerId };
  }

  for (const [serverId, serverVal] of Object.entries(serversVal)) {
    if (!isObjectRecord(serverVal)) continue;
    const manualVal = serverVal['manual'];
    if (manualVal === undefined || manualVal === null) continue;
    const parsed = parseMcpManualField(serverId, manualVal);
    if (parsed.warningText !== undefined) {
      warningTextByServerId.set(serverId, parsed.warningText);
    }
    if (parsed.kind === 'present') {
      manualByServerId.set(serverId, parsed.manual);
      continue;
    }
    invalidByServerId.set(serverId, parsed.errorText);
  }

  return { manualByServerId, invalidByServerId, warningTextByServerId };
}

function parseMcpManualField(serverId: string, value: unknown): ParsedMcpManualField {
  const fieldPath = `servers.${serverId}.manual`;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') {
      return { kind: 'invalid', errorText: `${fieldPath} must not be empty` };
    }
    return { kind: 'present', manual: { content: text, sections: [] } };
  }

  if (!isObjectRecord(value)) {
    return {
      kind: 'invalid',
      errorText: `${fieldPath} must be either a string, or an object with optional content, contentFile, sections`,
    };
  }

  const supportedKeys = new Set(['content', 'contentFile', 'sections']);
  const unknownKeys = Object.keys(value).filter((key) => !supportedKeys.has(key));
  const warningText =
    unknownKeys.length > 0
      ? `${fieldPath} contains unsupported extra field(s): ${unknownKeys
          .map((key) => `${fieldPath}.${key}`)
          .join(', ')} (only content, contentFile, sections are used)`
      : undefined;

  const contentVal = value['content'];
  let content: string | undefined;
  if (contentVal !== undefined) {
    if (!isNonEmptyString(contentVal)) {
      return {
        kind: 'invalid',
        errorText: `${fieldPath}.content must be a non-empty string when provided`,
        ...(warningText !== undefined ? { warningText } : {}),
      };
    }
    content = contentVal.trim();
  }

  const contentFileVal = value['contentFile'];
  let contentFile: string | undefined;
  if (contentFileVal !== undefined) {
    if (!isNonEmptyString(contentFileVal)) {
      return {
        kind: 'invalid',
        errorText: `${fieldPath}.contentFile must be a non-empty string when provided`,
        ...(warningText !== undefined ? { warningText } : {}),
      };
    }
    contentFile = contentFileVal.trim();
  }

  const sectionsVal = value['sections'];
  const sections: McpToolsetManualSection[] = [];
  if (sectionsVal !== undefined) {
    if (Array.isArray(sectionsVal)) {
      for (let i = 0; i < sectionsVal.length; i++) {
        const sectionVal = sectionsVal[i];
        if (!isObjectRecord(sectionVal)) {
          return {
            kind: 'invalid',
            errorText: `${fieldPath}.sections[${i}] must be an object with title/content non-empty strings`,
            ...(warningText !== undefined ? { warningText } : {}),
          };
        }
        const title = sectionVal['title'];
        const sectionContent = sectionVal['content'];
        if (!isNonEmptyString(title) || !isNonEmptyString(sectionContent)) {
          return {
            kind: 'invalid',
            errorText: `${fieldPath}.sections[${i}] must provide non-empty title/content strings`,
            ...(warningText !== undefined ? { warningText } : {}),
          };
        }
        sections.push({ title: title.trim(), content: sectionContent.trim() });
      }
    } else if (isObjectRecord(sectionsVal)) {
      for (const [sectionTitle, sectionContent] of Object.entries(sectionsVal)) {
        if (!isNonEmptyString(sectionTitle) || !isNonEmptyString(sectionContent)) {
          return {
            kind: 'invalid',
            errorText: `${fieldPath}.sections object entries must be non-empty string -> string`,
            ...(warningText !== undefined ? { warningText } : {}),
          };
        }
        sections.push({ title: sectionTitle.trim(), content: sectionContent.trim() });
      }
    } else {
      return {
        kind: 'invalid',
        errorText: `${fieldPath}.sections must be either [{ title, content }] or { "<title>": "<content>" }`,
        ...(warningText !== undefined ? { warningText } : {}),
      };
    }
  }

  if (content === undefined && contentFile === undefined && sections.length === 0) {
    return {
      kind: 'invalid',
      errorText: `${fieldPath} must provide at least one of content, contentFile, or sections`,
      ...(warningText !== undefined ? { warningText } : {}),
    };
  }

  return {
    kind: 'present',
    manual: { content, contentFile, sections },
    ...(warningText !== undefined ? { warningText } : {}),
  };
}

function buildMcpToolsetManualInvalidProblem(
  serverId: string,
  errorText: string,
): WorkspaceProblem {
  return {
    kind: 'mcp_server_error',
    source: 'mcp',
    id: `${mcpToolsetManualProblemPrefix(serverId)}error`,
    severity: 'error',
    timestamp: formatUnifiedTimestamp(new Date()),
    message: `MCP server '${serverId}' manual declaration is invalid`,
    messageI18n: {
      en: `MCP server '${serverId}' manual declaration is invalid`,
      zh: `MCP server '${serverId}' 的手册声明无效`,
    },
    detailTextI18n: {
      en: errorText,
      zh: errorText,
    },
    detail: { serverId, errorText },
  };
}

function buildMcpToolsetManualUnknownFieldsProblem(
  serverId: string,
  warningText: string,
): WorkspaceProblem {
  return {
    kind: 'mcp_server_error',
    source: 'mcp',
    id: `${mcpToolsetManualProblemPrefix(serverId)}unknown_fields`,
    severity: 'warning',
    timestamp: formatUnifiedTimestamp(new Date()),
    message: `MCP server '${serverId}' manual declaration has unsupported extra fields`,
    messageI18n: {
      en: `MCP server '${serverId}' manual declaration has unsupported extra fields`,
      zh: `MCP server '${serverId}' 的手册声明含有不支持的附加字段`,
    },
    detailTextI18n: {
      en: `${warningText}\nThese extra fields are ignored by the manual loader. Keep only content, contentFile, and sections under \`servers.${serverId}.manual\`.`,
      zh: `${warningText}\n这些附加字段会被手册加载器忽略。请仅在 \`servers.${serverId}.manual\` 下保留 content、contentFile、sections。`,
    },
    detail: { serverId, errorText: warningText },
  };
}

function buildMcpToolsetManualMissingProblem(serverId: string): WorkspaceProblem {
  const errorText = `servers.${serverId}.manual is not configured`;
  return {
    kind: 'mcp_server_error',
    source: 'mcp',
    id: `${mcpToolsetManualProblemPrefix(serverId)}missing`,
    severity: 'warning',
    timestamp: formatUnifiedTimestamp(new Date()),
    message: `MCP server '${serverId}' manual is not configured`,
    messageI18n: {
      en: `MCP server '${serverId}' manual is not configured`,
      zh: `MCP server '${serverId}' 未配置 manual`,
    },
    detailTextI18n: {
      en: [
        `${errorText}. This does not block MCP startup or tool use.`,
        'Dominds can use the standard MCP tool metadata directly, but recommends adding a short overall positioning note under `manual` so the team has shared expectations about use cases, guardrails, and failure handling.',
      ].join('\n'),
      zh: [
        `${errorText}。这不会阻止 MCP 启动或工具使用。`,
        'Dominds 可以直接使用标准 MCP 工具元数据，但仍建议在 `manual` 下补充简短的整体定位说明，让团队对使用场景、安全边界和故障处置有共同预期。',
      ].join('\n'),
    },
    detail: { serverId, errorText },
  };
}

function buildMcpToolsetManualTooLargeProblem(args: {
  serverId: string;
  renderedChars: number;
  limitChars: number;
}): WorkspaceProblem {
  const errorText = `man({ "toolsetId": "${args.serverId}" }) rendered manual exceeds limit (${args.renderedChars} chars > ${args.limitChars} chars)`;
  return {
    kind: 'mcp_server_error',
    source: 'mcp',
    id: `${mcpToolsetManualProblemPrefix(args.serverId)}too_large`,
    severity: 'error',
    timestamp: formatUnifiedTimestamp(new Date()),
    message: `MCP server '${args.serverId}' manual result is too large`,
    messageI18n: {
      en: `MCP server '${args.serverId}' manual result is too large`,
      zh: `MCP server '${args.serverId}' 的手册结果过长`,
    },
    detailTextI18n: {
      en: `${errorText}\nThe actual MCP toolset manual shown to the LLM is too large. Split the handbook by business topic so the default \`man({ "toolsetId": "${args.serverId}" })\` result stays within ${args.limitChars} chars.`,
      zh: `\`man({ "toolsetId": "${args.serverId}" })\` 的实际手册结果过长（${args.renderedChars} chars > ${args.limitChars} chars）\n请按业务主题拆小手册，保证默认 \`man({ "toolsetId": "${args.serverId}" })\` 结果不超过 ${args.limitChars} chars。`,
    },
    detail: { serverId: args.serverId, errorText },
  };
}

function buildMcpWorkspaceManualTooLargeProblem(args: {
  renderedChars: number;
  limitChars: number;
  workspaceManualPath: string;
}): WorkspaceProblem {
  const errorText = `man({ "toolsetId": "team_mgmt", "topics": ["mcp"] }) rendered manual exceeds limit (${args.renderedChars} chars > ${args.limitChars} chars)`;
  return {
    kind: 'mcp_workspace_config_error',
    source: 'mcp',
    id: `${mcpWorkspaceManualProblemPrefix()}team_mgmt_mcp_too_large`,
    severity: 'error',
    timestamp: formatUnifiedTimestamp(new Date()),
    message: 'Rendered MCP handbook topic is too large',
    messageI18n: {
      en: 'Rendered MCP handbook topic is too large',
      zh: 'MCP 手册主题的渲染结果过长',
    },
    detailTextI18n: {
      en: `${errorText}\nThis check measures the final handbook content shown to the LLM. Split MCP handbook content so \`man({ "toolsetId": "team_mgmt", "topics": ["mcp"] })\` stays within ${args.limitChars} chars.`,
      zh: `\`man({ "toolsetId": "team_mgmt", "topics": ["mcp"] })\` 的实际手册结果过长（${args.renderedChars} chars > ${args.limitChars} chars）\n该检查衡量的是最终给 LLM 看的手册内容。请拆小 MCP 手册内容，保证该结果不超过 ${args.limitChars} chars。`,
    },
    detail: { filePath: args.workspaceManualPath, errorText },
  };
}

function measureRenderedToolsetManualRawChars(serverId: string): number | null {
  const meta = getToolsetMeta(serverId);
  if (meta?.source !== 'mcp') return null;
  const zh = renderToolsetManual({
    toolsetId: serverId,
    language: 'zh',
    request: {},
  });
  const en = renderToolsetManual({
    toolsetId: serverId,
    language: 'en',
    request: {},
  });
  if (!zh.foundToolset || !en.foundToolset) return null;
  return Math.max(zh.content.length, en.content.length);
}

export async function reconcileMcpToolsetManualProblems(params: {
  serverIds: ReadonlyArray<string>;
  manualInfo: McpToolsetManualByServer;
  measureRenderedWorkspaceMcpTopicRawChars: () => Promise<number>;
  workspaceManualPath: string;
}): Promise<void> {
  const desiredServerIds = new Set(params.serverIds);
  const stalePrefixes = new Set<string>();
  for (const problem of listProblems({ source: 'mcp' })) {
    const match = problem.id.match(/^(mcp\/server\/[^/]+\/toolset_manual_)/);
    if (!match || typeof match[1] !== 'string') continue;
    const serverId = problem.kind === 'mcp_server_error' ? problem.detail.serverId : null;
    if (serverId !== null && desiredServerIds.has(serverId)) continue;
    stalePrefixes.add(match[1]);
  }
  for (const prefix of stalePrefixes) {
    reconcileProblemsByPrefix(prefix, []);
  }

  const workspaceDesired: WorkspaceProblem[] = [];
  const teamMgmtMcpTopicChars = await params.measureRenderedWorkspaceMcpTopicRawChars();
  if (teamMgmtMcpTopicChars > MANUAL_SINGLE_REQUEST_CHAR_LIMIT) {
    workspaceDesired.push(
      buildMcpWorkspaceManualTooLargeProblem({
        renderedChars: teamMgmtMcpTopicChars,
        limitChars: MANUAL_SINGLE_REQUEST_CHAR_LIMIT,
        workspaceManualPath: params.workspaceManualPath,
      }),
    );
  }
  reconcileProblemsByPrefix(mcpWorkspaceManualProblemPrefix(), workspaceDesired);

  for (const serverId of params.serverIds) {
    const desired: WorkspaceProblem[] = [];
    const invalid = params.manualInfo.invalidByServerId.get(serverId);
    if (invalid !== undefined) {
      desired.push(buildMcpToolsetManualInvalidProblem(serverId, invalid));
    } else if (!params.manualInfo.manualByServerId.has(serverId)) {
      desired.push(buildMcpToolsetManualMissingProblem(serverId));
    }
    const warningText = params.manualInfo.warningTextByServerId.get(serverId);
    if (warningText !== undefined) {
      desired.push(buildMcpToolsetManualUnknownFieldsProblem(serverId, warningText));
    }
    const renderedToolsetManualChars = measureRenderedToolsetManualRawChars(serverId);
    if (
      renderedToolsetManualChars !== null &&
      renderedToolsetManualChars > MANUAL_SINGLE_REQUEST_CHAR_LIMIT
    ) {
      desired.push(
        buildMcpToolsetManualTooLargeProblem({
          serverId,
          renderedChars: renderedToolsetManualChars,
          limitChars: MANUAL_SINGLE_REQUEST_CHAR_LIMIT,
        }),
      );
    }
    reconcileProblemsByPrefix(mcpToolsetManualProblemPrefix(serverId), desired);
  }
}
