import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

import { shutdownAppsRuntime } from '../main/apps/runtime';
import { stopMcpSupervisor } from '../main/mcp/supervisor';
import { startServer } from '../main/server';
import '../main/tools/builtins';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function main(): Promise<void> {
  const previousCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'dominds-apps-webui-startup-host-failure-no-interrupt-'),
  );

  try {
    process.chdir(tmpRoot);

    await writeText(
      path.join(tmpRoot, '.minds', 'llm.yaml'),
      [
        'providers:',
        '  stub:',
        '    name: Stub',
        '    apiType: openai',
        '    baseUrl: https://example.invalid',
        '    apiKeyEnvVar: STUB_API_KEY',
        '    models:',
        '      fake_model: { name: "fake-model" }',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: stub',
        '  model: fake_model',
        'members:',
        '  tester:',
        '    name: Tester',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(tmpRoot, '.apps', 'resolution.yaml'),
      YAML.stringify({
        schemaVersion: 1,
        apps: [
          {
            id: '@longrun-ai/broken-web-dev',
            enabled: true,
            assignedPort: 43123,
            source: {
              kind: 'local',
              pathAbs: path.join(tmpRoot, 'dominds-apps', 'broken-web-dev'),
            },
            installJson: {
              appId: '@longrun-ai/broken-web-dev',
              package: {
                name: '@longrun-ai/broken-web-dev',
                version: '0.1.0',
                rootAbs: path.join(tmpRoot, 'dominds-apps', 'broken-web-dev'),
              },
              host: {
                kind: 'node_module',
                moduleRelPath: './src/app.js',
                exportName: 'createDomindsApp',
              },
              contributes: {},
            },
          },
        ],
      }),
    );

    const started = await startServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'prod',
      startBackendDriver: false,
    });
    try {
      assert.equal(started.host, '127.0.0.1');
      assert.equal(started.mode, 'prod');
    } finally {
      await started.httpServer.stop();
      await shutdownAppsRuntime();
      stopMcpSupervisor();
    }
  } finally {
    process.chdir(previousCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
