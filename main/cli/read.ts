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
 *   --audit              Run prompt audit via hidden teammate @fuxi (skip when default LLM unavailable)
 *   --fail-on-audit-warning  Exit non-zero when audit emits warnings
 *   --find <pattern>     Find case-insensitive text in rendered output
 *   --help               Show help
 */

import type { ChatMessage, ProviderConfig } from '../llm/client';
import type { LlmGenerator, LlmStreamReceiver } from '../llm/gen';
import { loadAgentMinds } from '../minds/load';
import { Team } from '../team';
import {
  buildToolsetAuditReport,
  printToolsetAudit,
  readMcpDeclaredToolsets,
} from './team-definition-audit';

type ReadArgs = Readonly<{
  memberId?: string;
  onlyPrompt: boolean;
  onlyMem: boolean;
  audit: boolean;
  failOnAuditWarning: boolean;
  findPatterns: string[];
}>;

type PromptAuditRuntime =
  | Readonly<{
      kind: 'ready';
      auditorId: 'fuxi';
      providerKey: string;
      modelKey: string;
      providerCfg: ProviderConfig;
      llmGen: LlmGenerator;
      auditAgent: Team.Member;
      auditorSystemPrompt: string;
    }>
  | Readonly<{ kind: 'skip'; reason: string }>;

type PromptAuditReport = Readonly<{
  mode: 'fuxi_llm' | 'skipped';
  targetMemberId: string;
  auditorId: 'fuxi';
  providerKey?: string;
  modelKey?: string;
  verdict?: 'PASS' | 'WARN';
  warnings: string[];
  rewriteSuggestion?: string;
  skipReason?: string;
}>;

function printUsage(): void {
  console.log(
    'Usage: dominds read [<member-id>] [--no-hints] [--only-prompt|--only-mem] [--audit] [--find <pattern>]',
  );
  console.log('');
  console.log('Print agent system prompt and memories with filtering flags.');
  console.log(
    '`--audit` runs prompt audit via hidden teammate @fuxi using default LLM config (skips when unavailable), and also includes static toolset checks (registry vs `.minds/mcp.yaml` declarations).',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncateForAuditInput(
  text: string,
  maxChars: number,
): Readonly<{ text: string; truncated: boolean }> {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

async function runFuxiAuditCall(
  runtime: Extract<PromptAuditRuntime, { kind: 'ready' }>,
  userContent: string,
): Promise<string> {
  let output = '';
  let sawFuncCall = false;
  const receiver: LlmStreamReceiver = {
    thinkingStart: async () => {},
    thinkingChunk: async () => {},
    thinkingFinish: async () => {},
    sayingStart: async () => {},
    sayingChunk: async (chunk) => {
      output += chunk;
    },
    sayingFinish: async () => {},
    funcCall: async () => {
      sawFuncCall = true;
    },
  };
  const context: ChatMessage[] = [{ type: 'environment_msg', role: 'user', content: userContent }];
  await runtime.llmGen.genToReceiver(
    runtime.providerCfg,
    runtime.auditAgent,
    runtime.auditorSystemPrompt,
    [],
    {
      dialogSelfId: 'cli-read-audit',
      dialogRootId: 'cli-read-audit',
    },
    context,
    receiver,
    0,
  );
  const trimmed = output.trim();
  if (trimmed.length > 0) return trimmed;
  if (sawFuncCall)
    return '{"verdict":"WARN","warnings":["LLM emitted tool call during prompt audit"],"rewrite":""}';
  return '';
}

function parseFuxiAuditJson(raw: string): Readonly<{
  verdict: 'PASS' | 'WARN';
  warnings: string[];
  rewriteSuggestion?: string;
}> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  const candidate = raw.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const verdictRaw = parsed['verdict'];
  if (verdictRaw !== 'PASS' && verdictRaw !== 'WARN') return null;
  const warningsRaw = parsed['warnings'];
  if (!Array.isArray(warningsRaw)) return null;
  const warnings: string[] = [];
  for (const item of warningsRaw) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    warnings.push(trimmed);
  }
  const rewriteRaw = parsed['rewrite'];
  const rewriteSuggestion =
    typeof rewriteRaw === 'string' && rewriteRaw.trim().length > 0 ? rewriteRaw.trim() : undefined;
  return { verdict: verdictRaw, warnings, rewriteSuggestion };
}

async function preparePromptAuditRuntime(team: Team): Promise<PromptAuditRuntime> {
  const fuxi = team.getMember('fuxi');
  if (!fuxi) {
    return { kind: 'skip', reason: 'Hidden teammate @fuxi is not available in current team.' };
  }

  const providerKey = fuxi.provider ?? team.memberDefaults.provider;
  const modelKey = fuxi.model ?? team.memberDefaults.model;
  if (!providerKey || !modelKey) {
    return {
      kind: 'skip',
      reason:
        'Default LLM provider/model is not configured for @fuxi (resolved from member + member_defaults).',
    };
  }

  let providerCfg: ProviderConfig;
  try {
    const { LlmConfig } = await import('../llm/client');
    const llmCfg = await LlmConfig.load();
    const resolved = llmCfg.getProvider(providerKey);
    if (!resolved) {
      return {
        kind: 'skip',
        reason: `Provider '${providerKey}' is missing in effective LLM config.`,
      };
    }
    if (!resolved.models || !Object.prototype.hasOwnProperty.call(resolved.models, modelKey)) {
      return {
        kind: 'skip',
        reason: `Model '${modelKey}' is not configured under provider '${providerKey}'.`,
      };
    }
    providerCfg = resolved;
  } catch (err: unknown) {
    return {
      kind: 'skip',
      reason: `Failed to load effective LLM config: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (providerCfg.apiType !== 'codex') {
    const envVar = providerCfg.apiKeyEnvVar;
    const envValue = process.env[envVar];
    const envConfigured = typeof envValue === 'string' && envValue.trim().length > 0;
    if (!envConfigured) {
      return {
        kind: 'skip',
        reason: `Provider env var '${envVar}' is not configured (required for non-codex providers).`,
      };
    }
  }

  const { getLlmGenerator } = await import('../llm/gen/registry');
  const llmGen = getLlmGenerator(providerCfg.apiType);
  if (!llmGen) {
    return {
      kind: 'skip',
      reason: `LLM generator not found for apiType='${providerCfg.apiType}'.`,
    };
  }

  let auditorSystemPrompt: string;
  try {
    const minds = await loadAgentMinds('fuxi', undefined, { missingToolsetPolicy: 'silent' });
    auditorSystemPrompt = minds.systemPrompt;
  } catch (err: unknown) {
    return {
      kind: 'skip',
      reason: `Failed to load @fuxi minds: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const auditAgent = new Team.Member({
    id: fuxi.id,
    name: fuxi.name,
    provider: providerKey,
    model: modelKey,
    model_params: fuxi.model_params,
    streaming: fuxi.streaming,
    hidden: true,
    internal_allow_minds: true,
  });

  try {
    const probe = await runFuxiAuditCall(
      {
        kind: 'ready',
        auditorId: 'fuxi',
        providerKey,
        modelKey,
        providerCfg,
        llmGen,
        auditAgent,
        auditorSystemPrompt,
      },
      'Connectivity check for prompt audit. Reply with a short JSON: {"verdict":"PASS","warnings":[],"rewrite":""}',
    );
    if (probe.trim().length === 0) {
      return { kind: 'skip', reason: 'Connectivity probe returned empty response.' };
    }
  } catch (err: unknown) {
    return {
      kind: 'skip',
      reason: `Connectivity probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    kind: 'ready',
    auditorId: 'fuxi',
    providerKey,
    modelKey,
    providerCfg,
    llmGen,
    auditAgent,
    auditorSystemPrompt,
  };
}

async function buildPromptAudit(
  targetMemberId: string,
  systemPrompt: string,
  runtime: PromptAuditRuntime,
): Promise<PromptAuditReport> {
  if (runtime.kind === 'skip') {
    return {
      mode: 'skipped',
      targetMemberId,
      auditorId: 'fuxi',
      warnings: [],
      skipReason: runtime.reason,
    };
  }

  const clipped = truncateForAuditInput(systemPrompt, 28000);
  const userPrompt = [
    '你是隐藏队友 @fuxi。请审计下面候选系统提示词，只关注会导致真实执行偏差/协作风险的问题，忽略纯措辞润色。',
    '只输出 JSON，不要 markdown，不要额外解释。',
    'JSON schema: {"verdict":"PASS|WARN","warnings":["..."],"rewrite":"..."}',
    '- 若没有实质问题：verdict=PASS 且 warnings=[]。',
    '- 若有问题：verdict=WARN，warnings 只列实质问题（最多 5 条）。',
    '- rewrite 提供一段可直接替换的合并改写建议（最多 8 行）。',
    `target_member_id: ${targetMemberId}`,
    `prompt_truncated: ${clipped.truncated ? 'true' : 'false'}`,
    'candidate_system_prompt:',
    clipped.text,
  ].join('\n\n');

  let raw = '';
  try {
    raw = await runFuxiAuditCall(runtime, userPrompt);
  } catch (err: unknown) {
    return {
      mode: 'skipped',
      targetMemberId,
      auditorId: 'fuxi',
      warnings: [],
      skipReason: `@fuxi audit call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = parseFuxiAuditJson(raw);
  if (!parsed) {
    return {
      mode: 'fuxi_llm',
      targetMemberId,
      auditorId: 'fuxi',
      providerKey: runtime.providerKey,
      modelKey: runtime.modelKey,
      verdict: 'WARN',
      warnings: ['@fuxi audit output is not valid JSON as requested'],
      rewriteSuggestion: raw.trim().length > 0 ? raw.trim() : undefined,
    };
  }

  const warnings = parsed.warnings;
  const verdict: 'PASS' | 'WARN' = warnings.length === 0 ? 'PASS' : parsed.verdict;
  return {
    mode: 'fuxi_llm',
    targetMemberId,
    auditorId: 'fuxi',
    providerKey: runtime.providerKey,
    modelKey: runtime.modelKey,
    verdict,
    warnings,
    rewriteSuggestion: parsed.rewriteSuggestion,
  };
}

function printPromptAudit(report: PromptAuditReport): void {
  process.stdout.write('\n## Prompt Audit\n');
  process.stdout.write(`- Target: @${report.targetMemberId}\n`);
  if (report.mode === 'skipped') {
    process.stdout.write('- Mode: skipped (@fuxi audit disabled due to unavailable default LLM)\n');
    process.stdout.write(`- Reason: ${report.skipReason ?? 'unknown'}\n`);
    process.stdout.write('- Warnings: none (audit step skipped)\n');
    return;
  }
  process.stdout.write('- Mode: @fuxi (LLM)\n');
  if (report.providerKey && report.modelKey) {
    process.stdout.write(
      `- Runtime: provider='${report.providerKey}', model='${report.modelKey}'\n`,
    );
  }
  process.stdout.write(`- Verdict: ${report.verdict ?? 'WARN'}\n`);
  if (report.warnings.length > 0) {
    process.stdout.write('- Warnings:\n');
    for (const warning of report.warnings) {
      process.stdout.write(`  - ${warning}\n`);
    }
  } else {
    process.stdout.write('- Warnings: none\n');
  }
  if (report.rewriteSuggestion && report.rewriteSuggestion.trim().length > 0) {
    process.stdout.write('- Suggested Rewrite:\n');
    process.stdout.write(`${report.rewriteSuggestion.trim()}\n`);
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
    const promptAuditRuntime = parsed.audit ? await preparePromptAuditRuntime(team) : undefined;
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
        const report = await buildPromptAudit(
          agent.id,
          systemPrompt,
          promptAuditRuntime ?? {
            kind: 'skip',
            reason: 'Prompt audit runtime was not initialized.',
          },
        );
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
