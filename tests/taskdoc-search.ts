import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { listTaskDocumentsInRtws } from '../main/utils/taskdoc-search';
import { withTempRtws } from './kernel-driver/helpers';

async function writeText(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

async function main() {
  await withTempRtws(async (rtws) => {
    // Explicit root keeps pre-existing CLI fixtures outside this search scenario.
    const root = path.join(rtws, 'taskdoc-search-data');
    await fs.mkdir(root);
    await writeText(path.join(root, '.taskdoc-ignore'), 'ignored-root/\n# comment\n');
    const goals = '- given goals data:4c91\n';
    const included = path.join(root, 'included-root.tsk');
    await writeText(path.join(included, 'goals.md'), goals);
    for (const directory of [
      'ignored-root/ignored-1.tsk',
      'ignored-root/nested/ignored-2.tsk',
      'projects/proj1/private/secret.tsk',
      'projects/proj1/public/public-1.tsk',
      'projects/proj2/public-2.tsk',
      'projects/proj1/public-ignored.tsk',
    ])
      await fs.mkdir(path.join(root, directory), { recursive: true });
    await writeText(
      path.join(root, 'projects/proj1/.taskdoc-ignore'),
      'private/\npublic-ignored.tsk\n',
    );
    // A Taskdoc is a single search result; its internal directories are not new tasks.
    await writeText(
      path.join(root, 'projects/proj1/public/public-1.tsk/internal.tsk/goals.md'),
      'nested-package-data:8b17',
    );
    for (const directory of ['node_modules', '.git', '.minds', '.dialogs'])
      await fs.mkdir(path.join(root, directory, 'ignored-default.tsk'), { recursive: true });

    const older = new Date('2001-02-03T04:05:06Z');
    const newer = new Date('2002-03-04T05:06:07Z');
    await fs.utimes(included, older, older);
    await fs.utimes(path.join(included, 'goals.md'), newer, newer);
    const result = await listTaskDocumentsInRtws({ rootDir: root });
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') throw new Error('Taskdoc listing did not succeed');
    assert.deepEqual(
      result.taskDocuments.map((document) => document.relativePath),
      ['included-root.tsk', 'projects/proj1/public/public-1.tsk', 'projects/proj2/public-2.tsk'],
    );
    const document = result.taskDocuments.find((row) => row.relativePath === 'included-root.tsk');
    assert.ok(document);
    assert.equal(document.name, 'included-root.tsk');
    assert.equal(document.size, Buffer.byteLength(goals, 'utf8'));
    assert.equal(document.lastModified, formatUnifiedTimestamp(newer));
    assert.equal(await fs.readFile(path.join(included, 'goals.md'), 'utf8'), goals);
  });
  console.log(
    'Actual Taskdoc discovery, nested/default ignores, encapsulation and source metadata: PASS',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
