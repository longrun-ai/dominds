import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

import { runDomindsAppJsonViaLocalPackage } from '../main/apps/run-app-json';
import {
  getAppsHostClient,
  initAppsRuntime,
  registerEnabledAppsToolProxies,
  shutdownAppsRuntime,
} from '../main/apps/runtime';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

function buildHostSource(version: string): string {
  return [
    'export async function createDomindsAppHost() {',
    '  return {',
    '    tools: {',
    '      probe_tool: async () => ({ output: ' + JSON.stringify(version) + ' }),',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const previousCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-apps-host-restart-'));
  const appRootAbs = path.join(tmpRoot, 'dominds-apps', 'probe-app');

  try {
    process.chdir(tmpRoot);

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
      [
        'apiVersion: dominds.io/v1alpha1',
        'kind: DomindsApp',
        'id: probe_app',
        'contributes:',
        '  teammates:',
        '    teamYaml: .minds/team.yaml',
        '',
      ].join('\n'),
    );

    await writeText(path.join(appRootAbs, '.minds', 'team.yaml'), 'members: {}\n');

    await writeText(
      path.join(appRootAbs, 'bin', 'probe-app.js'),
      [
        '#!/usr/bin/env node',
        'console.log(JSON.stringify({',
        '  schemaVersion: 1,',
        "  appId: 'probe_app',",
        "  displayName: 'Probe App',",
        '  package: {',
        "    name: '@tests/probe-app',",
        "    version: '0.0.1',",
        '    rootAbs: process.cwd(),',
        '  },',
        "  host: { kind: 'node_module', moduleRelPath: './src/app-host.js', exportName: 'createDomindsAppHost' },",
        '  contributes: {',
        '    toolsets: [',
        '      {',
        "        id: 'probe_toolset',",
        "        descriptionI18n: { zh: 'Probe toolset', en: 'Probe toolset' },",
        '        tools: [',
        '          {',
        "            name: 'probe_tool',",
        "            description: 'Probe tool',",
        "            descriptionI18n: { zh: 'Probe tool', en: 'Probe tool' },",
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

    await writeText(path.join(appRootAbs, 'src', 'app-host.js'), buildHostSource('v1'));

    const installJson = await runDomindsAppJsonViaLocalPackage({ packageRootAbs: appRootAbs });

    await writeText(
      path.join(tmpRoot, '.minds', 'app.yaml'),
      [
        'apiVersion: dominds.io/v1alpha1',
        'kind: DomindsApp',
        'id: rtws_root',
        'dependencies:',
        '  - id: probe_app',
        '',
      ].join('\n'),
    );

    await writeText(
      path.join(tmpRoot, '.apps', 'resolution.yaml'),
      YAML.stringify({
        schemaVersion: 1,
        apps: [
          {
            id: 'probe_app',
            enabled: true,
            assignedPort: null,
            source: { kind: 'local', pathAbs: appRootAbs },
            installJson,
          },
        ],
      }),
    );

    await initAppsRuntime({ rtwsRootAbs: tmpRoot, kernel: { host: '127.0.0.1', port: 0 } });
    const first = await getAppsHostClient().callTool(
      'probe_tool',
      {},
      {
        dialogId: 'dlg_1',
        rootDialogId: 'root_1',
        agentId: 'tester',
        callerId: 'tester',
      },
    );
    assert.equal(first.output, 'v1');

    await writeText(path.join(appRootAbs, 'src', 'app-host.js'), buildHostSource('v2'));
    await registerEnabledAppsToolProxies({ rtwsRootAbs: tmpRoot });

    const second = await getAppsHostClient().callTool(
      'probe_tool',
      {},
      {
        dialogId: 'dlg_1',
        rootDialogId: 'root_1',
        agentId: 'tester',
        callerId: 'tester',
      },
    );
    assert.equal(second.output, 'v2');
  } finally {
    await shutdownAppsRuntime();
    process.chdir(previousCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
