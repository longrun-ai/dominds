import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function writePackageTree(
  rootAbs: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(rootAbs, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf8');
  }
}

function createTarballFromPackageDir(sourceRootAbs: string, tarballAbs: string): void {
  execFileSync('tar', ['-czf', tarballAbs, '-C', sourceRootAbs, 'package'], {
    stdio: 'pipe',
  });
}

async function main(): Promise<void> {
  const domindsRootAbs = path.resolve(__dirname, '..');
  const verifyModule = await import(
    path.join(domindsRootAbs, 'scripts', 'verify-packed-public-package.mjs')
  );
  const assertTarballContentsMatch = verifyModule.assertTarballContentsMatch as (
    localTarballAbs: string,
    publishedTarballAbs: string,
    labels: { local: string; published: string },
  ) => void;

  const tempRootAbs = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-version-drift-guard-'));
  try {
    const localRootAbs = path.join(tempRootAbs, 'local');
    const publishedRootAbs = path.join(tempRootAbs, 'published');
    await fs.mkdir(path.join(localRootAbs, 'package'), { recursive: true });
    await fs.mkdir(path.join(publishedRootAbs, 'package'), { recursive: true });

    const sharedPackageJson = JSON.stringify(
      {
        name: '@longrun-ai/kernel',
        version: '1.8.6',
        main: 'dist/index.js',
      },
      null,
      2,
    );

    await writePackageTree(localRootAbs, {
      'package/package.json': sharedPackageJson,
      'package/dist/index.js': 'exports.answer = 42;\n',
      'package/dist/team-mgmt-guide.js': 'exports.isTeamMgmtGuideTopicKey = () => true;\n',
    });
    await writePackageTree(publishedRootAbs, {
      'package/package.json': sharedPackageJson,
      'package/dist/index.js': 'exports.answer = 42;\n',
      'package/dist/team-mgmt-manual.js': 'exports.isTeamMgmtManualTopicKey = () => true;\n',
    });

    const localTarballAbs = path.join(tempRootAbs, 'local.tgz');
    const publishedTarballAbs = path.join(tempRootAbs, 'published.tgz');
    createTarballFromPackageDir(localRootAbs, localTarballAbs);
    createTarballFromPackageDir(publishedRootAbs, publishedTarballAbs);

    assert.throws(
      () =>
        assertTarballContentsMatch(localTarballAbs, publishedTarballAbs, {
          local: 'local packed @longrun-ai/kernel@1.8.6',
          published: 'published npm @longrun-ai/kernel@1.8.6',
        }),
      /differs from/,
      'The tarball drift guard must reject same-version tarballs with different contents.',
    );
  } finally {
    await fs.rm(tempRootAbs, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
