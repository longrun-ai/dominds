import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { repository } from './consumer';

export type PeerCall = {
  command: string;
  args: string[];
  cwd: string;
  managed: boolean;
  npmInjectedConfig: string | null;
  packageName?: string;
  archiveSha256?: string;
  cacheStillPresent?: boolean | null;
  unexpected?: boolean;
};
export type PeerOptions = {
  loggedIn?: boolean;
  failPublish?: boolean;
  publishedDrift?: boolean;
  behind?: boolean;
  failVerification?: boolean;
};
export async function withReleaseFixture(
  action: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-release-fixture-'));
  try {
    await action(await createFixture(directory));
  } catch (error) {
    console.error(`Release fixture retained: ${directory}`);
    throw error;
  }
  if (process.env.DOMINDS_TEST_RTWS_KEEP_TMP !== '1')
    await fs.rm(directory, { recursive: true, force: true });
}
async function createFixture(directory: string) {
  const workspace = path.join(directory, 'workspace');
  const bin = path.join(directory, 'bin');
  await fs.mkdir(path.join(workspace, 'scripts'), { recursive: true });
  await fs.mkdir(bin);
  for (const file of [
    'publish-public-packages.mjs',
    'verify-packed-public-package.mjs',
    'require-pnpm-publish.mjs',
  ])
    await fs.copyFile(
      path.join(repository, 'scripts', file),
      path.join(workspace, 'scripts', file),
    );
  for (const file of ['.gitignore', 'pnpm-workspace.yaml'])
    await fs.copyFile(path.join(repository, file), path.join(workspace, file));
  const packages: { root: string; name: string; version: string }[] = [];
  for (const relative of ['codex-auth', 'packages/kernel', 'packages/shell', '.']) {
    const source = path.join(repository, relative, 'package.json');
    const manifest = JSON.parse(await fs.readFile(source, 'utf8'));
    const root = path.join(workspace, relative);
    await fs.mkdir(root, { recursive: true });
    await fs.copyFile(source, path.join(root, 'package.json'));
    await fs.writeFile(path.join(root, 'artifact.txt'), `artifact-data-${manifest.name}`);
    packages.push({ root, name: manifest.name as string, version: manifest.version as string });
  }
  // A closed executable search path prevents these scenarios from reaching real npm/pnpm.
  for (const tool of ['git', 'tar', 'gzip']) {
    const executable = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], {
      encoding: 'utf8',
    }).trim();
    await fs.symlink(executable, path.join(bin, tool));
  }
  await fs.symlink(process.execPath, path.join(bin, 'node'));
  for (const tool of ['npm', 'pnpm']) {
    const target = path.join(bin, tool);
    await fs.copyFile(path.join(__dirname, 'publish-peer.cjs'), target);
    await fs.chmod(target, 0o755);
  }
  const git = (args: string[]) =>
    execFileSync(
      path.join(bin, 'git'),
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', workspace, ...args],
      { encoding: 'utf8' },
    ).trim();
  git(['init', '-q', '--initial-branch=main']);
  const commit = () => {
    git(['add', '-A']);
    git([
      '-c',
      'user.name=Test Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    return git(['rev-parse', 'HEAD']);
  };
  commit();
  const callFile = path.join(directory, 'calls.jsonl');
  await fs.writeFile(path.join(directory, 'registry.json'), '{}');
  await fs.writeFile(
    path.join(directory, 'config.json'),
    JSON.stringify({ packages, options: {} }),
  );
  const environment = {
    ...process.env,
    PATH: bin,
    NODE_OPTIONS: '',
    NODE_PATH: '',
    DOMINDS_PUBLISH_FIXTURE: directory,
    npm_config_fixture_probe: 'synthetic-forwarding-data',
  };
  async function invoke(
    options: PeerOptions,
    args: string[] = [],
    entry = 'release:publish-public',
  ) {
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ packages, options }));
    await fs.writeFile(callFile, '');
    const manifest = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'));
    const declaredCommand = manifest.scripts?.[entry];
    assert.equal(typeof declaredCommand, 'string');
    const result = spawnSync(
      '/bin/sh',
      ['-c', `${declaredCommand} "$@"`, 'fixture-entry', ...args],
      { cwd: workspace, env: environment, encoding: 'utf8', timeout: 15000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    const calls: PeerCall[] = (await fs.readFile(callFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(calls.every((call) => call.unexpected !== true));
    return { ...result, calls };
  }
  async function prepublish(index: number, userAgent: string, managed: string) {
    await fs.writeFile(callFile, '');
    const pkg = packages[index]!;
    const manifest = JSON.parse(await fs.readFile(path.join(pkg.root, 'package.json'), 'utf8'));
    assert.equal(typeof manifest.scripts?.prepublishOnly, 'string');
    const result = spawnSync('/bin/sh', ['-c', manifest.scripts.prepublishOnly], {
      cwd: pkg.root,
      env: {
        ...environment,
        npm_config_user_agent: userAgent,
        DOMINDS_PUBLIC_PUBLISH_FLOW: managed,
      },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    const calls: PeerCall[] = (await fs.readFile(callFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(calls.every((call) => call.unexpected !== true));
    return { ...result, calls };
  }
  return {
    directory,
    workspace,
    packages,
    invoke,
    prepublish,
    git,
    commit,
    cache: path.join(workspace, '.release-pack'),
  };
}
