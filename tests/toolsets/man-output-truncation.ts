#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FuncTool } from '../../main/tool';
import { MANUAL_SINGLE_REQUEST_CHAR_LIMIT } from '../../main/tools/manual/output-limit';
import { buildSchemaToolsSection } from '../../main/tools/manual/schema';
import { registerToolset, setToolsetMeta, unregisterToolset } from '../../main/tools/registry';
import { renderToolsetManualContent } from '../../main/tools/toolset-manual';

const TOOLSET_ID = 'oversized_manual_test';
const TOOL_NAME = 'oversized_manual_test_tool';

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dominds-manual-truncation-'));
  const manualPath = path.join(tmpDir, 'index.md');
  const tool: FuncTool = {
    type: 'func',
    name: TOOL_NAME,
    description: 'Synthetic tool for manual truncation test.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async call() {
      throw new Error('Not implemented');
    },
  };

  try {
    const schemaSection = buildSchemaToolsSection('en', [tool]);
    const fillerLength = MANUAL_SINGLE_REQUEST_CHAR_LIMIT + 2_000;
    const filler = 'A'.repeat(fillerLength);
    const body = ['# Oversized Manual', '', filler, '', '## Tool Schema', '', schemaSection].join(
      '\n',
    );
    fs.writeFileSync(manualPath, body, 'utf8');

    registerToolset(TOOLSET_ID, [tool]);
    setToolsetMeta(TOOLSET_ID, {
      source: 'dominds',
      descriptionI18n: {
        en: 'Synthetic oversized manual test toolset.',
        zh: '用于超长手册测试的合成工具集。',
      },
      manualSpec: {
        topics: ['index'],
        warnOnMissing: true,
        includeSchemaToolsSection: false,
        topicFilesI18n: {
          en: { index: manualPath },
          zh: { index: manualPath },
        },
      },
    });

    const output = await renderToolsetManualContent({
      toolsetId: TOOLSET_ID,
      language: 'en',
      topic: 'index',
      availableToolNames: new Set<string>(),
    });

    assert.match(output, /too large|过长/);
    assert.match(output, /topic|topics/);
    assert.ok(
      output.length <= MANUAL_SINGLE_REQUEST_CHAR_LIMIT,
      `Expected bounded output, got ${output.length} chars`,
    );
  } finally {
    unregisterToolset(TOOLSET_ID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

void main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
