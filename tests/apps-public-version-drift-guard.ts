import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';

const evidence = semanticEvidenceCollector('dominds-package-drift-');
async function archive(directory: string, name: string, files: Record<string, string>) {
  const source = path.join(directory, name);
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(source, 'package', file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  const tarball = `${source}.tgz`;
  execFileSync('tar', ['-czf', tarball, '-C', source, 'package'], { stdio: 'pipe' });
  return tarball;
}

async function main(): Promise<void> {
  const module = await import(
    path.resolve(__dirname, '../scripts/verify-packed-public-package.mjs')
  );
  const check: (
    local: string,
    published: string,
    labels: { local: string; published: string },
  ) => void = module.assertTarballContentsMatch;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-package-drift-fixture-'));
  try {
    const base = {
      'package.json': JSON.stringify({
        name: '@longrun-ai/kernel',
        version: '1.8.6',
        main: 'dist/index.js',
      }),
      'dist/index.js': 'exports.answer = 42;\n',
      'dist/team-mgmt-guide.js': 'exports.isTeamMgmtGuideTopicKey = () => true;\n',
    };
    const local = await archive(directory, 'local', base);
    const labels = {
      local: 'local packed @longrun-ai/kernel@1.8.6',
      published: 'published npm @longrun-ai/kernel@1.8.6',
    };
    const equal = await archive(
      directory,
      'equal',
      Object.fromEntries(Object.entries(base).reverse()),
    );
    check(local, equal, labels);
    check(equal, local, labels);
    const { 'dist/team-mgmt-guide.js': omitted, ...missing } = base;
    const variants = [
      { id: 'missing-entry', files: missing },
      { id: 'added-entry', files: { ...base, 'dist/added.js': 'exports.added = true;\n' } },
      { id: 'changed-bytes', files: { ...base, 'dist/index.js': 'exports.answer = 43;\n' } },
      { id: 'renamed-entry', files: { ...missing, 'dist/team-mgmt-manual.js': omitted } },
    ];
    for (const variant of variants) {
      const published = await archive(directory, variant.id, variant.files);
      const before = await Promise.all([local, published].map((file) => fs.readFile(file)));
      let failure: unknown;
      try {
        check(local, published, labels);
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof Error, variant.id);
      assert.deepEqual(
        await Promise.all([local, published].map((file) => fs.readFile(file))),
        before,
      );
      evidence.record({
        id: variant.id,
        scenario: `Valid same-name/version tarballs differ by ${variant.id}; actual content comparison rejects them.`,
        businessValue:
          'Prevent treating changed release contents as the already published artifact and help a maintainer identify the drift.',
        context: {
          localFiles: JSON.stringify(base),
          publishedFiles: JSON.stringify(variant.files),
          equalContentPositiveControlPassed: true,
          inputsPreserved: true,
          scope:
            'Actual local tar files and production digest comparison. No registry access, authentication, publishing or arbitrary tar feature coverage.',
        },
        reviewQuestions: [
          'Does the actual diagnostic accurately identify the two artifacts and whether entries were added, removed, renamed or changed, without claiming a publish happened?',
        ],
        actualText: failure.message,
      });
    }
    await evidence.write();
  } catch (error) {
    console.error(`Package drift fixture retained: ${directory}`);
    throw error;
  }
  if (process.env.DOMINDS_TEST_RTWS_KEEP_TMP !== '1')
    await fs.rm(directory, { recursive: true, force: true });
  console.log('Actual package content equality and drift: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
