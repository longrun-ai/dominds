import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { packAndVerifyPublicPackage } from './verify-packed-public-package.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRootAbs = path.resolve(__dirname, '..');
const npmRegistryUrl = 'https://registry.npmjs.org/';

const publicPackages = [
  {
    packageName: '@longrun-ai/codex-auth',
    packageRootRel: 'codex-auth',
  },
  {
    packageName: '@longrun-ai/kernel',
    packageRootRel: 'packages/kernel',
  },
  {
    packageName: '@longrun-ai/shell',
    packageRootRel: 'packages/shell',
  },
  {
    packageName: 'dominds',
    packageRootRel: '.',
  },
];

function usage() {
  console.log(`Usage:
  node ./scripts/publish-public-packages.mjs [--dry-run] [--tag <tag>] [--otp <otp>] [extra npm publish args]

Behavior:
  - Non-dry-run publish checks npm login up front and can prompt to run npm login interactively
  - Publishes public packages in dependency order: codex-auth -> kernel -> shell -> dominds
  - Skips packages whose exact local version already exists on npm
  - Fails fast if a local version is behind the highest published version
  - Verifies each non-dry-run publish reached the registry before continuing
  - When multiple packages need publishing, omit --otp so the script prompts for a fresh OTP right before each publish after the build/pack checks complete`);
}

function normalizeJsonValue(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null || value === '') {
    return [];
  }
  return [value];
}

function readPackageJson(packageRootAbs) {
  const packageJsonAbs = path.join(packageRootAbs, 'package.json');
  if (!existsSync(packageJsonAbs)) {
    throw new Error(`Missing package.json under ${packageRootAbs}.`);
  }
  return JSON.parse(readFileSync(packageJsonAbs, 'utf8'));
}

function getPackageScript(packageJson, scriptName) {
  const scripts = packageJson.scripts;
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) {
    return null;
  }
  const script = scripts[scriptName];
  return typeof script === 'string' ? script : null;
}

function readExecErrorText(error) {
  if (!(error instanceof Error)) {
    return '';
  }
  const stdout =
    'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '';
  const stderr =
    'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
  return `${stdout}\n${stderr}`;
}

function buildDirectNpmEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    if (key === 'NODE_OPTIONS') {
      continue;
    }
    if (key.startsWith('npm_')) {
      continue;
    }
    env[key] = value;
  }
  env.NODE_OPTIONS = '';
  return env;
}

function parseSemver(versionText) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$/.exec(versionText);
  if (!match) {
    throw new Error(`Unsupported version format: ${versionText}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(leftText, rightText) {
  const left = parseSemver(leftText);
  const right = parseSemver(rightText);
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

function npmViewJson(args) {
  try {
    const stdout = execFileSync('npm', ['view', ...args, '--json'], {
      cwd: workspaceRootAbs,
      encoding: 'utf8',
      env: buildDirectNpmEnv(),
      stdio: 'pipe',
    }).trim();
    if (stdout === '') {
      return null;
    }
    return JSON.parse(stdout);
  } catch (error) {
    const output = readExecErrorText(error);
    if (output.includes('E404')) {
      return null;
    }
    throw error;
  }
}

function getNpmLoggedInUser() {
  try {
    const stdout = execFileSync('npm', ['whoami', '--registry', npmRegistryUrl], {
      cwd: workspaceRootAbs,
      encoding: 'utf8',
      env: buildDirectNpmEnv(),
      stdio: 'pipe',
    }).trim();
    return stdout === '' ? null : stdout;
  } catch (error) {
    const output = readExecErrorText(error);
    if (
      output.includes('ENEEDAUTH') ||
      output.includes('E401') ||
      output.includes('401 Unauthorized') ||
      output.includes('This command requires you to be logged in') ||
      output.includes('not logged in')
    ) {
      return null;
    }
    throw error;
  }
}

async function ensureNpmLogin() {
  const currentUser = getNpmLoggedInUser();
  if (currentUser !== null) {
    console.log(`npm login detected for ${currentUser}.`);
    return;
  }

  const loginCommand = `npm login --registry ${npmRegistryUrl}`;
  const missingLoginMessage =
    `npm login is required before publishing public packages.\n` +
    `Run: ${loginCommand}`;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(missingLoginMessage);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    const answer = (
      await rl.question(`No npm login found for ${npmRegistryUrl}. Run "${loginCommand}" now? [Y/n] `)
    )
      .trim()
      .toLowerCase();
    if (answer !== '' && answer !== 'y' && answer !== 'yes') {
      throw new Error(missingLoginMessage);
    }
  } finally {
    rl.close();
  }

  execFileSync('npm', ['login', '--registry', npmRegistryUrl], {
    cwd: workspaceRootAbs,
    encoding: 'utf8',
    env: buildDirectNpmEnv(),
    stdio: 'inherit',
  });

  const loggedInUser = getNpmLoggedInUser();
  if (loggedInUser === null) {
    throw new Error(
      `npm login completed but no authenticated npm user is available for ${npmRegistryUrl}.`,
    );
  }
  console.log(`npm login detected for ${loggedInUser}.`);
}

function getPublishedVersions(packageName) {
  const versions = npmViewJson([packageName, 'versions']);
  return normalizeJsonValue(versions)
    .filter((value) => typeof value === 'string')
    .sort(compareSemver);
}

function hasExactPublishedVersion(packageName, version) {
  const result = npmViewJson([`${packageName}@${version}`, 'version']);
  return typeof result === 'string' && result === version;
}

function getHighestPublishedVersion(packageName) {
  const versions = getPublishedVersions(packageName);
  return versions.length === 0 ? null : versions.at(-1) ?? null;
}

function shouldPublishPackage(pkg) {
  if (hasExactPublishedVersion(pkg.packageName, pkg.localVersion)) {
    return {
      publish: false,
      reason: `skip: ${pkg.packageName}@${pkg.localVersion} already exists on npm`,
    };
  }
  const highestPublishedVersion = getHighestPublishedVersion(pkg.packageName);
  if (
    highestPublishedVersion !== null &&
    compareSemver(pkg.localVersion, highestPublishedVersion) < 0
  ) {
    throw new Error(
      `${pkg.packageName} local version ${pkg.localVersion} is behind npm ${highestPublishedVersion}. Bump the local version before publishing.`,
    );
  }
  return {
    publish: true,
    reason:
      highestPublishedVersion === null
        ? `publish: ${pkg.packageName}@${pkg.localVersion} has never been published`
        : `publish: ${pkg.packageName}@${pkg.localVersion} is newer than npm ${highestPublishedVersion}`,
  };
}

async function verifyPublished(packageName, version) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    if (hasExactPublishedVersion(packageName, version)) {
      return;
    }
    await sleep(5000);
  }
  throw new Error(`Timed out waiting for ${packageName}@${version} to appear on npm.`);
}

function runNpmPublishTarball(pkg, tarballAbs, passThroughArgs) {
  execFileSync('npm', ['publish', tarballAbs, '--access', 'public', ...passThroughArgs], {
    cwd: pkg.packageRootAbs,
    encoding: 'utf8',
    env: buildDirectNpmEnv(),
    stdio: 'inherit',
  });
}

function runPrepublishOnly(pkg) {
  if (pkg.prepublishOnlyScript === null) {
    return;
  }
  execFileSync('pnpm', ['run', 'prepublishOnly'], {
    cwd: pkg.packageRootAbs,
    encoding: 'utf8',
    env: {
      ...process.env,
      DOMINDS_PUBLIC_PUBLISH_FLOW: '1',
      NODE_OPTIONS: '',
    },
    stdio: 'inherit',
  });
}

function collectWorkspacePackages() {
  return publicPackages.map((entry) => {
    const packageRootAbs = path.resolve(workspaceRootAbs, entry.packageRootRel);
    const packageJson = readPackageJson(packageRootAbs);
    if (packageJson.name !== entry.packageName) {
      throw new Error(
        `Expected ${entry.packageRootRel} to be ${entry.packageName}, got ${String(packageJson.name)}.`,
      );
    }
    if (typeof packageJson.version !== 'string') {
      throw new Error(`${entry.packageName} must declare a string version.`);
    }
    return {
      ...entry,
      packageRootAbs,
      localVersion: packageJson.version,
      prepublishOnlyScript: getPackageScript(packageJson, 'prepublishOnly'),
    };
  });
}

function parseCliArgs(args) {
  const publishArgs = [];
  let otp = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--otp') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('--otp requires a value.');
      }
      otp = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--otp=')) {
      otp = arg.slice('--otp='.length);
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
    }
    publishArgs.push(arg);
  }

  return {
    dryRun,
    otp,
    publishArgs,
  };
}

async function promptForOtp(packageName) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `2FA is required for ${packageName}. Re-run in an interactive terminal without --otp so the script can prompt before each publish.`,
    );
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    const otp = (await rl.question(`Enter npm OTP for ${packageName}: `)).trim();
    if (otp === '') {
      throw new Error(`Publishing aborted: OTP is required for ${packageName}.`);
    }
    return otp;
  } finally {
    rl.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }
  const cli = parseCliArgs(args);
  if (!cli.dryRun) {
    await ensureNpmLogin();
  }

  const packages = collectWorkspacePackages();
  const plan = packages.map((pkg) => ({
    ...pkg,
    ...shouldPublishPackage(pkg),
  }));

  console.log('Public package publish plan:');
  for (const item of plan) {
    console.log(`- ${item.reason}`);
  }

  const toPublish = plan.filter((item) => item.publish);
  if (toPublish.length === 0) {
    console.log('Nothing to publish.');
    return;
  }

  if (!cli.dryRun && cli.otp !== null && toPublish.length > 1) {
    throw new Error(
      'A single --otp value is unsafe when multiple packages need publishing because it may expire mid-release. Re-run without --otp so the script can prompt for a fresh OTP before each package.',
    );
  }

  for (const pkg of toPublish) {
    console.log(`\n==> ${pkg.packageName}@${pkg.localVersion}`);
    runPrepublishOnly(pkg);
    const packed = packAndVerifyPublicPackage(pkg.packageRootAbs);
    try {
      const publishArgs = [...cli.publishArgs];
      if (!cli.dryRun) {
        const otp = cli.otp ?? (await promptForOtp(pkg.packageName));
        publishArgs.push('--otp', otp);
      }
      runNpmPublishTarball(pkg, packed.tarballAbs, publishArgs);
    } finally {
      packed.cleanup();
    }
    if (!cli.dryRun) {
      await verifyPublished(pkg.packageName, pkg.localVersion);
      console.log(`Verified ${pkg.packageName}@${pkg.localVersion} on npm.`);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
