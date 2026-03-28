import { readFile } from 'fs/promises';

import { parseMcpYaml } from '../mcp/config';
import { Team } from '../team';
import { listToolsets } from '../tools/registry';

export type McpDeclaredToolsets =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'invalid'; errorText: string }>
  | Readonly<{
      kind: 'loaded';
      declaredServerIds: ReadonlySet<string>;
      invalidServerIds: ReadonlySet<string>;
    }>;

export type ToolsetAuditItem = Readonly<{
  toolsetName: string;
  status: 'registered' | 'mcp_declared_unloaded' | 'mcp_declared_invalid' | 'missing';
}>;

export type ToolsetAuditReport = Readonly<{
  mcp: McpDeclaredToolsets;
  byMember: ReadonlyArray<
    Readonly<{
      memberId: string;
      memberName: string;
      items: ReadonlyArray<ToolsetAuditItem>;
    }>
  >;
  warnings: string[];
}>;

function listExplicitToolsets(member: Team.Member): string[] {
  if (!member.toolsets) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of member.toolsets) {
    if (entry === '*' || entry.startsWith('!')) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

export async function readMcpDeclaredToolsets(): Promise<McpDeclaredToolsets> {
  const mcpPath = '.minds/mcp.yaml';
  let raw: string;
  try {
    raw = await readFile(mcpPath, 'utf8');
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      return { kind: 'missing' };
    }
    return { kind: 'invalid', errorText: err instanceof Error ? err.message : String(err) };
  }

  const parsed = parseMcpYaml(raw);
  if (!parsed.ok) {
    return { kind: 'invalid', errorText: parsed.errorText };
  }

  return {
    kind: 'loaded',
    declaredServerIds: new Set(parsed.serverIdsInYamlOrder),
    invalidServerIds: new Set(parsed.invalidServers.map((s) => s.serverId)),
  };
}

export function buildToolsetAuditReport(params: {
  team: Team;
  targetMemberIds: ReadonlyArray<string>;
  mcp: McpDeclaredToolsets;
}): ToolsetAuditReport {
  const registeredToolsets = new Set(Object.keys(listToolsets()));
  const byMember: Array<{ memberId: string; memberName: string; items: ToolsetAuditItem[] }> = [];
  const warnings: string[] = [];

  for (const memberId of params.targetMemberIds) {
    const member = params.team.getMember(memberId);
    if (!member) continue;
    const explicitToolsets = listExplicitToolsets(member);
    const items: ToolsetAuditItem[] = [];
    for (const toolsetName of explicitToolsets) {
      if (registeredToolsets.has(toolsetName)) {
        items.push({ toolsetName, status: 'registered' });
        continue;
      }

      if (params.mcp.kind === 'loaded' && params.mcp.declaredServerIds.has(toolsetName)) {
        if (params.mcp.invalidServerIds.has(toolsetName)) {
          items.push({ toolsetName, status: 'mcp_declared_invalid' });
          warnings.push(
            `@${member.id}: toolset '${toolsetName}' is declared in mcp.yaml but server config is invalid.`,
          );
        } else {
          items.push({ toolsetName, status: 'mcp_declared_unloaded' });
        }
        continue;
      }

      items.push({ toolsetName, status: 'missing' });
      warnings.push(
        `@${member.id}: toolset '${toolsetName}' is neither registered nor declared in mcp.yaml.`,
      );
    }

    byMember.push({ memberId: member.id, memberName: member.name, items });
  }

  if (params.mcp.kind === 'invalid') {
    warnings.push(
      `Invalid .minds/mcp.yaml; cannot reliably classify unresolved MCP toolsets: ${params.mcp.errorText}`,
    );
  }

  return {
    mcp: params.mcp,
    byMember,
    warnings,
  };
}

function countByStatus(
  report: ToolsetAuditReport,
): Readonly<Record<ToolsetAuditItem['status'], number>> {
  const counts = {
    registered: 0,
    mcp_declared_unloaded: 0,
    mcp_declared_invalid: 0,
    missing: 0,
  };
  for (const memberReport of report.byMember) {
    for (const item of memberReport.items) {
      counts[item.status] += 1;
    }
  }
  return counts;
}

function statusLabel(status: ToolsetAuditItem['status']): string {
  if (status === 'registered') return 'OK';
  if (status === 'mcp_declared_unloaded') return 'DEFERRED';
  if (status === 'mcp_declared_invalid') return 'INVALID';
  return 'MISS';
}

export function hasHardToolsetAuditFailures(report: ToolsetAuditReport): boolean {
  if (report.mcp.kind === 'invalid') return true;
  return report.byMember.some((memberReport) =>
    memberReport.items.some(
      (item) => item.status === 'mcp_declared_invalid' || item.status === 'missing',
    ),
  );
}

export function printToolsetAudit(
  report: ToolsetAuditReport,
  options?: Readonly<{ heading?: string; includeTransientLegend?: boolean }>,
): void {
  const heading = options?.heading ?? '## Toolset Audit';
  const counts = countByStatus(report);

  process.stdout.write(`\n${heading}\n`);
  if (report.mcp.kind === 'missing') {
    process.stdout.write('- MCP config: missing (`.minds/mcp.yaml` not found)\n');
  } else if (report.mcp.kind === 'invalid') {
    process.stdout.write('- MCP config: invalid (`.minds/mcp.yaml` parse/read failed)\n');
  } else {
    process.stdout.write(
      `- MCP config: loaded (declared servers: ${report.mcp.declaredServerIds.size}, invalid server configs: ${report.mcp.invalidServerIds.size})\n`,
    );
  }
  process.stdout.write(
    `- Summary: ${counts.registered} OK, ${counts.mcp_declared_unloaded} DEFERRED, ${counts.mcp_declared_invalid} INVALID, ${counts.missing} MISS\n`,
  );
  if (options?.includeTransientLegend !== false) {
    process.stdout.write(
      '- Status notes: `DEFERRED` means the toolset is declared via `.minds/mcp.yaml` but is not currently loaded into the registry. This is often temporary (for example MCP server down/unreachable); if the MCP service recovers, rerun validation and it may clear without editing `team.yaml`.\n',
    );
    process.stdout.write(
      '- Status notes: `INVALID` means the MCP server declaration itself is invalid and needs a config fix. `MISS` means the toolset is neither registered nor declared in `.minds/mcp.yaml`.\n',
    );
  }

  if (report.byMember.length === 0) {
    process.stdout.write('- Members: none\n');
  } else {
    for (const memberReport of report.byMember) {
      process.stdout.write(`- @${memberReport.memberId} (${memberReport.memberName}):\n`);
      if (memberReport.items.length === 0) {
        process.stdout.write('  - no explicit toolset declarations\n');
        continue;
      }
      for (const item of memberReport.items) {
        process.stdout.write(`  - [${statusLabel(item.status)}] ${item.toolsetName}\n`);
      }
    }
  }

  if (report.warnings.length > 0) {
    process.stdout.write('- Warnings:\n');
    for (const warning of report.warnings) {
      process.stdout.write(`  - ${warning}\n`);
    }
  } else {
    process.stdout.write('- Warnings: none\n');
  }
}
