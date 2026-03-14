import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const KERNEL_FORBIDDEN_SNIPPETS = [
  'main/shared/types',
  'main/apps-host',
  'main/apps',
  '../../../main/',
  '../../../../main/',
] as const;

async function walkFiles(rootAbs: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(rootAbs, { withFileTypes: true });
  for (const entry of entries) {
    const entryAbs = path.join(rootAbs, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(entryAbs)));
      continue;
    }
    if (entry.isFile()) {
      out.push(entryAbs);
    }
  }
  return out.sort();
}

async function main(): Promise<void> {
  const domindsRootAbs = path.resolve(__dirname, '..');
  const kernelSrcAbs = path.join(domindsRootAbs, 'packages', 'kernel', 'src');
  const kernelTsconfigText = await fs.readFile(
    path.join(domindsRootAbs, 'packages', 'kernel', 'tsconfig.json'),
    'utf-8',
  );

  assert.equal(
    kernelTsconfigText.includes('../../main/'),
    false,
    'packages/kernel/tsconfig.json must not compile ../../main/** anymore.',
  );

  const sourceFiles = (await walkFiles(kernelSrcAbs)).filter((fileAbs) => fileAbs.endsWith('.ts'));
  const violations: string[] = [];
  for (const fileAbs of sourceFiles) {
    const sourceText = await fs.readFile(fileAbs, 'utf-8');
    for (const forbidden of KERNEL_FORBIDDEN_SNIPPETS) {
      if (sourceText.includes(forbidden)) {
        violations.push(
          `${path.relative(domindsRootAbs, fileAbs)} contains ${JSON.stringify(forbidden)}`,
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    [
      'Kernel source must be self-contained and must not bridge back into main/**.',
      ...violations,
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
