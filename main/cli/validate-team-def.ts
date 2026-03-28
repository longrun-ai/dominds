#!/usr/bin/env node

import { Team } from '../team';
import {
  buildToolsetAuditReport,
  hasHardToolsetAuditFailures,
  printToolsetAudit,
  readMcpDeclaredToolsets,
} from './team-definition-audit';

type ParsedArgs = Readonly<{
  memberId?: string;
}>;

function printUsage(): void {
  console.log('Usage: dominds validate_team_def [<member-id>]');
  console.log('');
  console.log(
    'Validate explicit toolset declarations in `.minds/team.yaml` against the current toolset registry and `.minds/mcp.yaml` declarations.',
  );
  console.log(
    'MCP-declared but currently unloaded toolsets are reported as `DEFERRED` because they are often transient runtime availability issues rather than permanent team-definition errors.',
  );
  console.log('');
  console.log('Exit codes:');
  console.log('  0  No hard definition errors (`OK` / `DEFERRED` only)');
  console.log('  2  Hard definition errors found (`INVALID` / `MISS`)');
  console.log('');
  console.log('Examples:');
  console.log('  dominds validate_team_def');
  console.log('  dominds validate_team_def mentor');
}

function parseArgs(args: string[]): ParsedArgs {
  let memberId: string | undefined;
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option '${arg}'.`);
    }
    if (!memberId) {
      memberId = arg;
      continue;
    }
    throw new Error(`Unexpected argument '${arg}'.`);
  }
  return { memberId };
}

function resolveTargetMemberIds(team: Team, memberId: string | undefined): string[] {
  if (memberId) return [memberId];
  const visibleIds = Object.values(team.members)
    .filter((member) => member.hidden !== true)
    .map((member) => member.id)
    .sort((a, b) => a.localeCompare(b));
  if (visibleIds.length > 0) return visibleIds;

  const fallback = team.getDefaultResponder();
  if (!fallback) throw new Error('No team members found.');
  return [fallback.id];
}

export async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    printUsage();
    process.exit(1);
    return;
  }

  try {
    const team = await Team.load();
    const targetMemberIds = resolveTargetMemberIds(team, parsed.memberId);
    const report = buildToolsetAuditReport({
      team,
      targetMemberIds,
      mcp: await readMcpDeclaredToolsets(),
    });

    process.stdout.write('# Team Definition Validation\n');
    process.stdout.write(
      'This command checks explicit toolset references in `.minds/team.yaml`. `DEFERRED` usually means the toolset is declared through MCP but is not currently loaded; if the MCP service recovers, rerun this command before editing `team.yaml`.\n',
    );
    printToolsetAudit(report, { heading: '## Definition Audit' });

    if (hasHardToolsetAuditFailures(report)) {
      process.exit(2);
    }
  } catch (err: unknown) {
    console.error(
      'Error validating team definition:',
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
