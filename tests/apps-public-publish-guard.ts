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
      path.join(fakeBinAbs, 'git'),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '-C' && args[2] === 'status') {
  process.exit(0);
}
if (args[0] === '-C' && args[2] === 'rev-parse') {
  process.stdout.write('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n');
  process.exit(0);
}
process.stderr.write('unexpected git invocation: ' + args.join(' ') + '\\n');
process.exit(2);
`,
    );
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

async function assertPublishScriptRejectsPresetOtp(domindsRootAbs: string): Promise<void> {
  const tempRootAbs = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-public-publish-otp-'));
  try {
    const fakeBinAbs = path.join(tempRootAbs, 'bin');
    await fs.mkdir(fakeBinAbs, { recursive: true });

    await writeExecutable(
      path.join(fakeBinAbs, 'npm'),
      `#!/usr/bin/env node
process.stderr.write('managed release flow must reject --otp before npm runs\\n');
process.exit(99);
`,
    );
    await writeExecutable(
      path.join(fakeBinAbs, 'pnpm'),
      `#!/usr/bin/env node
process.stderr.write('managed release flow must reject --otp before pnpm runs\\n');
process.exit(99);
`,
    );

    const result = spawnSync(
      'node',
      [path.join(domindsRootAbs, 'scripts', 'publish-public-packages.mjs'), '--otp', '123456'],
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
      'Publish script must reject a preset OTP before release work begins.',
    );
    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.match(
      combinedOutput,
      /--otp is intentionally not accepted by the managed public release flow/,
      'Publish script must explain why preset OTP values are unsafe.',
    );
    assert.match(
      combinedOutput,
      /npm browser authentication opens immediately before each publish/,
      'Publish script must direct users toward publish-time browser authentication.',
    );
    assert.doesNotMatch(
      combinedOutput,
      /managed release flow must reject --otp before npm runs/,
      'Publish script must reject preset OTP before invoking npm.',
    );
    assert.doesNotMatch(
      combinedOutput,
      /managed release flow must reject --otp before pnpm runs/,
      'Publish script must reject preset OTP before invoking pnpm.',
    );
  } finally {
    await fs.rm(tempRootAbs, { recursive: true, force: true });
  }
}

async function assertPublishScriptRequiresCleanWorktree(domindsRootAbs: string): Promise<void> {
  const tempRootAbs = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-public-publish-clean-'));
  try {
    const fakeBinAbs = path.join(tempRootAbs, 'bin');
    await fs.mkdir(fakeBinAbs, { recursive: true });

    await writeExecutable(
      path.join(fakeBinAbs, 'git'),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '-C' && args[2] === 'status') {
  process.stdout.write(' M scripts/publish-public-packages.mjs\\n');
  process.exit(0);
}
if (args[0] === '-C' && args[2] === 'rev-parse') {
  process.stdout.write('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n');
  process.exit(0);
}
process.stderr.write('unexpected git invocation: ' + args.join(' ') + '\\n');
process.exit(2);
`,
    );
    await writeExecutable(
      path.join(fakeBinAbs, 'npm'),
      `#!/usr/bin/env node
process.stderr.write('managed release flow must reject dirty worktrees before npm runs\\n');
process.exit(99);
`,
    );
    await writeExecutable(
      path.join(fakeBinAbs, 'pnpm'),
      `#!/usr/bin/env node
process.stderr.write('managed release flow must reject dirty worktrees before pnpm runs\\n');
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

    assert.notEqual(result.status, 0, 'Publish script must reject dirty worktrees.');
    const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.match(
      combinedOutput,
      /Public release requires a clean dominds git worktree/,
      'Publish script must explain the clean-worktree requirement.',
    );
    assert.match(
      combinedOutput,
      /M scripts\/publish-public-packages\.mjs/,
      'Publish script must include git status details for dirty worktrees.',
    );
    assert.doesNotMatch(
      combinedOutput,
      /managed release flow must reject dirty worktrees before npm runs/,
      'Publish script must reject dirty worktrees before invoking npm.',
    );
    assert.doesNotMatch(
      combinedOutput,
      /managed release flow must reject dirty worktrees before pnpm runs/,
      'Publish script must reject dirty worktrees before invoking pnpm.',
    );
  } finally {
    await fs.rm(tempRootAbs, { recursive: true, force: true });
  }
}

async function assertPublishScriptUsesBrowserPublishAuth(domindsRootAbs: string): Promise<void> {
  const scriptSource = await fs.readFile(
    path.join(domindsRootAbs, 'scripts', 'publish-public-packages.mjs'),
    'utf-8',
  );
  assert.match(
    scriptSource,
    /'--auth-type', 'web'/,
    'Managed publish must use npm browser authentication so npm can reuse its short-lived 2FA approval window.',
  );
  assert.doesNotMatch(
    scriptSource,
    /Enter npm OTP/,
    'Managed publish must not prompt for raw OTP values itself.',
  );
  assert.match(
    scriptSource,
    /arg === '--auth-type' \|\| arg\.startsWith\('--auth-type='\)/,
    'Managed publish must reject caller-provided auth-type overrides.',
  );
}

async function assertPublishScriptKeepsReusablePreparedTarballs(
  domindsRootAbs: string,
): Promise<void> {
  const scriptSource = await fs.readFile(
    path.join(domindsRootAbs, 'scripts', 'publish-public-packages.mjs'),
    'utf-8',
  );
  assert.match(
    scriptSource,
    /const releasePackDirAbs = path\.join\(workspaceRootAbs, '\.release-pack'\)/,
    'Managed publish must keep prepared release tarballs in the workspace cache directory.',
  );
  assert.match(
    scriptSource,
    /function prepareReleaseTarball\(pkg\)/,
    'Managed publish must prepare tarballs through a reusable release-pack path.',
  );
  assert.match(
    scriptSource,
    /Reusing prepared release tarball/,
    'Managed publish must reuse an already prepared tarball after a failed publish attempt.',
  );
  assert.match(
    scriptSource,
    /metadata\.gitHead !== gitHead/,
    'Managed publish must reject stale prepared tarballs when the release commit changed.',
  );
  assert.match(
    scriptSource,
    /function assertCleanWorktree\(\)/,
    'Managed publish must require a clean worktree before building and publishing.',
  );
  assert.match(
    scriptSource,
    /removePreparedReleaseTarball\(pkg\)/,
    'Managed publish must clean the prepared tarball after registry verification succeeds.',
  );

  const gitignore = await fs.readFile(path.join(domindsRootAbs, '.gitignore'), 'utf-8');
  assert.match(
    gitignore,
    /^\.release-pack\/$/m,
    'Prepared release tarball cache must be gitignored.',
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
  await assertPublishScriptRejectsPresetOtp(domindsRootAbs);
  await assertPublishScriptUsesBrowserPublishAuth(domindsRootAbs);
  await assertPublishScriptKeepsReusablePreparedTarballs(domindsRootAbs);
  await assertPublishScriptRequiresCleanWorktree(domindsRootAbs);
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
