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
  assert.notEqual(tarballs.length, 0, 'pnpm pack must produce a tarball in the pack directory.');
  return path.join(packDirAbs, tarballs.at(-1) ?? '');
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
  const tmpRootAbs = await fs.mkdtemp(
    path.join(os.tmpdir(), 'dominds-kernel-shell-packed-contract-'),
  );
  const kernelPackDirAbs = path.join(tmpRootAbs, 'kernel-pack');
  const shellPackDirAbs = path.join(tmpRootAbs, 'shell-pack');
  await fs.mkdir(kernelPackDirAbs, { recursive: true });
  await fs.mkdir(shellPackDirAbs, { recursive: true });

  const kernelTarballAbs = await packLocalPackage(
    path.join(domindsRootAbs, 'packages', 'kernel'),
    kernelPackDirAbs,
  );
  const shellTarballAbs = await packLocalPackage(
    path.join(domindsRootAbs, 'packages', 'shell'),
    shellPackDirAbs,
  );

  const kernelEntries = listTarballEntries(kernelTarballAbs);
  const shellEntries = listTarballEntries(shellTarballAbs);
  const kernelPackageJson = readTarballPackageJson(kernelTarballAbs);
  const shellPackageJson = readTarballPackageJson(shellTarballAbs);
  const shellDependencies = expectRecord(shellPackageJson.dependencies, 'packed shell package dependencies');
  const expectedKernelVersion = await readPackageVersion(
    path.join(domindsRootAbs, 'packages', 'kernel', 'package.json'),
    'kernel',
  );

  assert.ok(
    kernelEntries.includes('package/package.json'),
    'Packed kernel tarball must include package.json.',
  );
  assert.ok(
    kernelEntries.includes('package/dist/app-host-contract.js'),
    'Packed kernel tarball must include app-host contract artifact.',
  );
  assert.ok(
    kernelEntries.includes('package/dist/app-json.js'),
    'Packed kernel tarball must include app-json artifact.',
  );
  assert.ok(
    kernelEntries.includes('package/dist/utils/html.js'),
    'Packed kernel tarball must include utils/html export artifact.',
  );
  assert.ok(
    kernelEntries.includes('package/dist/utils/id.js'),
    'Packed kernel tarball must include utils/id export artifact.',
  );
  assert.ok(
    kernelEntries.includes('package/dist/types/language.js'),
    'Packed kernel tarball must include kernel-owned language contract artifact.',
  );
  assert.ok(
    kernelEntries.includes('package/dist/types/wire.js'),
    'Packed kernel tarball must include kernel-owned wire contract artifact.',
  );
  assert.ok(
    kernelEntries.includes('package/dist/types/dialog.js'),
    'Packed kernel tarball must include kernel-owned dialog contract artifact.',
  );
  assert.ok(
    kernelEntries.includes('package/dist/types/storage.js'),
    'Packed kernel tarball must include kernel-owned storage contract artifact.',
  );
  assert.equal(
    kernelPackageJson.dependencies,
    undefined,
    'Packed kernel package must not grow runtime dependencies for its public contract surface.',
  );

  assert.ok(
    shellEntries.includes('package/package.json'),
    'Packed shell tarball must include package.json.',
  );
  assert.ok(
    shellEntries.includes('package/dist/index.js'),
    'Packed shell tarball must include dist/index.js.',
  );
  assert.equal(
    shellEntries.includes('package/dist/cli.js'),
    false,
    'Packed shell tarball must not include dist/cli.js after shell contract shrink.',
  );
  assert.equal(
    shellEntries.includes('package/dist/runtime.js'),
    false,
    'Packed shell tarball must not include dist/runtime.js after shell contract shrink.',
  );
  assert.equal(
    shellEntries.some((entry) => entry.startsWith('package/dist/internal/')),
    false,
    'Packed shell tarball must not include copied dist/internal/** artifacts from the root package.',
  );
  assert.equal(
    shellEntries.includes('package/dist/cli.d.ts'),
    false,
    'Packed shell tarball must not include cli declaration artifacts.',
  );
  assert.equal(
    shellEntries.includes('package/dist/runtime.d.ts'),
    false,
    'Packed shell tarball must not include runtime declaration artifacts.',
  );
  assert.equal(
    shellEntries.includes('package/dist/shell.js'),
    false,
    'Packed shell tarball must not expose legacy dist/shell.js as a public artifact.',
  );
  assert.equal(
    shellDependencies['@longrun-ai/kernel'],
    expectedKernelVersion,
    'Packed shell package must rewrite @longrun-ai/kernel to a concrete publishable version.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
