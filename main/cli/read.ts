#!/usr/bin/env node

/**
 * Read subcommand for dominds CLI
 *
 * Usage:
 *   dominds read [options] [<member-id>]
 *
 * Options:
 *   --no-hints           Don't show hints
 *   --only-prompt        Show only system prompt
 *   --only-mem           Show only memories
 *   --audit              Run built-in prompt audit checks
 *   --fail-on-audit-warning  Exit non-zero when audit emits warnings
 *   --find <pattern>     Find case-insensitive text in rendered output
 *   --help               Show help
 */

import { readFile } from 'fs/promises';
import { parseMcpYaml } from '../mcp/config';
import { loadAgentMinds } from '../minds/load';
import { Team } from '../team';
import { listToolsets } from '../tools/registry';

type ReadArgs = Readonly<{
  memberId?: string;
  onlyPrompt: boolean;
  onlyMem: boolean;
  audit: boolean;
  failOnAuditWarning: boolean;
  findPatterns: string[];
}>;

type PromptAuditCheck = Readonly<{
  id: string;
  label: string;
  pass: boolean;
}>;

type PromptAuditDuplicate = Readonly<{
  line: string;
  count: number;
}>;

type PromptAuditReport = Readonly<{
  checks: PromptAuditCheck[];
  duplicates: PromptAuditDuplicate[];
  warnings: string[];
}>;

type McpDeclaredToolsets =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'invalid'; errorText: string }>
  | Readonly<{
      kind: 'loaded';
      declaredServerIds: ReadonlySet<string>;
      invalidServerIds: ReadonlySet<string>;
    }>;

type ToolsetAuditItem = Readonly<{
  toolsetName: string;
  status: 'registered' | 'mcp_declared_unloaded' | 'mcp_declared_invalid' | 'missing';
}>;

type ToolsetAuditReport = Readonly<{
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

function printUsage(): void {
  console.log(
    'Usage: dominds read [<member-id>] [--no-hints] [--only-prompt|--only-mem] [--audit] [--find <pattern>]',
  );
  console.log('');
  console.log('Print agent system prompt and memories with filtering flags.');
  console.log(
    '`--audit` also includes static toolset checks (registry vs `.minds/mcp.yaml` declarations).',
  );
  console.log('When <member-id> is omitted, reads all visible team members.');
  console.log('');
  console.log(
    "Note: rtws (runtime workspace) directory is `process.cwd()`. Use 'dominds -C <dir> read' to run in another rtws.",
  );
  console.log('');
  console.log('Examples:');
  console.log('  dominds read                    # Read all team members');
  console.log('  dominds read developer          # Read specific member');
  console.log('  dominds read --only-prompt      # Show only system prompts');
  console.log('  dominds read --only-mem         # Show only memories');
  console.log('  dominds read --only-prompt --audit');
  console.log('  dominds read ux --only-prompt --find "pending Tellask"');
  console.log('  dominds read --only-prompt --audit --fail-on-audit-warning');
}

function normalizeForDuplicateScan(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildPromptAudit(systemPrompt: string): PromptAuditReport {
  const checks: PromptAuditCheck[] = [
    {
      id: 'collaboration_protocol',
      label: 'Has collaboration protocol section',
      pass: /## (Collaboration Protocol|协作协议)/.test(systemPrompt),
    },
    {
      id: 'response_closes_round',
      label: 'Has "response closes call round" rule',
      pass:
        /response closes that call round/.test(systemPrompt) ||
        /收到回贴即表示该轮调用已结束/.test(systemPrompt),
    },
    {
      id: 'pending_wait_guard',
      label: 'Has pending tellask wait guard',
      pass:
        /pending Tellask|pending tellask/.test(systemPrompt) ||
        /存在明确 pending tellask/.test(systemPrompt),
    },
    {
      id: 'relay_ban',
      label: 'Has no-human-relay rule',
      pass: /relay for executable teammate work/.test(systemPrompt) || /转发员/.test(systemPrompt),
    },
    {
      id: 'tellask_function_boundary',
      label: 'Has tellask vs function-calling boundary',
      pass:
        /native function-calling/.test(systemPrompt) &&
        (/is only for tellasking teammates\/freshBootsReasoning\/askHuman/.test(systemPrompt) ||
          /仅用于诉请队友\/freshBootsReasoning\/askHuman/.test(systemPrompt)),
    },
    {
      id: 'fbr_phase_contract',
      label: 'Has FBR phase contract',
      pass: /FBR phase contract|FBR 阶段协议/.test(systemPrompt),
    },
    {
      id: 'taskdoc_encapsulation',
      label: 'Has Taskdoc encapsulation section',
      pass:
        /Taskdoc encapsulation & access restrictions/.test(systemPrompt) ||
        /差遣牒.*封装/.test(systemPrompt),
    },
  ];

  const hasDomindsRuntime = /Dominds runtime|genuine Codex CLI/.test(systemPrompt);
  const hasCodexHostIdentity =
    /You are GPT-5\.2 running in the Codex CLI/.test(systemPrompt) ||
    /^You are Codex CLI\.$/m.test(systemPrompt);

  const toolSectionMarkers = ['\n## Intrinsic Tools\n', '\n## 内置工具\n'];
  let duplicateScope = systemPrompt;
  for (const marker of toolSectionMarkers) {
    const idx = duplicateScope.indexOf(marker);
    if (idx >= 0) {
      duplicateScope = duplicateScope.slice(0, idx);
      break;
    }
  }

  const lineCounts = new Map<string, number>();
  const representative = new Map<string, string>();
  for (const rawLine of duplicateScope.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const normalized = normalizeForDuplicateScan(line);
    if (normalized.length < 24) continue;
    lineCounts.set(normalized, (lineCounts.get(normalized) ?? 0) + 1);
    if (!representative.has(normalized)) representative.set(normalized, line);
  }

  const duplicates: PromptAuditDuplicate[] = Array.from(lineCounts.entries())
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([normalized, count]) => ({
      line: representative.get(normalized) ?? normalized,
      count,
    }));

  const warnings: string[] = [];
  for (const check of checks) {
    if (!check.pass) warnings.push(`Missing: ${check.label}`);
  }
  if (hasDomindsRuntime && hasCodexHostIdentity) {
    warnings.push(
      'Potential host identity conflict: both Dominds runtime and Codex host identity text found.',
    );
  }
  if (duplicates.length > 0) {
    warnings.push(`Detected ${duplicates.length} repeated prompt lines (top duplicates shown).`);
  }

  return { checks, duplicates, warnings };
}

function printPromptAudit(report: PromptAuditReport): void {
  process.stdout.write('\n## Prompt Audit\n');
  for (const check of report.checks) {
    const tag = check.pass ? 'OK' : 'MISS';
    process.stdout.write(`- [${tag}] ${check.label}\n`);
  }
  if (report.duplicates.length > 0) {
    process.stdout.write('- Duplicate Lines (top):\n');
    for (const d of report.duplicates) {
      process.stdout.write(`  - x${d.count}: ${d.line}\n`);
    }
  } else {
    process.stdout.write('- Duplicate Lines: none\n');
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

async function readMcpDeclaredToolsets(): Promise<McpDeclaredToolsets> {
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

function buildToolsetAuditReport(params: {
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

function printToolsetAudit(report: ToolsetAuditReport): void {
  process.stdout.write('\n## Toolset Audit\n');
  if (report.mcp.kind === 'missing') {
    process.stdout.write('- MCP config: missing (`.minds/mcp.yaml` not found)\n');
  } else if (report.mcp.kind === 'invalid') {
    process.stdout.write('- MCP config: invalid (`.minds/mcp.yaml` parse/read failed)\n');
  } else {
    process.stdout.write(
      `- MCP config: loaded (declared servers: ${report.mcp.declaredServerIds.size}, invalid server configs: ${report.mcp.invalidServerIds.size})\n`,
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
        const label =
          item.status === 'registered'
            ? 'OK'
            : item.status === 'mcp_declared_unloaded'
              ? 'DEFERRED'
              : item.status === 'mcp_declared_invalid'
                ? 'INVALID'
                : 'MISS';
        process.stdout.write(`  - [${label}] ${item.toolsetName}\n`);
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

function collectFindMatches(
  text: string,
  pattern: string,
): ReadonlyArray<Readonly<{ line: number; text: string }>> {
  const normalizedPattern = pattern.toLowerCase();
  const lines = text.split('\n');
  const matches: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.toLowerCase().includes(normalizedPattern)) {
      matches.push({ line: i + 1, text: line });
      if (matches.length >= 60) break;
    }
  }
  return matches;
}

function printFindResults(
  pattern: string,
  blocks: ReadonlyArray<Readonly<{ name: string; text: string }>>,
): void {
  process.stdout.write(`\n## Find: "${pattern}"\n`);
  let total = 0;
  for (const block of blocks) {
    const matches = collectFindMatches(block.text, pattern);
    if (matches.length === 0) continue;
    total += matches.length;
    process.stdout.write(`- ${block.name} (${matches.length}):\n`);
    for (const match of matches) {
      process.stdout.write(`  - L${match.line}: ${match.text}\n`);
    }
  }
  if (total === 0) {
    process.stdout.write('- no matches\n');
  }
}

function parseArgs(args: string[]): ReadArgs {
  let memberId: string | undefined;
  let onlyPrompt = false;
  let onlyMem = false;
  let audit = false;
  let failOnAuditWarning = false;
  const findPatterns: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--only-prompt') {
      onlyPrompt = true;
    } else if (arg === '--only-mem') {
      onlyMem = true;
    } else if (arg === '--audit') {
      audit = true;
    } else if (arg === '--fail-on-audit-warning') {
      failOnAuditWarning = true;
    } else if (arg === '--find') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error("Option '--find' requires a non-empty pattern argument.");
      }
      findPatterns.push(next);
      i++;
    } else if (arg === '--no-hints') {
      // Deprecated, but keep for compatibility
      console.warn('Warning: --no-hints is deprecated, use --only-prompt or --only-mem instead');
    } else if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    } else if (!memberId) {
      memberId = arg;
    } else {
      throw new Error(`Unexpected argument '${arg}'.`);
    }
  }

  if (onlyPrompt && onlyMem) {
    throw new Error("Options '--only-prompt' and '--only-mem' are mutually exclusive.");
  }

  return {
    memberId,
    onlyPrompt,
    onlyMem,
    audit,
    failOnAuditWarning,
    findPatterns,
  };
}

function resolveTargetMemberIds(team: Team, memberId: string | undefined): string[] {
  if (memberId) return [memberId];
  const visibleIds = Object.values(team.members)
    .filter((m) => m.hidden !== true)
    .map((m) => m.id)
    .sort((a, b) => a.localeCompare(b));
  if (visibleIds.length > 0) return visibleIds;

  const fallback = team.getDefaultResponder();
  if (!fallback) throw new Error('No team members found.');
  return [fallback.id];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let parsed: ReadArgs;
  try {
    parsed = parseArgs(args);
  } catch (err: unknown) {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    printUsage();
    process.exit(1);
    return;
  }

  try {
    const team = await Team.load();
    const targetMemberIds = resolveTargetMemberIds(team, parsed.memberId);
    const isMultiMemberRun = targetMemberIds.length > 1;
    const toolsetAudit = parsed.audit
      ? buildToolsetAuditReport({
          team,
          targetMemberIds,
          mcp: await readMcpDeclaredToolsets(),
        })
      : undefined;

    let auditWarningCount = 0;
    for (let idx = 0; idx < targetMemberIds.length; idx++) {
      const targetMemberId = targetMemberIds[idx];
      const { agent, systemPrompt, memories } = await loadAgentMinds(targetMemberId, undefined, {
        missingToolsetPolicy: parsed.audit ? 'silent' : 'warn',
      });

      const renderedMemoryBlocks: string[] = [];
      for (const mem of memories) {
        if ('content' in mem && typeof mem.content === 'string' && mem.content.trim()) {
          renderedMemoryBlocks.push(mem.content.trim());
        }
      }

      if (isMultiMemberRun) {
        const sep = idx === 0 ? '' : '\n\n';
        process.stdout.write(`${sep}===== @${agent.id} (${agent.name}) =====\n`);
      }

      if (!parsed.onlyMem) {
        process.stdout.write(systemPrompt.trim() + '\n');
      }

      if (!parsed.onlyPrompt) {
        for (const content of renderedMemoryBlocks) {
          process.stdout.write('\n' + content + '\n');
        }
      }

      if (parsed.audit) {
        const report = buildPromptAudit(systemPrompt);
        printPromptAudit(report);
        auditWarningCount += report.warnings.length;
      }

      if (parsed.findPatterns.length > 0) {
        const blocks: Array<{ name: string; text: string }> = [];
        if (!parsed.onlyMem) {
          blocks.push({ name: `@${agent.id}/system_prompt`, text: systemPrompt });
        }
        if (!parsed.onlyPrompt) {
          for (let i = 0; i < renderedMemoryBlocks.length; i++) {
            blocks.push({ name: `@${agent.id}/memory_${i + 1}`, text: renderedMemoryBlocks[i] });
          }
        }
        for (const pattern of parsed.findPatterns) {
          printFindResults(pattern, blocks);
        }
      }
    }

    if (parsed.audit && toolsetAudit) {
      printToolsetAudit(toolsetAudit);
      auditWarningCount += toolsetAudit.warnings.length;
    }

    if (parsed.failOnAuditWarning && auditWarningCount > 0) {
      process.exit(2);
    }
  } catch (err) {
    console.error('Error loading agent minds:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Export main function for use by CLI
export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
