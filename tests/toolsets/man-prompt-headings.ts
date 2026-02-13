#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', 'main', 'tools', 'prompts', 'ws_read');

function collectMarkdownFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const resolved = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdownFiles(resolved));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(resolved);
    }
  }
  return out;
}

type HeadingViolation = {
  file: string;
  line: number;
  text: string;
};

function findHeadingViolations(filePath: string): HeadingViolation[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const violations: HeadingViolation[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmedStart = line.trimStart();
    const isFence = trimmedStart.startsWith('```') || trimmedStart.startsWith('~~~');

    if (isFence) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      continue;
    }

    if (trimmedStart.startsWith('# ') || trimmedStart.startsWith('## ')) {
      violations.push({ file: filePath, line: i + 1, text: trimmedStart });
    }
  }

  return violations;
}

function main(): void {
  const files = collectMarkdownFiles(ROOT);
  const violations = files.flatMap((file) => findHeadingViolations(file));

  if (violations.length > 0) {
    const details = violations
      .map((violation) => `${violation.file}:${violation.line} ${violation.text}`)
      .join('\n');
    assert.fail(`Found H1/H2 headings in manual prompt files:\n${details}`);
  }

  console.log('man prompt headings test: ok');
}

main();
