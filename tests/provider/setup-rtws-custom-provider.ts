import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildSetupStatusResponse, handleWriteTeamYaml } from '../../main/server/setup-routes';

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-setup-rtws-provider-'));

  try {
    process.chdir(tmpRoot);
    await fs.mkdir(path.join(tmpRoot, '.minds'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, '.minds', 'llm.yaml'),
      [
        'providers:',
        '  custom.example:',
        '    name: Custom Example',
        '    apiType: openai-compatible',
        '    baseUrl: https://custom.example/v1',
        '    apiKeyEnvVar: CUSTOM_EXAMPLE_API_KEY',
        '    models:',
        '      custom-chat:',
        '        name: Custom Chat',
        '',
      ].join('\n'),
      'utf-8',
    );

    const status = await buildSetupStatusResponse();
    assert.equal(status.success, true);
    assert.deepEqual(status.rtwsLlmYaml.providerKeys, ['custom.example']);

    const customProvider = status.providers.find(
      (provider) => provider.providerKey === 'custom.example',
    );
    assert.ok(customProvider, 'custom rtws provider should be present in setup status');
    assert.equal(customProvider.name, 'Custom Example');
    assert.equal(
      status.providers.filter((provider) => !provider.envVar.isSet)[0]?.providerKey,
      'custom.example',
    );

    process.env.CUSTOM_EXAMPLE_API_KEY = 'test-key';
    const statusWithEnv = await buildSetupStatusResponse();
    assert.equal(
      statusWithEnv.providers.filter((provider) => provider.envVar.isSet)[0]?.providerKey,
      'custom.example',
    );

    const writeResult = await handleWriteTeamYaml(
      JSON.stringify({
        provider: 'custom.example',
        model: 'custom-chat',
        overwrite: false,
      }),
    );
    assert.equal(writeResult.kind, 'ok');
  } finally {
    delete process.env.CUSTOM_EXAMPLE_API_KEY;
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
