import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const IMPORT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bimport\s+(?:type\s+)?[^'"\n;]*?\s+from\s+['"](dominds\/[^'"]+)['"]/g,
  /\bimport\s+['"](dominds\/[^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?(?:\*\s+as\s+[A-Za-z_$][\w$]*|\*|\{[^}]*\})\s+from\s+['"](dominds\/[^'"]+)['"]/g,
  /\brequire\(\s*['"](dominds\/[^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"](dominds\/[^'"]+)['"]\s*\)/g,
];

type Violation = Readonly<{
  fileRel: string;
  line: number;
  specifier: string;
}>;

function countLinesBefore(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

async function walkSourceFiles(rootAbs: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dirAbs: string): Promise<void> {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      const entryAbs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
          continue;
        }
        await visit(entryAbs);
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        out.push(entryAbs);
      }
    }
  }
  await visit(rootAbs);
  return out.sort();
}

async function main(): Promise<void> {
  const testsRootAbs = path.resolve(__dirname);
  const domindsRootAbs = path.resolve(testsRootAbs, '..');
  const violations: Violation[] = [];
  const sourceFiles = await walkSourceFiles(testsRootAbs);
  for (const fileAbs of sourceFiles) {
    const sourceText = await fs.readFile(fileAbs, 'utf-8');
    const fileRel = path.relative(domindsRootAbs, fileAbs).split(path.sep).join('/');
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(sourceText); match !== null; match = pattern.exec(sourceText)) {
        const specifier = match[1] ?? 'dominds/<unknown>';
        violations.push({
          fileRel,
          line: countLinesBefore(sourceText, match.index),
          specifier,
        });
      }
    }
  }

  assert.equal(
    violations.length,
    0,
    [
      'tests/** must not import dominds root-package subpaths.',
      'Use @longrun-ai/kernel or @longrun-ai/shell for formal package-contract tests, or ../main/** for repo-internal implementation tests.',
      ...violations.map(
        (violation) =>
          `- ${violation.fileRel}:${violation.line} imports ${JSON.stringify(violation.specifier)}`,
      ),
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
