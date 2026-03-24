import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

type ConsumerScope = Readonly<{
  label: string;
  rootAbs: string;
}>;

type ImportMatch = Readonly<{
  kind: 'import-from' | 'import-side-effect' | 'export-from' | 'require' | 'dynamic-import';
  specifier: string;
  line: number;
}>;

type Violation = Readonly<{
  consumer: string;
  fileRel: string;
  line: number;
  kind: ImportMatch['kind'];
  specifier: string;
  ruleId: string;
}>;

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

const IMPORT_PATTERNS: ReadonlyArray<Readonly<{ kind: ImportMatch['kind']; regex: RegExp }>> = [
  {
    kind: 'import-from',
    regex: /\bimport\s+(?:type\s+)?[^'"\n;]*?\s+from\s+['"]([^'"]+)['"]/g,
  },
  {
    kind: 'import-side-effect',
    regex: /\bimport\s+['"]([^'"]+)['"]/g,
  },
  {
    kind: 'export-from',
    regex:
      /\bexport\s+(?:type\s+)?(?:\*\s+as\s+[A-Za-z_$][\w$]*|\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
  },
  {
    kind: 'require',
    regex: /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  },
  {
    kind: 'dynamic-import',
    regex: /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  },
];

const PRIVATE_IMPORT_RULES: ReadonlyArray<Readonly<{ id: string; matcher: RegExp }>> = [
  { id: 'main/runtime', matcher: /(^|\/)main\/runtime(?:\/|$)/ },
  { id: 'main/bootstrap', matcher: /(^|\/)main\/bootstrap(?:\/|$)/ },
  { id: 'main/markdown', matcher: /(^|\/)main\/markdown(?:\/|$)/ },
  { id: 'main/apps-host', matcher: /(^|\/)main\/apps-host(?:\/|$)/ },
  { id: 'main/apps', matcher: /(^|\/)main\/apps(?:\/|$)/ },
  { id: 'dist/main/apps-host', matcher: /(^|\/)dist\/main\/apps-host(?:\/|$)/ },
];

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function countLinesBefore(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function collectImports(sourceText: string): ImportMatch[] {
  const matches: ImportMatch[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (
      let match = pattern.regex.exec(sourceText);
      match !== null;
      match = pattern.regex.exec(sourceText)
    ) {
      const specifier = match[1];
      matches.push({
        kind: pattern.kind,
        specifier,
        line: countLinesBefore(sourceText, match.index),
      });
    }
  }
  return matches;
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
      if (!entry.isFile()) {
        continue;
      }
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        out.push(entryAbs);
      }
    }
  }
  try {
    await visit(rootAbs);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return out;
    }
    throw error;
  }
  return out.sort();
}

async function findViolations(
  scope: ConsumerScope,
  workspaceRootAbs: string,
): Promise<Violation[]> {
  const violations: Violation[] = [];
  const sourceFiles = await walkSourceFiles(scope.rootAbs);
  for (const fileAbs of sourceFiles) {
    const sourceText = await fs.readFile(fileAbs, 'utf-8');
    const imports = collectImports(sourceText);
    const fileRel = toPosixPath(path.relative(workspaceRootAbs, fileAbs));
    for (const found of imports) {
      const normalizedSpecifier = found.specifier.replace(/\\/g, '/');
      for (const rule of PRIVATE_IMPORT_RULES) {
        if (rule.matcher.test(normalizedSpecifier)) {
          violations.push({
            consumer: scope.label,
            fileRel,
            line: found.line,
            kind: found.kind,
            specifier: found.specifier,
            ruleId: rule.id,
          });
          break;
        }
      }
    }
  }
  return violations;
}

async function main(): Promise<void> {
  const domindsRootAbs = path.resolve(__dirname, '..');
  const workspaceRootAbs = path.resolve(domindsRootAbs, '..');
  const scopes: ReadonlyArray<ConsumerScope> = [
    { label: 'dominds/main', rootAbs: path.join(domindsRootAbs, 'main') },
    { label: 'dominds/webapp', rootAbs: path.join(domindsRootAbs, 'webapp') },
    { label: 'dominds-apps', rootAbs: path.join(workspaceRootAbs, 'dominds-apps') },
  ];

  const violations = (
    await Promise.all(scopes.map(async (scope) => await findViolations(scope, workspaceRootAbs)))
  ).flat();

  assert.equal(
    violations.length,
    0,
    [
      'Non-test consumers must not deep import private kernel/shell paths.',
      'Use @longrun-ai/kernel or @longrun-ai/shell instead of main/runtime/**, main/bootstrap/**, main/markdown/**, main/apps/**, main/apps-host/**, or dist/main/apps-host/**.',
      ...violations.map(
        (violation) =>
          `- [${violation.consumer}] ${violation.fileRel}:${violation.line} ${violation.kind} ${JSON.stringify(violation.specifier)} (${violation.ruleId})`,
      ),
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
