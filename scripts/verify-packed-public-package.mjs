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

export function readTarballPackageJson(tarballAbs) {
  const stdout = execFileSync('tar', ['-xOf', tarballAbs, 'package/package.json'], {
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
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
