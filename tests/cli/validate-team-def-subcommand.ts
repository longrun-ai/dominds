import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function withTempRtws(
  files: ReadonlyArray<Readonly<{ relPath: string; content: string }>>,
  run: (tmpDir: string) => void | Promise<void>,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-validate-team-def-'));
  try {
    for (const file of files) {
      const absPath = path.join(tmpDir, file.relPath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, file.content, 'utf8');
    }
    await run(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function runCli(args: string[], cwd: string): ReturnType<typeof spawnSync> {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const cliEntry = path.resolve(repoRoot, 'dominds', 'main', 'cli.ts');
  const tsxCli = require.resolve('tsx/cli');
  return spawnSync(process.execPath, [tsxCli, cliEntry, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

async function main(): Promise<void> {
  await withTempRtws(
    [
      {
        relPath: '.minds/team.yaml',
        content: [
          'members:',
          '  tester:',
          '    name: Tester',
          '    toolsets:',
          '      - sdk_server',
          '',
        ].join('\n'),
      },
      {
        relPath: '.minds/mcp.yaml',
        content: [
          'version: 1',
          'servers:',
          '  sdk_server:',
          '    transport: stdio',
          '    command: node',
          "    args: ['-e', 'setInterval(()=>{}, 1000)']",
          '    tools: { whitelist: [], blacklist: [] }',
          '    transform: []',
          '',
        ].join('\n'),
      },
    ],
    async (tmpDir) => {
      const result = runCli(
        ['-C', tmpDir, 'validate_team_def'],
        path.resolve(__dirname, '..', '..', '..'),
      );
      assert.equal(
        result.status,
        0,
        `validate_team_def should treat deferred MCP toolsets as non-fatal.\nstderr:\n${result.stderr}`,
      );
      assert.match(
        result.stdout,
        /\[DEFERRED\] sdk_server/,
        'stdout should mark MCP-declared unloaded toolsets as DEFERRED',
      );
      assert.match(
        result.stdout,
        /often temporary|temporarily down|service recovers/i,
        'stdout should explain that deferred MCP toolsets are often transient runtime issues',
      );
    },
  );

  await withTempRtws(
    [
      {
        relPath: '.minds/team.yaml',
        content: [
          'members:',
          '  tester:',
          '    name: Tester',
          '    toolsets:',
          '      - definitely_missing_toolset',
          '',
        ].join('\n'),
      },
    ],
    async (tmpDir) => {
      const result = runCli(
        ['-C', tmpDir, 'validate_team_def'],
        path.resolve(__dirname, '..', '..', '..'),
      );
      assert.equal(
        result.status,
        2,
        'validate_team_def should exit 2 on hard team-definition errors',
      );
      assert.match(
        result.stdout,
        /\[MISS\] definitely_missing_toolset/,
        'stdout should mark undeclared toolsets as MISS',
      );
    },
  );

  console.log('validate_team_def subcommand tests: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`validate_team_def subcommand tests: failed: ${message}`);
  process.exit(1);
});
