import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

function main(): void {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const cliEntry = path.resolve(repoRoot, 'dominds', 'main', 'cli.ts');
  const tsxCli = require.resolve('tsx/cli');

  const wsReadResult = spawnSync(
    process.execPath,
    [tsxCli, cliEntry, 'man', 'ws_read', '--topic', 'index'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );

  assert.equal(
    wsReadResult.status,
    0,
    `dominds man ws_read should exit 0.\nstderr:\n${wsReadResult.stderr}`,
  );
  assert.match(
    wsReadResult.stdout,
    /\*\*Toolset manual: ws_read\*\*/,
    'stdout should include the manual title',
  );
  assert.match(wsReadResult.stdout, /^### .+/m, 'stdout should include a markdown section heading');
  assert.equal(wsReadResult.stderr, '', 'dominds man ws_read should not write to stderr');

  const teamMgmtResult = spawnSync(process.execPath, [tsxCli, cliEntry, 'man', 'team_mgmt'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(
    teamMgmtResult.status,
    0,
    `dominds man team_mgmt should exit 0.\nstderr:\n${teamMgmtResult.stderr}`,
  );
  assert.match(
    teamMgmtResult.stdout,
    /^# Team Management Manual$/m,
    'team_mgmt stdout should use the dedicated guide renderer',
  );
  assert.doesNotMatch(
    teamMgmtResult.stdout,
    /Missing manual sections/,
    'team_mgmt stdout should not fall back to generic missing-section warnings',
  );
  assert.equal(teamMgmtResult.stderr, '', 'dominds man team_mgmt should not write to stderr');

  const helpResult = spawnSync(process.execPath, [tsxCli, cliEntry, 'man', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(
    helpResult.status,
    0,
    `dominds man --help should exit 0.\nstderr:\n${helpResult.stderr}`,
  );
  assert.match(
    helpResult.stdout,
    /Some toolsets .* additional toolset-specific topic keys/i,
    'man help should mention that some toolsets expose custom topic keys',
  );
}

main();
