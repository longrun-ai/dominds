import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

import { loadAppsResolutionFile } from '../main/apps/resolution-file';
import { shutdownAppsRuntime } from '../main/apps/runtime';
import { stopMcpSupervisor } from '../main/mcp/supervisor';
import { startServer } from '../main/server';
import '../main/tools/builtins';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function canonicalPath(pathAbs: string): Promise<string> {
  try {
    return await fs.realpath(pathAbs);
  } catch {
    return path.resolve(pathAbs);
  }
}

async function main(): Promise<void> {
  const previousCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-apps-webui-self-heal-'));
  const appId = '@longrun-ai/web-dev';
  const localAppRel = path.join('dominds-apps', '@longrun-ai', 'web-dev');
  const localAppAbs = path.join(tmpRoot, localAppRel);

  try {
    process.chdir(tmpRoot);

    await writeText(
      path.join(tmpRoot, '.minds', 'app.yaml'),
      [
        'apiVersion: dominds.io/v1alpha1',
        'kind: DomindsApp',
        'id: rtws_root',
        'dependencies:',
        `  - id: ${JSON.stringify(appId)}`,
        '',
      ].join('\n'),
    );
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
        'default_responder: web_tester_from_app',
        'members:',
        '  web_tester_from_app:',
        `    from: ${JSON.stringify(appId)}`,
        '    use: web_tester',
        '',
      ].join('\n'),
    );
    await writeText(path.join(tmpRoot, '.apps', 'configuration.yaml'), 'schemaVersion: 1\n');
    await writeText(
      path.join(tmpRoot, '.apps', 'resolution.yaml'),
      YAML.stringify({ schemaVersion: 1, apps: [] }),
    );

    await writeText(
      path.join(localAppAbs, 'package.json'),
      JSON.stringify(
        {
          name: '@longrun-ai/web-dev',
          version: '0.1.0',
          type: 'module',
          bin: 'bin.js',
          dominds: { appManifest: '.minds/app.yaml' },
        },
        null,
        2,
      ),
    );
    await writeText(
      path.join(localAppAbs, '.minds', 'app.yaml'),
      [
        'apiVersion: dominds.io/v1alpha1',
        'kind: DomindsApp',
        `id: ${JSON.stringify(appId)}`,
        'contributes:',
        '  teammates:',
        '    teamYaml: .minds/team.yaml',
        '  tools:',
        '    module: ./src/app.js',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(localAppAbs, '.minds', 'team.yaml'),
      [
        'members:',
        '  web_tester:',
        '    name: Web Tester',
        '    toolsets:',
        '      - ws_read',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(localAppAbs, 'bin.js'),
      [
        '#!/usr/bin/env node',
        "if (!process.argv.includes('--dominds-app')) throw new Error('expected --dominds-app');",
        'process.stdout.write(JSON.stringify({',
        '  schemaVersion: 1,',
        `  appId: ${JSON.stringify(appId)},`,
        "  displayName: 'Web Dev',",
        '  package: {',
        "    name: '@longrun-ai/web-dev',",
        "    version: '0.1.0',",
        '    rootAbs: process.cwd(),',
        '  },',
        "  host: { kind: 'node_module', moduleRelPath: './src/app.js', exportName: 'createDomindsApp' },",
        "  contributes: { teammatesYamlRelPath: '.minds/team.yaml' }",
        '}));',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(localAppAbs, 'src', 'app.js'),
      [
        'export async function createDomindsApp() {',
        '  return {',
        '    tools: {},',
        '  };',
        '}',
        '',
      ].join('\n'),
    );

    const started = await startServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'prod',
      startBackendDriver: false,
    });
    try {
      const resolutionLoaded = await loadAppsResolutionFile({ rtwsRootAbs: tmpRoot });
      assert.equal(
        resolutionLoaded.kind,
        'ok',
        resolutionLoaded.kind === 'ok' ? 'expected ok' : resolutionLoaded.errorText,
      );
      if (resolutionLoaded.kind !== 'ok') throw new Error(resolutionLoaded.errorText);
      assert.equal(resolutionLoaded.file.apps.length, 1);
      const resolved = resolutionLoaded.file.apps[0] ?? null;
      assert.ok(resolved, 'expected one resolved app entry');
      assert.equal(resolved?.id, appId);
      assert.equal(resolved?.enabled, true);
      assert.equal(resolved?.source.kind, 'local');
      const resolvedSourcePath =
        resolved?.source.kind === 'local' ? await canonicalPath(resolved.source.pathAbs) : null;
      assert.equal(resolvedSourcePath, await canonicalPath(localAppAbs));
      assert.equal(resolved?.assignedPort, null);
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

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
