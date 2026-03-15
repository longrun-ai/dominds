import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

type PackageJsonShape = Readonly<{
  scripts?: unknown;
}>;

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} must be an object.`);
  assert.notEqual(value, null, `${label} must not be null.`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array.`);
  return value as Record<string, unknown>;
}

async function readPackageJson(packageJsonAbs: string): Promise<PackageJsonShape> {
  const raw = await fs.readFile(packageJsonAbs, 'utf-8');
  return JSON.parse(raw) as PackageJsonShape;
}

async function assertPrepublishOnly(
  packageJsonAbs: string,
  expectedCommand: string,
  label: string,
): Promise<void> {
  const packageJson = await readPackageJson(packageJsonAbs);
  const scripts = expectRecord(packageJson.scripts, `${label} scripts`);
  assert.equal(
    scripts['prepublishOnly'],
    expectedCommand,
    `${label} must enforce the shared pnpm-only publish guard before building.`,
  );
}

async function main(): Promise<void> {
  const domindsRootAbs = path.resolve(__dirname, '..');
  await assertPrepublishOnly(
    path.join(domindsRootAbs, 'package.json'),
    'node ./scripts/require-pnpm-publish.mjs && pnpm run build',
    'dominds root package',
  );
  const rootPackageJson = await readPackageJson(path.join(domindsRootAbs, 'package.json'));
  const rootScripts = expectRecord(rootPackageJson.scripts, 'dominds root package scripts');
  assert.equal(
    rootScripts['release:publish-public'],
    'node ./scripts/publish-public-packages.mjs',
    'dominds root package must expose the single-entry ordered public publish script.',
  );
  assert.equal(
    rootScripts['release:publish-public:dry-run'],
    'node ./scripts/publish-public-packages.mjs --dry-run',
    'dominds root package must expose a dry-run variant of the public publish script.',
  );
  assert.equal(
    existsSync(path.join(domindsRootAbs, 'scripts', 'publish-public-packages.mjs')),
    true,
    'dominds root package must keep the public publish script in scripts/.',
  );
  await assertPrepublishOnly(
    path.join(domindsRootAbs, 'packages', 'kernel', 'package.json'),
    'node ../../scripts/require-pnpm-publish.mjs && pnpm run build',
    'kernel package',
  );
  await assertPrepublishOnly(
    path.join(domindsRootAbs, 'packages', 'shell', 'package.json'),
    'node ../../scripts/require-pnpm-publish.mjs && pnpm run build',
    'shell package',
  );
  await assertPrepublishOnly(
    path.join(domindsRootAbs, 'codex-auth', 'package.json'),
    'node ../scripts/require-pnpm-publish.mjs && pnpm run build',
    'codex-auth package',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
