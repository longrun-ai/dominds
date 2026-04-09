#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Dialog } from '../../main/dialog';
import { teamMgmtListProvidersTool } from '../../main/tools/team_mgmt';

function buildProviderYaml(providerCount: number, modelCount: number): string {
  const lines: string[] = ['providers:'];
  for (let p = 1; p <= providerCount; p++) {
    const providerKey = `provider_${String(p).padStart(3, '0')}`;
    lines.push(`  ${providerKey}:`);
    lines.push(`    name: "${providerKey}"`);
    lines.push('    apiType: "openai"');
    lines.push('    baseUrl: "https://example.invalid/v1"');
    lines.push(`    apiKeyEnvVar: "${providerKey.toUpperCase()}_KEY"`);
    lines.push('    models:');
    for (let m = 1; m <= modelCount; m++) {
      const modelKey = `model_${String(m).padStart(3, '0')}`;
      lines.push(`      ${modelKey}: { name: "${providerKey}-${modelKey}" }`);
    }
  }
  return lines.join('\n') + '\n';
}

async function main(): Promise<void> {
  const originalCwd = process.cwd();
  const tmpRtws = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-team-mgmt-output-'));

  try {
    await fs.mkdir(path.join(tmpRtws, '.minds'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRtws, '.minds', 'llm.yaml'),
      buildProviderYaml(240, 20),
      'utf8',
    );
    process.chdir(tmpRtws);

    const output = await teamMgmtListProvidersTool.call({} as unknown as Dialog, {} as never, {
      include_builtin: false,
      include_rtws: true,
      show_models: true,
      max_models: 20,
    });

    assert.match(output.content, /omitted .*additional provider\(s\)|其余 .* 个 provider 未展示/);
    assert.ok(
      output.content.length <= 60_000,
      `Expected bounded output, got ${output.content.length} chars`,
    );
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tmpRtws, { recursive: true, force: true });
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
