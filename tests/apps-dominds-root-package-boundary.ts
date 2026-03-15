import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

type PackageJsonShape = Readonly<{
  name?: unknown;
  exports?: unknown;
  main?: unknown;
  types?: unknown;
  bin?: unknown;
  private?: unknown;
  files?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  publishConfig?: unknown;
}>;

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} must be an object.`);
  assert.notEqual(value, null, `${label} must not be null.`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array.`);
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  const domindsRootAbs = path.resolve(__dirname, '..');
  await assert.rejects(
    fs.access(path.join(domindsRootAbs, 'main', 'index.ts')),
    'Root/main must not keep a legacy aggregation entry source.',
  );
  const packageJsonText = await fs.readFile(path.join(domindsRootAbs, 'package.json'), 'utf-8');
  const packageJson = JSON.parse(packageJsonText) as PackageJsonShape;
  const exportsField = expectRecord(packageJson.exports, 'dominds root package exports');
  const scriptsField = expectRecord(packageJson.scripts, 'dominds root package scripts');
  const dependenciesField = expectRecord(
    packageJson.dependencies,
    'dominds root package dependencies',
  );
  const publishConfig = expectRecord(
    packageJson.publishConfig,
    'dominds root package publishConfig',
  );

  assert.equal(
    packageJson.name,
    'dominds',
    'Root package name stays dominds for CLI/distribution purposes.',
  );
  assert.equal(
    packageJson.private,
    undefined,
    'Root package must be publishable; do not keep private=true on the distribution package.',
  );
  assert.equal(
    packageJson.main,
    undefined,
    'Root package must not present a formal main import contract anymore.',
  );
  assert.equal(
    packageJson.types,
    undefined,
    'Root package must not present a root types contract anymore.',
  );
  assert.deepEqual(
    Object.keys(exportsField).sort(),
    ['./cli', './package.json'],
    'Root package must only expose CLI-oriented exports after package split.',
  );
  const cliExport = expectRecord(exportsField['./cli'], 'dominds root package ./cli export');
  assert.equal(
    cliExport['require'],
    './dist/cli.js',
    'Root package ./cli export must point at the CLI entry, not shell runtime bridge.',
  );
  assert.equal(
    cliExport['types'],
    './dist/cli.d.ts',
    'Root package ./cli export must point at dist/cli.d.ts.',
  );
  const binField = expectRecord(packageJson.bin, 'dominds root package bin');
  assert.equal(binField['dominds'], 'dist/cli.js', 'Root package may keep the dominds CLI binary.');
  assert.equal(
    dependenciesField['@longrun-ai/kernel'],
    'workspace:*',
    'Root package must keep the kernel workspace edge as the future package split direction.',
  );
  assert.equal(
    dependenciesField['@longrun-ai/shell'],
    'workspace:*',
    'Root package must keep the shell workspace edge as the future package split direction.',
  );
  assert.equal(
    dependenciesField['@longrun-ai/codex-auth'],
    'workspace:*',
    'Root package must keep codex-auth as a workspace-managed publishable dependency.',
  );
  assert.equal(
    scriptsField['prepublishOnly'],
    'node ./scripts/require-pnpm-publish.mjs && pnpm run build',
    'Root package publish flow must go through the shared pnpm publish guard.',
  );
  assert.equal(
    publishConfig['access'],
    'public',
    'Root package publishConfig must keep public access.',
  );
  assert.deepEqual(
    packageJson.files,
    ['dist/**/*', 'webapp/dist/**/*', 'LICENSE', 'README.md', 'README.zh.md', 'package.json'],
    'Root package files must explicitly include the built backend and webapp runtime artifacts.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
