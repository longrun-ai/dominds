import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
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

async function writeExecutable(absPath: string, source: string): Promise<void> {
  await fs.writeFile(absPath, source, { encoding: 'utf-8', mode: 0o755 });
}

async function assertPublishScriptFailsBeforePlanWhenNpmLoginMissing(
  domindsRootAbs: string,
): Promise<void> {
  const tempRootAbs = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-public-publish-login-'));
  try {
    const fakeBinAbs = path.join(tempRootAbs, 'bin');
    const callLogAbs = path.join(tempRootAbs, 'calls.log');
    await fs.mkdir(fakeBinAbs, { recursive: true });

    await writeExecutable(
      path.join(fakeBinAbs, 'npm'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLogAbs)}, ['npm', ...args].join(' ') + '\\n');
if (args[0] === 'whoami') {
  process.stderr.write('npm warn Unknown env config "prefer-workspace-packages". This will stop working in the next major version of npm.\\n');
  process.stderr.write('npm warn Unknown env config "link-workspace-packages". This will stop working in the next major version of npm.\\n');
  process.stderr.write('npm error code E401\\n');
  process.stderr.write('npm error 401 Unauthorized - GET https://registry.npmjs.org/-/whoami\\n');
  process.exit(1);
}
process.stderr.write('unexpected npm invocation: ' + args.join(' ') + '\\n');
process.exit(2);
`,
    );
    await writeExecutable(
      path.join(fakeBinAbs, 'pnpm'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLogAbs)}, ['pnpm', ...args].join(' ') + '\\n');
process.exit(99);
`,
    );

    const result = spawnSync(
      'node',
      [path.join(domindsRootAbs, 'scripts', 'publish-public-packages.mjs')],
      {
        cwd: domindsRootAbs,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${fakeBinAbs}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      },
    );

    assert.notEqual(
      result.status,
      0,
      'Publish script must fail immediately when npm login is missing.',
    );
    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.match(
      combinedOutput,
      /npm login is required before publishing public packages\./,
      'Publish script must explain the missing npm login before any publish planning.',
    );
    assert.match(
      combinedOutput,
      /npm login --registry https:\/\/registry\.npmjs\.org\//,
      'Publish script must tell the user how to log in to npm.',
    );
    assert.doesNotMatch(
      combinedOutput,
      /Command failed:/,
      'Publish script must not leak raw exec failure details for missing npm login.',
    );
    assert.doesNotMatch(
      combinedOutput,
      /node:internal\/errors:/,
      'Publish script must not print the Node internal error stack for missing npm login.',
    );
    assert.doesNotMatch(
      combinedOutput,
      /Unknown env config/,
      'Publish script must hide pnpm-injected npm config warnings from the login guidance path.',
    );

    const callLog = await fs.readFile(callLogAbs, 'utf-8');
    const calls = callLog
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    assert.deepEqual(
      calls,
      ['npm whoami --registry https://registry.npmjs.org/'],
      'Publish script must stop at the upfront npm login check and must not continue to npm view or pnpm publish.',
    );
  } finally {
    await fs.rm(tempRootAbs, { recursive: true, force: true });
  }
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
  await assertPublishScriptFailsBeforePlanWhenNpmLoginMissing(domindsRootAbs);
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
