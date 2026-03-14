import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type PackageJsonShape = Readonly<{
  version?: unknown;
  dependencies?: unknown;
}>;

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} must be an object.`);
  assert.notEqual(value, null, `${label} must not be null.`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array.`);
  return value as Record<string, unknown>;
}

async function packLocalPackage(packageRootAbs: string, packDirAbs: string): Promise<string> {
  execFileSync('pnpm', ['pack', '--pack-destination', packDirAbs], {
    cwd: packageRootAbs,
    encoding: 'utf-8',
    env: {
      ...process.env,
      NODE_OPTIONS: '',
    },
  });
  const entries = await fs.readdir(packDirAbs);
  const tarballs = entries.filter((entry) => entry.endsWith('.tgz')).sort();
  assert.equal(tarballs.length, 1, 'pnpm pack must produce exactly one tarball in the pack directory.');
  return path.join(packDirAbs, tarballs[0]);
}

function listTarballEntries(tarballAbs: string): string[] {
  const stdout = execFileSync('tar', ['-tzf', tarballAbs], { encoding: 'utf-8' });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function readTarballPackageJson(tarballAbs: string): PackageJsonShape {
  const stdout = execFileSync('tar', ['-xOf', tarballAbs, 'package/package.json'], {
    encoding: 'utf-8',
  });
  return JSON.parse(stdout) as PackageJsonShape;
}

async function readPackageVersion(packageJsonAbs: string, label: string): Promise<string> {
  const raw = await fs.readFile(packageJsonAbs, 'utf-8');
  const packageJson = JSON.parse(raw) as PackageJsonShape;
  assert.equal(typeof packageJson.version, 'string', `${label} package.json version must be a string.`);
  return packageJson.version;
}

async function main(): Promise<void> {
  const domindsRootAbs = path.resolve(__dirname, '..');
  const tmpRootAbs = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-root-packed-contract-'));
  const packDirAbs = path.join(tmpRootAbs, 'pack');
  await fs.mkdir(packDirAbs, { recursive: true });

  const tarballAbs = await packLocalPackage(domindsRootAbs, packDirAbs);
  const entries = listTarballEntries(tarballAbs);
  const packedPackageJson = readTarballPackageJson(tarballAbs);
  const packedDependencies = expectRecord(
    packedPackageJson.dependencies,
    'packed root package dependencies',
  );
  const expectedKernelVersion = await readPackageVersion(
    path.join(domindsRootAbs, 'packages', 'kernel', 'package.json'),
    'kernel',
  );
  const expectedShellVersion = await readPackageVersion(
    path.join(domindsRootAbs, 'packages', 'shell', 'package.json'),
    'shell',
  );
  const expectedCodexAuthVersion = await readPackageVersion(
    path.join(domindsRootAbs, 'codex-auth', 'package.json'),
    'codex-auth',
  );

  assert.ok(entries.includes('package/package.json'), 'Packed root tarball must include package.json.');
  assert.ok(entries.includes('package/dist/cli.js'), 'Packed root tarball must include dist/cli.js.');
  assert.ok(entries.includes('package/dist/server.js'), 'Packed root tarball must include dist/server.js.');
  assert.ok(
    entries.includes('package/webapp/dist/index.html'),
    'Packed root tarball must include webapp/dist/index.html for npx dominds WebUI serving.',
  );
  assert.ok(
    entries.some((entry) => entry.startsWith('package/webapp/dist/assets/')),
    'Packed root tarball must include built webapp assets under webapp/dist/assets/.',
  );
  assert.equal(
    entries.some((entry) => entry.startsWith('package/webapp/src/')),
    false,
    'Packed root tarball must not ship webapp source files as runtime assets.',
  );
  assert.equal(
    entries.some((entry) => entry.startsWith('package/main/')),
    false,
    'Packed root tarball must not ship main/ source files in the published runtime artifact.',
  );
  assert.equal(
    packedDependencies['@longrun-ai/kernel'],
    expectedKernelVersion,
    'Packed root package must rewrite @longrun-ai/kernel to a concrete publishable version.',
  );
  assert.equal(
    packedDependencies['@longrun-ai/shell'],
    expectedShellVersion,
    'Packed root package must rewrite @longrun-ai/shell to a concrete publishable version.',
  );
  assert.equal(
    packedDependencies['@longrun-ai/codex-auth'],
    expectedCodexAuthVersion,
    'Packed root package must rewrite @longrun-ai/codex-auth to a concrete publishable version.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
