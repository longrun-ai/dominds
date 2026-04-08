import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function findWorkspaceRoot(startAbs) {
  let currentAbs = startAbs;
  while (true) {
    if (existsSync(path.join(currentAbs, 'pnpm-workspace.yaml'))) {
      return currentAbs;
    }
    const parentAbs = path.dirname(currentAbs);
    if (parentAbs === currentAbs) {
      throw new Error(`Could not find pnpm-workspace.yaml above ${startAbs}.`);
    }
    currentAbs = parentAbs;
  }
}

function readPackageJson(packageJsonAbs) {
  return JSON.parse(readFileSync(packageJsonAbs, 'utf8'));
}

export function readWorkspacePackageVersions(workspaceRootAbs) {
  const packageJsonRelPaths = [
    'package.json',
    'packages/kernel/package.json',
    'packages/shell/package.json',
    'codex-auth/package.json',
    'webapp/package.json',
    'tests/package.json',
  ];
  const versions = new Map();
  for (const relPath of packageJsonRelPaths) {
    const packageJsonAbs = path.join(workspaceRootAbs, relPath);
    if (!existsSync(packageJsonAbs)) {
      continue;
    }
    const packageJson = readPackageJson(packageJsonAbs);
    if (typeof packageJson.name !== 'string') {
      throw new Error(`Invalid package name in ${packageJsonAbs}.`);
    }
    if (typeof packageJson.version === 'string') {
      versions.set(packageJson.name, packageJson.version);
    }
  }
  return versions;
}

export function packWithPnpm(packageRootAbs) {
  const tmpRootAbs = mkdtempSync(path.join(os.tmpdir(), 'dominds-pack-verify-'));
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', tmpRootAbs], {
      cwd: packageRootAbs,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
      },
      stdio: 'pipe',
    });
    const tarballs = readdirSync(tmpRootAbs).filter((entry) => entry.endsWith('.tgz')).sort();
    if (tarballs.length !== 1) {
      throw new Error(`pnpm pack must produce exactly one tarball, got ${tarballs.length}.`);
    }
    return {
      tarballAbs: path.join(tmpRootAbs, tarballs[0]),
      cleanup() {
        rmSync(tmpRootAbs, { force: true, recursive: true });
      },
    };
  } catch (error) {
    rmSync(tmpRootAbs, { force: true, recursive: true });
    throw error;
  }
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

export function packPublishedPackageVersion(packageName, version) {
  const tmpRootAbs = mkdtempSync(path.join(os.tmpdir(), 'dominds-pack-published-'));
  try {
    execFileSync('npm', ['pack', `${packageName}@${version}`, '--pack-destination', tmpRootAbs], {
      encoding: 'utf8',
      env: buildDirectNpmEnv(),
      stdio: 'pipe',
    });
    const tarballs = readdirSync(tmpRootAbs).filter((entry) => entry.endsWith('.tgz')).sort();
    if (tarballs.length !== 1) {
      throw new Error(`npm pack must produce exactly one tarball, got ${tarballs.length}.`);
    }
    return {
      tarballAbs: path.join(tmpRootAbs, tarballs[0]),
      cleanup() {
        rmSync(tmpRootAbs, { force: true, recursive: true });
      },
    };
  } catch (error) {
    rmSync(tmpRootAbs, { force: true, recursive: true });
    throw error;
  }
}

export function readTarballPackageJson(tarballAbs) {
  const stdout = execFileSync('tar', ['-xOf', tarballAbs, 'package/package.json'], {
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

function unpackTarball(tarballAbs) {
  const tmpRootAbs = mkdtempSync(path.join(os.tmpdir(), 'dominds-pack-unpack-'));
  try {
    execFileSync('tar', ['-xzf', tarballAbs, '-C', tmpRootAbs], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const packageRootAbs = path.join(tmpRootAbs, 'package');
    if (!existsSync(packageRootAbs)) {
      throw new Error(`Tarball ${tarballAbs} does not contain package/ root.`);
    }
    return {
      packageRootAbs,
      cleanup() {
        rmSync(tmpRootAbs, { force: true, recursive: true });
      },
    };
  } catch (error) {
    rmSync(tmpRootAbs, { force: true, recursive: true });
    throw error;
  }
}

function collectFileDigests(rootAbs) {
  const digests = new Map();
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop();
    if (relDir === undefined) {
      continue;
    }
    const absDir = relDir === '' ? rootAbs : path.join(rootAbs, relDir);
    const entries = readdirSync(absDir, { withFileTypes: true })
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relPath = relDir === '' ? entry.name : path.posix.join(relDir, entry.name);
      const absPath = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(relPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const content = readFileSync(absPath);
      const digest = createHash('sha256').update(content).digest('hex');
      digests.set(relPath.replaceAll(path.sep, '/'), digest);
    }
  }
  return digests;
}

function describeDigestDiff(localDigests, publishedDigests) {
  const onlyLocal = [];
  const onlyPublished = [];
  const mismatched = [];
  const allPaths = [...new Set([...localDigests.keys(), ...publishedDigests.keys()])].sort();
  for (const relPath of allPaths) {
    const localDigest = localDigests.get(relPath);
    const publishedDigest = publishedDigests.get(relPath);
    if (localDigest === undefined) {
      onlyPublished.push(relPath);
      continue;
    }
    if (publishedDigest === undefined) {
      onlyLocal.push(relPath);
      continue;
    }
    if (localDigest !== publishedDigest) {
      mismatched.push(relPath);
    }
  }

  const previewLimit = 12;
  const lines = [];
  if (onlyLocal.length > 0) {
    lines.push(
      `only in local (${onlyLocal.length}): ${onlyLocal.slice(0, previewLimit).join(', ')}${onlyLocal.length > previewLimit ? ', ...' : ''}`,
    );
  }
  if (onlyPublished.length > 0) {
    lines.push(
      `only in published (${onlyPublished.length}): ${onlyPublished.slice(0, previewLimit).join(', ')}${onlyPublished.length > previewLimit ? ', ...' : ''}`,
    );
  }
  if (mismatched.length > 0) {
    lines.push(
      `content mismatch (${mismatched.length}): ${mismatched.slice(0, previewLimit).join(', ')}${mismatched.length > previewLimit ? ', ...' : ''}`,
    );
  }
  return lines;
}

export function assertTarballContentsMatch(localTarballAbs, publishedTarballAbs, labels) {
  const local = unpackTarball(localTarballAbs);
  try {
    const published = unpackTarball(publishedTarballAbs);
    try {
      const localDigests = collectFileDigests(local.packageRootAbs);
      const publishedDigests = collectFileDigests(published.packageRootAbs);
      const diffLines = describeDigestDiff(localDigests, publishedDigests);
      if (diffLines.length === 0) {
        return;
      }
      throw new Error(
        `${labels.local} differs from ${labels.published}.\n${diffLines.map((line) => `- ${line}`).join('\n')}`,
      );
    } finally {
      published.cleanup();
    }
  } finally {
    local.cleanup();
  }
}

export function assertPackedInternalDepsUseConcreteVersions(
  packageName,
  packedPackageJson,
  workspaceVersions,
) {
  const depFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  for (const depField of depFields) {
    const deps = packedPackageJson[depField];
    if (deps === undefined) {
      continue;
    }
    if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) {
      throw new Error(`Packed ${packageName} ${depField} must be an object when present.`);
    }
    for (const [depName, depSpec] of Object.entries(deps)) {
      if (typeof depSpec !== 'string') {
        throw new Error(`Packed ${packageName} ${depField}.${depName} must be a string.`);
      }
      if (depSpec.startsWith('workspace:')) {
        throw new Error(
          `Packed ${packageName} ${depField}.${depName} must not retain workspace protocol: ${depSpec}`,
        );
      }
      const workspaceVersion = workspaceVersions.get(depName);
      if (workspaceVersion === undefined || depName === packageName) {
        continue;
      }
      if (depSpec !== workspaceVersion) {
        throw new Error(
          `Packed ${packageName} ${depField}.${depName} must resolve to exact workspace version ${workspaceVersion}; got ${depSpec}.`,
        );
      }
    }
  }
}

export function packAndVerifyPublicPackage(packageRootAbs) {
  const packageJson = readPackageJson(path.join(packageRootAbs, 'package.json'));
  if (typeof packageJson.name !== 'string') {
    throw new Error('Current package.json must declare a string name.');
  }
  const workspaceRootAbs = findWorkspaceRoot(packageRootAbs);
  const workspaceVersions = readWorkspacePackageVersions(workspaceRootAbs);
  const packed = packWithPnpm(packageRootAbs);
  try {
    const packedPackageJson = readTarballPackageJson(packed.tarballAbs);
    assertPackedInternalDepsUseConcreteVersions(
      packageJson.name,
      packedPackageJson,
      workspaceVersions,
    );
    return packed;
  } catch (error) {
    packed.cleanup();
    throw error;
  }
}

function main() {
  const packed = packAndVerifyPublicPackage(process.cwd());
  packed.cleanup();
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  main();
}
