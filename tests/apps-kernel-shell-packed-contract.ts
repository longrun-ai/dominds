import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type PackEntry = Readonly<{ filename?: unknown }>;

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} must be an object.`);
  assert.notEqual(value, null, `${label} must not be null.`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array.`);
  return value as Record<string, unknown>;
}

function parsePackFilename(stdout: string): string {
  const parsed = JSON.parse(stdout) as unknown;
  assert.ok(Array.isArray(parsed), 'npm pack --json must return an array payload.');
  assert.notEqual(parsed.length, 0, 'npm pack --json must report at least one packed artifact.');
  const first = parsed[0] as PackEntry | undefined;
  const record = expectRecord(first, 'npm pack result[0]');
  const filename = record['filename'];
  assert.equal(typeof filename, 'string', 'npm pack result[0].filename must be a string.');
  return filename;
}

function packLocalPackage(packageRootAbs: string, packDirAbs: string): string {
  const stdout = execFileSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirAbs],
    {
      cwd: packageRootAbs,
      encoding: 'utf-8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
      },
    },
  );
  return path.join(packDirAbs, parsePackFilename(stdout));
}

function listTarballEntries(tarballAbs: string): string[] {
  const stdout = execFileSync('tar', ['-tzf', tarballAbs], { encoding: 'utf-8' });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function main(): Promise<void> {
  const domindsRootAbs = path.resolve(__dirname, '..');
  const tmpRootAbs = await fs.mkdtemp(
    path.join(os.tmpdir(), 'dominds-kernel-shell-packed-contract-'),
  );
  const packDirAbs = path.join(tmpRootAbs, 'pack');
  await fs.mkdir(packDirAbs, { recursive: true });

  const kernelTarballAbs = packLocalPackage(
    path.join(domindsRootAbs, 'packages', 'kernel'),
    packDirAbs,
  );
  const shellTarballAbs = packLocalPackage(
    path.join(domindsRootAbs, 'packages', 'shell'),
    packDirAbs,
  );

  const kernelEntries = listTarballEntries(kernelTarballAbs);
  const shellEntries = listTarballEntries(shellTarballAbs);

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
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
