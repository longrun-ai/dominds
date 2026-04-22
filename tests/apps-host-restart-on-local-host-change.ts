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
  waitForAppsHostClient,
} from '../main/apps/runtime';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

function buildHostSource(params: {
  version: string;
  initDelayMs?: number;
  initMarkerAbs?: string;
}): string {
  const initDelayMs = params.initDelayMs ?? 0;
  const initMarkerAbs = params.initMarkerAbs ?? null;
  return [
    "import fs from 'node:fs/promises';",
    '',
    'async function delay(ms) {',
    '  if (ms <= 0) return;',
    '  await new Promise((resolve) => setTimeout(resolve, ms));',
    '}',
    '',
    'export async function createDomindsApp() {',
    initMarkerAbs
      ? `  await fs.writeFile(${JSON.stringify(initMarkerAbs)}, 'initializing', 'utf-8');`
      : '  await Promise.resolve();',
    `  await delay(${initDelayMs});`,
    '  return {',
    '    tools: {',
    '      probe_tool: async () => ({',
    '        output: { content: ' + JSON.stringify(params.version) + ", outcome: 'success' },",
    '      }),',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');
}

async function waitForFile(filePathAbs: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePathAbs);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for file: ${filePathAbs}`);
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

    await writeText(path.join(appRootAbs, 'src', 'app.js'), buildHostSource({ version: 'v1' }));

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
        mainDialogId: 'root_1',
        agentId: 'tester',
        taskDocPath: 'task.md',
        callerId: 'tester',
      },
    );
    assert.equal(first.output.content, 'v1');
    assert.equal(first.output.outcome, 'success');

    const initMarkerAbs = path.join(tmpRoot, '.apps', 'probe-host-init.marker');
    await writeText(
      path.join(appRootAbs, 'src', 'app.js'),
      buildHostSource({ version: 'v2', initDelayMs: 250, initMarkerAbs }),
    );
    const refreshPromise = registerEnabledAppsToolProxies({ rtwsRootAbs: tmpRoot });
    await waitForFile(initMarkerAbs, 5_000);
    const duringRefresh = await (
      await waitForAppsHostClient()
    ).callTool(
      'probe_tool',
      {},
      {
        dialogId: 'dlg_1',
        mainDialogId: 'root_1',
        agentId: 'tester',
        taskDocPath: 'task.md',
        callerId: 'tester',
      },
    );
    assert.equal(duringRefresh.output.content, 'v2');
    assert.equal(duringRefresh.output.outcome, 'success');
    await refreshPromise;

    const second = await getAppsHostClient().callTool(
      'probe_tool',
      {},
      {
        dialogId: 'dlg_1',
        mainDialogId: 'root_1',
        agentId: 'tester',
        taskDocPath: 'task.md',
        callerId: 'tester',
      },
    );
    assert.equal(second.output.content, 'v2');
    assert.equal(second.output.outcome, 'success');
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
