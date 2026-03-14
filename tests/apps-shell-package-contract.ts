import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import * as shellContract from '@longrun-ai/shell';

type PackageJsonShape = Readonly<{
  name?: unknown;
  description?: unknown;
  main?: unknown;
  types?: unknown;
  exports?: unknown;
  bin?: unknown;
  dependencies?: unknown;
}>;

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} must be an object.`);
  assert.notEqual(value, null, `${label} must not be null.`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array.`);
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  const domindsRootAbs = path.resolve(__dirname, '..');
  const packageJsonText = await fs.readFile(
    path.join(domindsRootAbs, 'packages', 'shell', 'package.json'),
    'utf-8',
  );
  const packageJson = JSON.parse(packageJsonText) as PackageJsonShape;
  const exportsField = expectRecord(packageJson.exports, 'shell package.json exports');
  const dependenciesField = expectRecord(
    packageJson.dependencies,
    'shell package.json dependencies',
  );

  assert.equal(packageJson.name, '@longrun-ai/shell', 'Shell package name must stay stable.');
  assert.equal(
    packageJson.description,
    'Dominds shell-facing contract package.',
    'Shell package description must reflect the contract-only role.',
  );
  assert.equal(
    packageJson.main,
    'dist/index.js',
    'Shell package main must point at dist/index.js.',
  );
  assert.equal(
    packageJson.types,
    'src/index.ts',
    'Shell package types must point at src/index.ts so workspace consumers can type-check against the formal package surface before prebuilding dist.',
  );
  assert.equal(
    packageJson.bin,
    undefined,
    'Shell package must not publish the dominds CLI binary.',
  );
  assert.deepEqual(
    Object.keys(exportsField).sort(),
    ['.'],
    'Shell package must expose only the minimal root contract entry.',
  );
  assert.deepEqual(
    Object.keys(dependenciesField).sort(),
    ['@longrun-ai/kernel'],
    'Shell package dependencies must stay minimal.',
  );

  const rootExport = expectRecord(exportsField['.'], 'shell package root export');
  assert.equal(
    rootExport['types'],
    './src/index.ts',
    'Shell package root export must point type consumers at src/index.ts.',
  );
  assert.equal(
    rootExport['require'],
    './dist/index.js',
    'Shell package root export must point at dist/index.js.',
  );
  assert.deepEqual(
    Object.keys(shellContract),
    [],
    'Shell package should currently expose no runtime/CLI named exports.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
