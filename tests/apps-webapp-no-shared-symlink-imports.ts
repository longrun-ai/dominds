import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

async function walk(dirAbs: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  for (const entry of entries) {
    const entryAbs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(entryAbs)));
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(entryAbs);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const domindsRootAbs = path.resolve(__dirname, '..');
  const webappSrcAbs = path.join(domindsRootAbs, 'webapp', 'src');
  const sourceFiles = await walk(webappSrcAbs);
  const violations: string[] = [];

  for (const fileAbs of sourceFiles) {
    const source = await fs.readFile(fileAbs, 'utf-8');
    if (source.includes('../shared/')) {
      violations.push(path.relative(domindsRootAbs, fileAbs).split(path.sep).join('/'));
    }
  }

  assert.deepEqual(
    violations,
    [],
    [
      'webapp/src must not import legacy ../shared/* after the second package-split migration batch.',
      ...violations.map((fileRel) => `- ${fileRel}`),
    ].join('\n'),
  );

  const sharedPathAbs = path.join(webappSrcAbs, 'shared');
  const sharedExists = await fs
    .access(sharedPathAbs)
    .then(() => true)
    .catch(() => false);
  assert.equal(
    sharedExists,
    false,
    'webapp/src/shared should be absent after removing the symlink.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
