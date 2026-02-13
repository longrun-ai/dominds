#!/usr/bin/env tsx

import 'dominds/tools/builtins';

import { setWorkLanguage } from 'dominds/shared/runtime-language';
import { Team } from 'dominds/team';
import { buildToolsetManualTools } from 'dominds/tools/toolset-manual';
import assert from 'node:assert/strict';

function createManTool() {
  const built = buildToolsetManualTools({ toolsetNames: [], existingToolNames: new Set<string>() });
  const tool = built.tools.find((t) => t.name === 'man');
  assert.ok(tool, 'man tool should be created');
  return tool;
}

type HeadingIssue = {
  line: number;
  text: string;
  reason: string;
};

function findHeadingIssues(content: string): HeadingIssue[] {
  const lines = content.split('\n');
  const issues: HeadingIssue[] = [];
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
      issues.push({ line: i + 1, text: trimmedStart, reason: 'h1-h2' });
      continue;
    }

    const headingMatch = /^(#{3,6})\s+(.+)$/.exec(trimmedStart);
    if (!headingMatch) {
      continue;
    }

    const title = headingMatch[2] ?? '';
    if (title.toLowerCase().startsWith('template') || title.startsWith('模板')) {
      issues.push({ line: i + 1, text: trimmedStart, reason: 'template' });
    }
  }

  return issues;
}

async function main(): Promise<void> {
  setWorkLanguage('en');
  const manTool = createManTool();
  const caller = new Team.Member({
    id: 'tester',
    name: 'Tester',
    toolsets: ['ws_read'],
  });

  const output = await manTool.call({} as never, caller, {
    toolsetId: 'ws_read',
    topic: 'all',
  });

  assert.ok(output.includes('**Toolset manual: ws_read**'));
  assert.ok(output.includes('### Overview'));
  assert.ok(output.includes('### Principles'));
  assert.ok(output.includes('### Tools'));
  assert.ok(output.includes('### Scenarios'));
  assert.ok(output.includes('### Error Handling'));
  assert.ok(output.includes('#### Tool Contract (Schema)'));
  assert.ok(!output.includes('Missing manual sections'));
  assert.ok(output.includes('##### `list_dir`'));
  assert.ok(output.includes('Call the function tool `list_dir` with:'));

  const headingIssues = findHeadingIssues(output);
  if (headingIssues.length > 0) {
    const details = headingIssues
      .map((issue) => `${issue.line}:${issue.reason}:${issue.text}`)
      .join('\n');
    assert.fail(`Manual output contains invalid headings:\n${details}`);
  }

  console.log('man structure test: ok');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`man structure test: failed: ${message}`);
  process.exit(1);
});
