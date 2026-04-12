import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(scriptDir, '../src');
const allowlist = new Set([path.resolve(srcRoot, 'components/dom-events.ts')]);
const filePattern = /\.(ts|tsx)$/;

const forbiddenChecks = [
  {
    pattern: /\bnew\s+CustomEvent(?:<[^>]+>)?\s*\(/g,
    message: 'Use dispatchDomindsEvent from src/components/dom-events.ts instead of hand-written CustomEvent.',
  },
  {
    pattern: /\bas\s+CustomEvent(?:<[^>]+>)?/g,
    message: 'Rely on the shared Dominds custom-event map instead of CustomEvent casts.',
  },
  {
    pattern: /\bCustomEvent<unknown>\b/g,
    message: 'Do not erase custom-event detail types to unknown.',
  },
];

async function collectFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }
    if (filePattern.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = await collectFiles(srcRoot);
const failures = [];

for (const file of files) {
  if (allowlist.has(file)) continue;
  const content = await fs.readFile(file, 'utf8');
  for (const check of forbiddenChecks) {
    const match = check.pattern.exec(content);
    check.pattern.lastIndex = 0;
    if (!match) continue;
    const before = content.slice(0, match.index);
    const line = before.split('\n').length;
    failures.push(`${path.relative(path.resolve(scriptDir, '..'), file)}:${String(line)} ${check.message}`);
  }
}

if (failures.length > 0) {
  console.error('Custom DOM event contract violations found:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
