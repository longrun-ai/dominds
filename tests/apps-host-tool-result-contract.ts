import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startAppsHost } from '../main/apps-host/client';
import { runDomindsAppJsonViaLocalPackage } from '../main/apps/run-app-json';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-apps-host-result-contract-'));
  const appRootAbs = path.join(tmpRoot, 'dominds-apps', 'probe-app');
  let shutdownHost: (() => Promise<void>) | null = null;

  try {
    await writeText(
      path.join(appRootAbs, 'package.json'),
      JSON.stringify(
        {
          name: '@tests/probe-app',
          version: '0.0.1',
          type: 'module',
          bin: {
            'probe-app': './bin/probe-app.js',
          },
          dominds: {
            appManifest: '.minds/app.yaml',
          },
        },
        null,
        2,
      ) + '\n',
    );

    await writeText(
      path.join(appRootAbs, '.minds', 'app.yaml'),
      ['apiVersion: dominds.io/v1alpha1', 'kind: DomindsApp', 'id: probe_app', ''].join('\n'),
    );

    await writeText(path.join(appRootAbs, '.minds', 'team.yaml'), 'members: {}\n');

    await writeText(
      path.join(appRootAbs, 'bin', 'probe-app.js'),
      [
        '#!/usr/bin/env node',
        'console.log(JSON.stringify({',
        "  appId: 'probe_app',",
        "  displayName: 'Probe App',",
        '  package: {',
        "    name: '@tests/probe-app',",
        "    version: '0.0.1',",
        '    rootAbs: process.cwd(),',
        '  },',
        "  host: { kind: 'node_module', moduleRelPath: './src/app.js', exportName: 'createDomindsApp' },",
        '  contributes: {',
        '    toolsets: [',
        '      {',
        "        id: 'probe_toolset',",
        "        descriptionI18n: { zh: 'Probe toolset', en: 'Probe toolset' },",
        '        tools: [',
        '          {',
        "            name: 'modern_tool',",
        "            description: 'Modern tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'legacy_bare_tool',",
        "            description: 'Legacy bare tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'legacy_output_tool',",
        "            description: 'Legacy output tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '        ],',
        '      },',
        '    ],',
        '  },',
        '}));',
        '',
      ].join('\n'),
    );

    await writeText(
      path.join(appRootAbs, 'src', 'app.js'),
      [
        'export async function createDomindsApp() {',
        '  return {',
        '    tools: {',
        '      modern_tool: async () => ({',
        "        output: { content: 'modern ok', outcome: 'success' },",
        '      }),',
        "      legacy_bare_tool: async () => 'legacy bare string',",
        "      legacy_output_tool: async () => ({ output: 'legacy wrapped string' }),",
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    );

    const installJson = await runDomindsAppJsonViaLocalPackage({ packageRootAbs: appRootAbs });
    const started = await startAppsHost({
      rtwsRootAbs: tmpRoot,
      kernel: { host: '127.0.0.1', port: 0 },
      apps: [
        {
          appId: installJson.appId,
          runtimePort: null,
          installJson,
          hostSourceVersion: null,
        },
      ],
    });
    shutdownHost = started.client.shutdown;

    const ctx = {
      dialogId: 'dlg_1',
      mainDialogId: 'root_1',
      agentId: 'tester',
      taskDocPath: 'task.md',
      callerId: 'tester',
    } as const;

    const modern = await started.client.callTool('modern_tool', {}, ctx);
    assert.equal(modern.output.content, 'modern ok');
    assert.equal(modern.output.outcome, 'success');

    await assert.rejects(
      async () => await started.client.callTool('legacy_bare_tool', {}, ctx),
      /Invalid app tool result: expected \{ output: \{ content, outcome, contentItems\? \}, \.\.\. \}/,
    );
    await assert.rejects(
      async () => await started.client.callTool('legacy_output_tool', {}, ctx),
      /Invalid app tool result: output must be \{ content, outcome, contentItems\? \}/,
    );
  } finally {
    if (shutdownHost) {
      await shutdownHost();
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
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
