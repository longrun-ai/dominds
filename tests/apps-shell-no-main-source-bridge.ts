import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const SHELL_FORBIDDEN_SNIPPETS = [
  'main/shell',
  '../../../main/',
  '../../main/',
  '../main/',
  '/main/',
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
  const shellSrcAbs = path.join(domindsRootAbs, 'packages', 'shell', 'src');
  const shellTsconfigText = await fs.readFile(
    path.join(domindsRootAbs, 'packages', 'shell', 'tsconfig.json'),
    'utf-8',
  );

  assert.equal(
    shellTsconfigText.includes('../../main/'),
    false,
    'packages/shell/tsconfig.json must not compile ../../main/** anymore.',
  );

  const sourceFiles = (await walkFiles(shellSrcAbs)).filter((fileAbs) => fileAbs.endsWith('.ts'));
  const violations: string[] = [];
  for (const fileAbs of sourceFiles) {
    const sourceText = await fs.readFile(fileAbs, 'utf-8');
    for (const forbidden of SHELL_FORBIDDEN_SNIPPETS) {
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
      'Shell source must stay package-local and must not bridge back into main/**.',
      ...violations,
    ].join('\n'),
  );

  const packageJsonText = await fs.readFile(
    path.join(domindsRootAbs, 'packages', 'shell', 'package.json'),
    'utf-8',
  );
  assert.equal(
    packageJsonText.includes('./cli'),
    false,
    'packages/shell/package.json must not expose a CLI subpath export anymore.',
  );
  assert.equal(
    packageJsonText.includes('"bin"'),
    false,
    'packages/shell/package.json must not publish the dominds CLI binary.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
