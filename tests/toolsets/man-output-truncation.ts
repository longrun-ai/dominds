#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { renderToolsetManualContent } from '../../main/tools/toolset-manual';

async function main(): Promise<void> {
  const output = await renderToolsetManualContent({
    toolsetId: 'team_mgmt',
    language: 'en',
    topics: ['team'],
    availableToolNames: new Set<string>(),
  });

  assert.match(output, /too large|过长/);
  assert.match(output, /topic|topics/);
  assert.ok(output.length <= 8_000, `Expected bounded output, got ${output.length} chars`);
}

void main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
