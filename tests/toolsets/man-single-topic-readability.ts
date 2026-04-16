#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { MANUAL_SINGLE_REQUEST_CHAR_LIMIT } from '../../main/tools/manual/output-limit';
import { renderToolsetManualContent } from '../../main/tools/toolset-manual';

async function main(): Promise<void> {
  const output = await renderToolsetManualContent({
    toolsetId: 'team_mgmt',
    language: 'zh',
    topic: 'team',
    availableToolNames: new Set<string>(),
  });

  assert.doesNotMatch(output, /手册内容过长|too large/);
  assert.match(output, /\.minds\/team\.yaml/);
  assert.ok(
    output.length <= MANUAL_SINGLE_REQUEST_CHAR_LIMIT,
    `Expected team chapter to stay readable, got ${output.length} chars`,
  );
}

void main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
