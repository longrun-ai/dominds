import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  assertTarballContentsMatch,
  packAndVerifyPublicPackage,
  packPublishedPackageVersion,
  readTarballPackageJson,
} from './verify-packed-public-package.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRootAbs = path.resolve(__dirname, '..');
const npmRegistryUrl = 'https://registry.npmjs.org/';
const releasePackDirAbs = path.join(workspaceRootAbs, '.release-pack');

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
  node ./scripts/publish-public-packages.mjs [--dry-run] [--tag <tag>] [extra npm publish args]

Behavior:
  - Non-dry-run publish checks npm login up front and can prompt to run npm login interactively
  - Publishes public packages in dependency order: codex-auth -> kernel -> shell -> dominds
  - Skips packages whose exact local version already exists on npm
  - Fails fast if a local version is behind the highest published version
  - Verifies each non-dry-run publish reached the registry before continuing
  - Reuses a previously prepared .release-pack tarball for the same package@version after failed publish attempts
  - Uses npm browser authentication at publish time so npm can reuse its short-lived 2FA approval window`);
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

function readJsonFile(fileAbs) {
  return JSON.parse(readFileSync(fileAbs, 'utf8'));
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
  const stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '';
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
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

function getGitOutput(args) {
  return execFileSync('git', ['-C', workspaceRootAbs, ...args], {
    cwd: workspaceRootAbs,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: '',
    },
    stdio: 'pipe',
  });
}

function getCurrentGitHead() {
  return getGitOutput(['rev-parse', 'HEAD']).trim();
}

function assertCleanWorktree() {
  const status = getGitOutput(['status', '--porcelain=v1', '--untracked-files=all']).trim();
  if (status !== '') {
    throw new Error(
      `Public release requires a clean dominds git worktree before build/pack/publish.\n` +
        `Commit or discard local changes first.\n` +
        status,
    );
  }
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
    `npm login is required before publishing public packages.\n` + `Run: ${loginCommand}`;

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
      await rl.question(
        `No npm login found for ${npmRegistryUrl}. Run "${loginCommand}" now? [Y/n] `,
      )
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
  return versions.length === 0 ? null : (versions.at(-1) ?? null);
}

function shouldPublishPackage(pkg) {
  if (hasExactPublishedVersion(pkg.packageName, pkg.localVersion)) {
    return {
      publish: false,
      exactVersionExists: true,
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
    exactVersionExists: false,
    reason:
      highestPublishedVersion === null
        ? `publish: ${pkg.packageName}@${pkg.localVersion} has never been published`
        : `publish: ${pkg.packageName}@${pkg.localVersion} is newer than npm ${highestPublishedVersion}`,
  };
}

function releasePackFileName(pkg) {
  const safePackageName = pkg.packageName.replace(/^@/, '').replaceAll('/', '-');
  return `${safePackageName}-${pkg.localVersion}.tgz`;
}

function getPreparedReleaseTarballAbs(pkg) {
  return path.join(releasePackDirAbs, releasePackFileName(pkg));
}

function getPreparedReleaseMetadataAbs(pkg) {
  return `${getPreparedReleaseTarballAbs(pkg)}.json`;
}

function assertPreparedTarballMatchesPackage(pkg, tarballAbs) {
  const packedPackageJson = readTarballPackageJson(tarballAbs);
  if (packedPackageJson.name !== pkg.packageName) {
    throw new Error(
      `Prepared tarball ${tarballAbs} declares package ${String(packedPackageJson.name)}, expected ${pkg.packageName}.`,
    );
  }
  if (packedPackageJson.version !== pkg.localVersion) {
    throw new Error(
      `Prepared tarball ${tarballAbs} declares version ${String(packedPackageJson.version)}, expected ${pkg.localVersion}.`,
    );
  }
}

function removePreparedReleaseTarball(pkg) {
  const preparedTarballAbs = getPreparedReleaseTarballAbs(pkg);
  const preparedMetadataAbs = getPreparedReleaseMetadataAbs(pkg);
  rmSync(preparedTarballAbs, { force: true });
  rmSync(preparedMetadataAbs, { force: true });
}

function prepareReleaseTarball(pkg) {
  const preparedTarballAbs = getPreparedReleaseTarballAbs(pkg);
  const preparedMetadataAbs = getPreparedReleaseMetadataAbs(pkg);
  const gitHead = getCurrentGitHead();
  if (existsSync(preparedTarballAbs)) {
    assertPreparedTarballMatchesPackage(pkg, preparedTarballAbs);
    if (!existsSync(preparedMetadataAbs)) {
      console.log(
        `Prepared release tarball is missing metadata; rebuilding: ${preparedTarballAbs}`,
      );
      removePreparedReleaseTarball(pkg);
      return prepareReleaseTarball(pkg);
    }
    const metadata = readJsonFile(preparedMetadataAbs);
    if (
      metadata.packageName !== pkg.packageName ||
      metadata.version !== pkg.localVersion ||
      metadata.gitHead !== gitHead
    ) {
      console.log(`Prepared release tarball is stale; rebuilding: ${preparedTarballAbs}`);
      removePreparedReleaseTarball(pkg);
      return prepareReleaseTarball(pkg);
    }
    console.log(`Reusing prepared release tarball: ${preparedTarballAbs}`);
    return {
      tarballAbs: preparedTarballAbs,
      reused: true,
    };
  }

  runPrepublishOnly(pkg);
  const packed = packAndVerifyPublicPackage(pkg.packageRootAbs);
  try {
    assertPreparedTarballMatchesPackage(pkg, packed.tarballAbs);
    mkdirSync(releasePackDirAbs, { recursive: true });
    copyFileSync(packed.tarballAbs, preparedTarballAbs);
    writeFileSync(
      preparedMetadataAbs,
      `${JSON.stringify(
        {
          packageName: pkg.packageName,
          version: pkg.localVersion,
          gitHead,
          tarballFileName: path.basename(preparedTarballAbs),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(`Prepared release tarball: ${preparedTarballAbs}`);
    return {
      tarballAbs: preparedTarballAbs,
      reused: false,
    };
  } finally {
    packed.cleanup();
  }
}

function verifySkippedExactVersionPackageMatchesRegistry(pkg) {
  runPrepublishOnly(pkg);
  const localPacked = packAndVerifyPublicPackage(pkg.packageRootAbs);
  try {
    const publishedPacked = packPublishedPackageVersion(pkg.packageName, pkg.localVersion);
    try {
      assertTarballContentsMatch(localPacked.tarballAbs, publishedPacked.tarballAbs, {
        local: `local packed ${pkg.packageName}@${pkg.localVersion}`,
        published: `published npm ${pkg.packageName}@${pkg.localVersion}`,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${pkg.packageName}@${pkg.localVersion} already exists on npm, but the current local package contents differ from the published tarball.\n` +
          `This means the workspace package changed without a version bump. Bump the version before publishing.\n` +
          `${detail}`,
      );
    } finally {
      publishedPacked.cleanup();
    }
  } finally {
    localPacked.cleanup();
  }
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
  execFileSync(
    'npm',
    ['publish', tarballAbs, '--access', 'public', '--auth-type', 'web', ...passThroughArgs],
    {
      cwd: pkg.packageRootAbs,
      encoding: 'utf8',
      env: buildDirectNpmEnv(),
      stdio: 'inherit',
    },
  );
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
  let dryRun = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--otp') {
      throw new Error(
        '--otp is intentionally not accepted by the managed public release flow because build/pack checks can outlive npm OTP validity. Re-run in an interactive terminal without --otp; npm browser authentication opens immediately before each publish and can reuse its short-lived 2FA approval window.',
      );
    }
    if (arg.startsWith('--otp=')) {
      throw new Error(
        '--otp is intentionally not accepted by the managed public release flow because build/pack checks can outlive npm OTP validity. Re-run in an interactive terminal without --otp; npm browser authentication opens immediately before each publish and can reuse its short-lived 2FA approval window.',
      );
    }
    if (arg === '--auth-type' || arg.startsWith('--auth-type=')) {
      throw new Error(
        '--auth-type is managed by the public release flow. The script uses npm browser authentication so publish-time 2FA can reuse npm short-lived approval.',
      );
    }
    if (arg === '--dry-run') {
      dryRun = true;
    }
    publishArgs.push(arg);
  }

  return {
    dryRun,
    publishArgs,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }
  const cli = parseCliArgs(args);
  assertCleanWorktree();
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

  for (const item of plan) {
    if (!item.publish && item.exactVersionExists) {
      console.log(
        `Verifying skipped exact-version package matches npm: ${item.packageName}@${item.localVersion}`,
      );
      verifySkippedExactVersionPackageMatchesRegistry(item);
    }
  }

  const toPublish = plan.filter((item) => item.publish);
  if (toPublish.length === 0) {
    console.log('Nothing to publish.');
    return;
  }

  for (const pkg of toPublish) {
    console.log(`\n==> ${pkg.packageName}@${pkg.localVersion}`);
    const prepared = prepareReleaseTarball(pkg);
    const publishArgs = [...cli.publishArgs];
    runNpmPublishTarball(pkg, prepared.tarballAbs, publishArgs);
    if (!cli.dryRun) {
      await verifyPublished(pkg.packageName, pkg.localVersion);
      console.log(`Verified ${pkg.packageName}@${pkg.localVersion} on npm.`);
      removePreparedReleaseTarball(pkg);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
